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
 * 2. a durable `bureau.run()` run whose task record was never written has one;
 * 3. a recovered run that a graceful shutdown interrupts is not reported as over: it is still
 *    open (`working` or `input-required`) and cancelable at the boot after, and the engine
 *    still holds it `running`.
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
import { createAskingAgent, finishes } from './test/task-record-crash-agent';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';
import { awakeTurns } from '@lostgradient/testing/wait-until';

const CHILD = join(import.meta.dir, 'test', 'task-record-crash-child.ts');

/** The Bureau every scenario boots over the dead process's storage. */
function openBureau(storagePath: string) {
  return createBureau<AgentDefinitions>({
    id: 'task-record-crash',
    agents: {
      asker: createAskingAgent(),
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

/** The task states of a run that is not over. */
const OPEN_STATES: ReadonlySet<string | undefined> = new Set(['working', 'input-required']);

async function taskStatusOf(bureau: Pick<Bureau, 'tasks'>, runId: string) {
  const task = await bureau.tasks.get(runId);
  return task?.status;
}

/** Process 2 recovers the parked run and is disposed; process 3 boots over what it left. */
async function disposedScenario(scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-task-record-crash-disposed-'));
  const storagePath = join(directory, 'bureau.sqlite');
  const markerPath = join(directory, 'marker.json');
  scope.onHang(() => rmSync(directory, { recursive: true, force: true }));
  try {
    const child = spawnWithHangGuard(['bun', CHILD, 'admission', storagePath, markerPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    scope.onHang(() => child.kill());
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    const { runId } = JSON.parse(readFileSync(markerPath, 'utf8')) as { runId: string };

    const second = await openBureau(storagePath);
    await second.waitForRecovery?.();
    expect(OPEN_STATES.has(await taskStatusOf(second, runId))).toBe(true);
    // Disposing the engine rejects the recovered run's result: the run is cut short, not over.
    await second.dispose();

    const third = await openBureau(storagePath);
    scope.onHang(() => third.shutdown());
    try {
      await third.waitForRecovery?.();
      const durable = await third.getDurableRun(runId);
      expect(durable?.status).toBe('running');
      expect(OPEN_STATES.has(await taskStatusOf(third, runId))).toBe(true);
      await third.tasks.cancel(runId, 0);
      for await (const _turn of awakeTurns()) {
        if ((await taskStatusOf(third, runId)) === 'canceled') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await taskStatusOf(third, runId)).toBe('canceled');
    } finally {
      await third.shutdown();
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
        // The context the dispatch named, not the run's own id.
        expect(task).toMatchObject({
          id: runId,
          owner: 'api-key:alice',
          agentName: 'asker',
          contextId: 'crash-context',
        });
        const inContext = await bureau.tasks.enumerate({
          contextId: 'crash-context',
          limit: 10,
          offset: 0,
        });
        expect(inContext.tasks.map((listed) => listed.id)).toEqual([runId]);
        const history = await bureau.tasks.history(runId);
        expect(history?.map((message) => message.text)).toEqual(['which environment?']);
        // The run was in flight across the crash, and it ends in this process: its task settles.
        let review = bureau.listPendingReviews().find((candidate) => candidate.runId === runId);
        for await (const _turn of awakeTurns()) {
          if (!(review === undefined)) break;
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
        for await (const _turn of awakeTurns()) {
          const current = await bureau.tasks.get(runId);
          if (current?.status === 'completed') break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const settled = await bureau.tasks.get(runId);
        expect(settled?.status).toBe('completed');
      }),
    HANG_GUARD_MILLISECONDS,
  ),
  disposed: await settleScenario((scope) => disposedScenario(scope), HANG_GUARD_MILLISECONDS),
};

describe('a task record survives SIGKILL', () => {
  it('settles a finished session run whose settlement write was lost', () => {
    expectScenarioPassed(outcomes.settlement);
  });

  it('gives a durable bureau.run() run whose admission write was lost a task record, which settles when the run ends', () => {
    expectScenarioPassed(outcomes.admission);
  });

  it('leaves a recovered run that a graceful shutdown interrupted working and cancelable at the next boot', () => {
    expectScenarioPassed(outcomes.disposed);
  });
});
