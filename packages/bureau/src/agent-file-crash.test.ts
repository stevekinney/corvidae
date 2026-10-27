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

import { createDefaultRuntimeServices, createManualRuntimeServices } from '@lostgradient/lifecycle';
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
import type { AgentDefinitions } from './agent-catalog';
import { agentFileDirectory } from './sources/agent-file-directory';

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
    await scope.phase('child exit', () => child.exited);
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
    await scope.phase(
      'claim lapse',
      () => new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10)),
    );

    const calls: Call[] = [];
    bureau = await scope.phase('boot', () =>
      createBureau<AgentDefinitions>({
        agents: {},
        // The tool catalog is the deployment's, so it is the same after the restart.
        agentSource: agentFileDirectory(agents, { tools: { 'lookup-order': lookupTool } }),
        models: {
          generate:
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
        },
        storage: { type: 'sqlite', path: storagePath },
        durable: true,
        // A session run is also offered `scheduleWakeup`; the snapshot assertion is one tool set.
        wakeup: false,
        durableOwnership: {
          ownership: 'workflow-lease',
          workflowClaimTtlMs: CLAIM_TTL_MS,
          workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
        },
      }),
    );
    // The file for `gone` is gone, and `edited` now names a model and no tools.
    expect(bureau.agents.list().map((listing) => listing.id)).toEqual(['edited']);

    const recovering = bureau;
    const report = await scope.phase('recovery', async () => recovering.recovery());
    expect(report.perRunFailures).toEqual([]);
    expect(report.outcome).toBe('clean');

    for (const run of marker.runs) {
      const ended = await scope.phase(
        `durable run ${run.kind} ${run.name} ${run.runId}`,
        async () => {
          scope.observe(async () => {
            const state = await recovering.tasks.workflow(run.runId);
            return `durable status ${JSON.stringify(state?.status)}`;
          });
          return recovering.tasks.wait(run.runId);
        },
      );
      // `waitForDurableRun` resolves for a run that failed too, so a run the engine ended before
      // the Bureau could resume it (COR-1592) is named here, with the engine's own error, rather
      // than surfacing as a wait that never ends.
      expect({ status: ended?.status, error: ended?.error }).toEqual({
        status: 'completed',
        error: undefined,
      });
    }
    await scope.phase('run status', () =>
      waitForBureauState(
        [recovering],
        () =>
          marker.runs.every(
            (run) =>
              run.kind === 'catalog' || recovering.tasks.detail(run.runId)?.status === 'completed',
          ),
        {
          scope,
          label: 'every session run is completed in the bureau',
          describe: async () => {
            const sessions = marker.runs
              .filter((run) => run.kind === 'session')
              .map(
                (run) => `${run.name} ${run.runId}: ${recovering.tasks.detail(run.runId)?.status}`,
              );
            const durable = await Promise.all(
              marker.runs.map(async (run) => {
                const state = await recovering.tasks.workflow(run.runId);
                return `${run.kind} ${run.name} ${run.runId}: ${state?.status}${
                  state?.error === undefined ? '' : ` (${state.error})`
                }`;
              }),
            );
            return `bureau ${sessions.join(', ')}; durable ${durable.join(', ')}`;
          },
        },
      ),
    );
    for (const run of marker.runs) {
      const durable = await bureau.tasks.workflow(run.runId);
      expect(durable?.status).toBe('completed');
    }

    // Every resumed run called the model and had the tools its snapshot recorded. Step 0 did not
    // run again, and the rewritten file's model was never called.
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.model).toBe('claude-opus-5-5');
      expect(call.tools).toEqual(['decide', 'lookup-order', 'requestHumanInput']);
    }

    // Retention: every one of those runs, a recovered `bureau.run` run included, had its snapshot
    // reference settled when it ended, so a maintenance pass a year on prunes all of their
    // snapshots. Either mechanism may have settled it, and this test does not tell them apart:
    // recovery's own settlement when the run ended, or else the pass's reconciliation against
    // the engine, which runs ahead of the prune. The run is in no store, so the store's own
    // settlement cannot have.
    const recoveredShutdown = await scope.phase('shutdown', () => recovering.shutdown());
    expect(recoveredShutdown.unresolved).toBe(0);
    await scope.phase('maintenance', async () => {
      const yearOn = createManualRuntimeServices({
        origin: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString(),
      });
      bureau = await createBureau<AgentDefinitions>({
        agents: {},
        agentSource: agentFileDirectory(agents, { tools: { 'lookup-order': lookupTool } }),
        models: { generate: () => async () => ({ content: 'unused', toolCalls: [] }) },
        storage: { type: 'sqlite', path: storagePath },
        durable: true,
        // A session run is also offered `scheduleWakeup`; the snapshot assertion is one tool set.
        wakeup: false,
        durableOwnership: { ownership: 'none' },
        maintenance: 'manual',
        runtime: yearOn,
      });
      const before = await Promise.all([
        bureau.agents.revisions('gone'),
        bureau.agents.revisions('edited'),
      ]);
      expect(before.map((revisions) => revisions.length)).toEqual([1, 1]);
      await bureau.maintain();
      const after = await Promise.all([
        bureau.agents.revisions('gone'),
        bureau.agents.revisions('edited'),
      ]);
      expect(after.map((revisions) => revisions.length)).toEqual([0, 0]);
    });
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
