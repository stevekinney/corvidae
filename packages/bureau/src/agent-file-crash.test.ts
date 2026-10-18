/**
 * COR-1524 — a run of a file agent that crashes with the process resumes from its snapshot, even
 * after the file was deleted or rewritten. A child process starts four runs (a `bureau.run` run and
 * a session run of each of two agents), parks them after step 0, and is killed with SIGKILL. The
 * parent deletes one agent's file and rewrites the other's with a different model, instructions,
 * and tools, then boots a Bureau over the child's store: every run must resume as the file it began
 * as. The scenario boots real processes and waits out a real claim lapse, so it runs once at module
 * scope (`test/hoisted-scenario.ts`) and its test reports how it went.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { stopWhen } from '@lostgradient/operative';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import {
  expectScenarioPassed,
  type ScenarioScope,
  settleScenario,
  waitForBureauState,
} from './test/hoisted-scenario';
import { CLAIM_RENEW_MS, CLAIM_TTL_MS } from './test/process-crash-work-integrity-fixtures';
import { unexpectedChildStderr } from './test/child-stderr';
import {
  agentFileText,
  KNOWN_MODEL,
  lookupTool,
  OTHER_MODEL,
} from './testing/agent-file-fixtures.test-support';
import type { Bureau } from './types';

const CHILD = join(import.meta.dir, 'test', 'agent-file-crash-child.ts');
const runtime = createDefaultRuntimeServices();
const HANG_GUARD_MILLISECONDS = 180_000;

interface CrashMarker {
  readonly runs: ReadonlyArray<{ name: string; kind: 'catalog' | 'session'; runId: string }>;
}

interface Call {
  readonly model: string;
  readonly tools: readonly string[];
}

async function crashScenario(scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-agent-file-crash-'));
  const agents = join(directory, 'agents');
  mkdirSync(agents);
  const markerPath = join(directory, 'marker.json');
  const storagePath = join(directory, 'bureau');
  let bureau: Bureau | undefined;
  scope.onHang(async () => {
    await bureau?.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });

  try {
    writeFileSync(
      join(agents, 'gone.md'),
      agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order]' }, 'Original gone.\n'),
    );
    writeFileSync(
      join(agents, 'edited.md'),
      agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order]' }, 'Original edited.\n'),
    );
    const child = spawnWithHangGuard(['bun', CHILD, storagePath, agents, markerPath], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    scope.onHang(() => child.kill('SIGKILL'));
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(child.signalCode ?? unexpectedChildStderr(stderr)).toBe('SIGKILL');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as CrashMarker;
    expect(marker.runs).toHaveLength(4);

    // What a human does while the process is down: delete one agent, rewrite the other.
    rmSync(join(agents, 'gone.md'));
    writeFileSync(
      join(agents, 'edited.md'),
      agentFileText({ model: OTHER_MODEL }, 'Rewritten edited.\n'),
    );
    // The dead holder's claim lapses on Weft's own wall clock.
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));

    const calls: Call[] = [];
    bureau = await createBureau({
      agents: {},
      agentDirectory: agents,
      // The tool catalog is the deployment's, so it is the same after the restart.
      agentTools: { 'lookup-order': lookupTool },
      resolveAgentGenerate:
        (descriptor) =>
        async ({ toolbox }) => {
          calls.push({
            model: descriptor.model,
            tools: toolbox
              .tools()
              .map((tool) => tool.name)
              .toSorted(),
          });
          return { content: 'resumed', toolCalls: [] };
        },
      stopWhen: stopWhen.noToolCalls(),
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
      durableOwnership: {
        ownership: 'workflow-lease',
        workflowClaimTtlMs: CLAIM_TTL_MS,
        workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
      },
    });
    // The file for `gone` is gone, and `edited` now names a model and no tools.
    expect(bureau.agents.list().map((listing) => listing.id)).toEqual(['edited']);

    const report = await bureau.waitForRecovery?.();
    if (report === undefined) throw new Error('waitForRecovery is unavailable');
    expect(report.perRunFailures).toEqual([]);
    expect(report.outcome).toBe('clean');

    for (const run of marker.runs) await bureau.waitForDurableRun(run.runId);
    await waitForBureauState([bureau], () =>
      marker.runs.every(
        (run) => run.kind === 'catalog' || bureau?.getRun(run.runId)?.status === 'completed',
      ),
    );
    for (const run of marker.runs) {
      const durable = await bureau.getDurableRun(run.runId);
      expect(durable?.status).toBe('completed');
    }

    // Every resumed run called the model and had the tools its snapshot recorded. Step 0 did not
    // run again, and the rewritten file's model was never called.
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.model).toBe('claude-opus-5-5');
      expect(call.tools).toEqual(['lookup-order']);
    }
  } finally {
    const shutdown = await bureau?.shutdown();
    rmSync(directory, { recursive: true, force: true });
    if (shutdown !== undefined) expect(shutdown.unresolved).toBe(0);
  }
}

const crashOutcome = await settleScenario(crashScenario, HANG_GUARD_MILLISECONDS);

describe('a file agent run killed with its process', () => {
  it('resumes from its snapshot after the file was deleted or rewritten', () => {
    expectScenarioPassed(crashOutcome);
  });
});
