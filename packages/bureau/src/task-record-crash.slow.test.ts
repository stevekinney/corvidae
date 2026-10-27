/**
 * COR-1481 — a task record survives the real death of the process that wrote it.
 *
 * A child process (`test/task-record-crash-child.ts`) holds one task-record write for ever
 * and SIGKILLs itself once the durable run has gone past the point the write describes. This
 * test then opens a fresh Bureau over the same storage and asserts what boot recovery made of
 * the record:
 *
 * A task that finished but whose settlement was never written is settled from the durable
 * state, not left `working` for ever. (A task's record is written before its run starts, so no
 * run goes on without one; and a recovered task is held by the run store, so a graceful
 * shutdown cancels it as it does any task.)
 *
 * It spawns a process, so it lives in the `test:slow` lane, each scenario once at module
 * scope off Bun's per-test clock (see `test/hoisted-scenario.ts`).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { stopWhen, createAgent } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { unexpectedChildStderr } from './test/child-stderr';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import { finishes } from './test/task-record-crash-agent';
import type { Bureau, BureauReviews, BureauInternals } from './types';
import type { AgentDefinitions } from './agent-catalog';

const CHILD = join(import.meta.dir, 'test', 'task-record-crash-child.ts');

/** The Bureau every scenario boots over the dead process's storage. */
function openBureau(storagePath: string) {
  return createBureau<AgentDefinitions>({
    id: 'task-record-crash',
    agents: {
      default: createAgent({
        generate: finishes,
        toolbox: createToolbox([]),
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      }),
    },
    storage: { type: 'sqlite', path: storagePath },
    durable: true,
    durableOwnership: { ownership: 'none' },
    // Shutting down while the recovered parked run is still in flight reports it as cut short.
    onDiagnostic: () => undefined,
  });
}

async function crashScenario(
  mode: 'settlement',
  scope: ScenarioScope,
  verify: (
    bureau: Pick<Bureau, 'tasks'> & {
      readonly reviews: Pick<BureauReviews, 'list' | 'resolve'>;
    } & { readonly internals: Pick<BureauInternals, 'taskRegistry'> },
    runId: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `corvidae-task-record-crash-${mode}-`));
  const storagePath = join(directory, 'bureau.sqlite');
  const markerPath = join(directory, 'marker.json');
  scope.onHang(() => rmSync(directory, { recursive: true, force: true }));
  try {
    const child = spawnWithHangGuard(['bun', CHILD, mode, storagePath, markerPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    scope.onHang(() => child.kill());
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    expect(unexpectedChildStderr(stderr)).toBe('');
    const { runId } = JSON.parse(readFileSync(markerPath, 'utf8')) as { runId: string };

    const bureau = await openBureau(storagePath);
    scope.onHang(() => bureau.shutdown());
    try {
      await bureau.waitForRecovery?.();
      await verify(bureau, runId);
    } finally {
      await bureau.shutdown();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const outcomes = {
  settlement: await settleScenario(
    (scope) =>
      crashScenario('settlement', scope, async (bureau, runId) => {
        const task = await bureau.internals.taskRegistry.get(runId);
        expect(task).toMatchObject({ id: runId, owner: 'api-key:alice', status: 'completed' });
      }),
    HANG_GUARD_MILLISECONDS,
  ),
};

describe('a task record survives SIGKILL', () => {
  it('settles a finished task whose settlement write was lost', () => {
    expectScenarioPassed(outcomes.settlement);
  });
});
