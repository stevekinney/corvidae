/**
 * COR-1481 — a task record survives the real death of the process that wrote it.
 *
 * A child process (`test/task-record-crash-child.ts`) holds one task-record write for ever
 * and SIGKILLs itself once the durable run has gone past the point the write describes. This
 * test then opens a fresh Bureau over the same storage and asserts what boot recovery made of
 * the record:
 *
 * 1. a session run that finished but whose settlement was never written is settled from the
 *    durable state, not left `working` for ever;
 * 2. a durable `bureau.run()` run whose task record was never written has one.
 *
 * It spawns a process, so it lives in the `test:slow` lane, each scenario once at module
 * scope off Bun's per-test clock (see `test/hoisted-scenario.ts`).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { unexpectedChildStderr } from './test/child-stderr';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import { createAskingAgent, finishes } from './test/task-record-crash-agent';
import type { Bureau } from './types';

const CHILD = join(import.meta.dir, 'test', 'task-record-crash-child.ts');

async function crashScenario(
  mode: 'settlement' | 'admission',
  scope: ScenarioScope,
  verify: (
    bureau: Pick<Bureau, 'tasks' | 'listPendingReviews' | 'resolveReview' | 'waitForDurableRun'>,
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

    const bureau = await createBureau({
      id: 'task-record-crash',
      agents: { asker: createAskingAgent() },
      generate: finishes,
      toolbox: createToolbox([]),
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      durableOwnership: { ownership: 'none' },
      // Shutting down while the recovered parked run is still in flight reports it as cut short.
      onDiagnostic: () => undefined,
    });
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
        const task = await bureau.tasks.get(runId);
        expect(task).toMatchObject({ id: runId, owner: 'api-key:alice', status: 'completed' });
      }),
    HANG_GUARD_MILLISECONDS,
  ),
  admission: await settleScenario(
    (scope) =>
      crashScenario('admission', scope, async (bureau, runId) => {
        const task = await bureau.tasks.get(runId);
        expect(task).toMatchObject({ id: runId, owner: 'api-key:alice', agentName: 'asker' });
        const history = await bureau.tasks.history(runId);
        expect(history?.map((message) => message.text)).toEqual(['which environment?']);
        // The run was in flight across the crash, and it ends in this process: its task settles.
        let review = bureau.listPendingReviews().find((candidate) => candidate.runId === runId);
        for (let attempt = 0; review === undefined && attempt < 400; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          review = bureau.listPendingReviews().find((candidate) => candidate.runId === runId);
        }
        expect(review).toBeDefined();
        await bureau.resolveReview({
          id: review!.id,
          decision: 'approve',
          principal: 'api-key:alice',
          payload: 'staging',
        });
        await bureau.waitForDurableRun(runId);
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const current = await bureau.tasks.get(runId);
          if (current?.status === 'completed') break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const settled = await bureau.tasks.get(runId);
        expect(settled?.status).toBe('completed');
      }),
    HANG_GUARD_MILLISECONDS,
  ),
};

describe('a task record survives SIGKILL', () => {
  it('settles a finished session run whose settlement write was lost', () => {
    expectScenarioPassed(outcomes.settlement);
  });

  it('gives a durable bureau.run() run whose admission write was lost a task record, which settles when the run ends', () => {
    expectScenarioPassed(outcomes.admission);
  });
});
