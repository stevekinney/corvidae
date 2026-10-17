/**
 * Session input admitted before a process dies is delivered, in order and once,
 * by the process that recovers the run (COR-1476).
 *
 * A child process (`test/session-input-crash-child.ts`) admits two inputs while
 * its run is mid-step and SIGKILLs itself, so whatever the recovering process
 * finds was on disk before the child died. Real processes are the behavior under
 * test, so each scenario runs once at module scope, off Bun's per-test clock,
 * under one hang guard (see `test/hoisted-scenario.ts`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopWhen } from '@lostgradient/operative';
import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { SESSION_INPUT_DELIVERIES_METADATA_KEY } from './session-input-promotion';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';

const CHILD = join(import.meta.dir, 'test', 'session-input-crash-child.ts');

/** Matches the child's short workflow claim, so recovery can follow a kill quickly. */
const CLAIM_TTL_MS = 200;
const CLAIM_OPTIONS = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: CLAIM_TTL_MS,
  workflowClaimRenewIntervalMs: 50,
} as const;

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

type Backend = 'sqlite' | 'lmdb';

interface Marker {
  readonly sessionId: string;
  readonly runId: string;
}

async function runCrashingChild(
  scope: ScenarioScope,
  backend: Backend,
  storagePath: string,
  markerPath: string,
): Promise<Marker> {
  const child = spawnWithHangGuard(['bun', CHILD, backend, storagePath, markerPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  scope.onHang(() => child.kill());
  await child.exited;
  const stderr = await new Response(child.stderr).text();
  // The child kills itself, so a clean exit would mean it returned normally
  // instead, which would invalidate the test's premise, not merely fail it.
  expect(child.signalCode ?? stderr).toBe('SIGKILL');
  expect(existsSync(markerPath)).toBe(true);
  return JSON.parse(readFileSync(markerPath, 'utf8')) as Marker;
}

function recoveredScenario(backend: Backend): ReturnType<typeof settleScenario> {
  return settleScenario(async (scope) => {
    const directory = mkdtempSync(join(tmpdir(), `corvidae-session-input-${backend}-`));
    const remove = (): void => rmSync(directory, { recursive: true, force: true });
    scope.onHang(remove);
    try {
      const storagePath = join(directory, backend === 'sqlite' ? 'bureau.sqlite' : 'bureau-lmdb');
      const { sessionId, runId } = await runCrashingChild(
        scope,
        backend,
        storagePath,
        join(directory, 'marker.json'),
      );
      // The killed child's workflow claim must lapse before this process may
      // recover its run; there is no event for that, only its TTL.
      await Bun.sleep(CLAIM_TTL_MS * 10);

      const prompts: { step: number; texts: string[] }[] = [];
      const recovering = await createBureau({
        agents: {},
        generate: async ({ step, conversation }) => {
          prompts.push({
            step,
            texts: conversation
              .getMessages()
              .filter((message) => message.role === 'user')
              .map((message) => (typeof message.content === 'string' ? message.content : '')),
          });
          return { content: 'done', toolCalls: [] };
        },
        toolbox: createToolbox([nextTool]),
        storage: { type: backend, path: storagePath },
        durableExecution: true,
        durableOwnership: CLAIM_OPTIONS,
        stopWhen: stopWhen.noToolCalls(),
      });
      try {
        await recovering.waitForRecovery?.();
        await recovering.waitForDurableRun(runId);
        const session = await recovering.getSession(sessionId);
        const records = session?.metadata[SESSION_INPUT_DELIVERIES_METADATA_KEY];
        const promoted =
          typeof records === 'object' && records !== null && !Array.isArray(records)
            ? Object.values(records).filter(
                (record) =>
                  typeof record === 'object' &&
                  record !== null &&
                  !Array.isArray(record) &&
                  (record as Record<string, unknown>)['promotion'] !== undefined,
              )
            : [];
        // Step 0 was checkpointed by the child, so only step 1 generates again,
        // and it sees each input exactly once, oldest first.
        expect(prompts).toEqual([{ step: 1, texts: ['Start', 'first', 'second'] }]);
        expect(promoted).toHaveLength(2);
      } finally {
        await recovering.dispose();
      }
    } finally {
      remove();
    }
  }, HANG_GUARD_MILLISECONDS);
}

const outcomes = {
  sqlite: await recoveredScenario('sqlite'),
  lmdb: await recoveredScenario('lmdb'),
};

describe.each(['sqlite', 'lmdb'] as const)(
  'session input delivered by the process that recovers the run, on %s (COR-1476)',
  (backend) => {
    it('delivers both inputs, in admission order, once, at the recovered step', () => {
      expectScenarioPassed(outcomes[backend]);
    });
  },
);
