/**
 * COR-1481 — a task record survives the real death of the process that wrote it.
 *
 * A child process (`test/task-record-crash-child.ts`) holds one task-record write for ever
 * and SIGKILLs itself once the durable run has gone past the point the write describes. This
 * test then opens a fresh Bureau over the same storage and asserts what boot recovery made of
 * the record:
 *
 * 1. a task that finished but whose settlement was never written is settled from the durable
 *    state, not left `working` for ever;
 * 2. a task whose admission write never landed left no run going on without a record: the
 *    engine holds no workflow for it, and its context takes the next task, which gets a whole
 *    record and settles when it ends. (`tasks.start` writes the record before anything of the
 *    run starts, so the start itself waits on the lost write.)
 *
 * It spawns a process, so it lives in the `test:slow` lane, each scenario once at module
 * scope off Bun's per-test clock (see `test/hoisted-scenario.ts`).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { stopWhen, createAgent } from '@lostgradient/operative';
import type { Storage } from '@lostgradient/storage';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { unexpectedChildStderr } from './test/child-stderr';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import { createAskingAgent, finishes } from './test/task-record-crash-agent';
import type { Bureau, BureauReviews, BureauInternals, BureauOptions } from './types';
import type { AgentDefinitions } from './agent-catalog';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { awakeTurns, waitUntil } from '@lostgradient/testing/wait-until';

const CHILD = join(import.meta.dir, 'test', 'task-record-crash-child.ts');

/** The Bureau every scenario boots over the dead process's storage. */
function openBureau(storage: Storage, onEvent?: BureauOptions<AgentDefinitions>['onEvent']) {
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
    storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
    // Shutting down while the recovered parked run is still in flight reports it as cut short.
    onDiagnostic: () => undefined,
    ...(onEvent === undefined ? {} : { onEvent }),
  });
}

async function crashScenario(
  mode: 'settlement' | 'admission',
  scope: ScenarioScope,
  verify: (
    bureau: Pick<Bureau, 'tasks'> & {
      readonly reviews: Pick<BureauReviews, 'list' | 'resolve'>;
    } & { readonly internals: Pick<BureauInternals, 'taskRegistry'> },
    runId: string,
  ) => Promise<void>,
  onEvent?: BureauOptions<AgentDefinitions>['onEvent'],
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `corvidae-task-record-crash-${mode}-`));
  const storagePath = join(directory, 'bureau.sqlite');
  const markerPath = join(directory, 'marker.json');
  // The child's store, opened here only once the child is gone.
  const store = createSqliteStorageFixture({ path: storagePath });
  scope.onHang(async () => {
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
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

    const bureau = await openBureau(store.storage, onEvent);
    scope.onHang(() => bureau.shutdown());
    try {
      await bureau.recovery();
      await verify(bureau, runId);
    } finally {
      await bureau.shutdown();
    }
  } finally {
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The task states of a run that is not over. */
const OPEN_STATES: ReadonlySet<string | undefined> = new Set(['working', 'input-required']);

async function taskStatusOf(
  bureau: { readonly internals: Pick<BureauInternals, 'taskRegistry'> },
  runId: string,
) {
  const task = await bureau.internals.taskRegistry.get(runId);
  return task?.status;
}

/** Process 2 recovers the parked task and is disposed; process 3 boots over what it left. */
async function disposedScenario(scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-task-record-crash-disposed-'));
  const storagePath = join(directory, 'bureau.sqlite');
  const markerPath = join(directory, 'marker.json');
  // The child's store, opened here only once the child is gone.
  const store = createSqliteStorageFixture({ path: storagePath });
  scope.onHang(async () => {
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  try {
    const child = spawnWithHangGuard(['bun', CHILD, 'parked', storagePath, markerPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    scope.onHang(() => child.kill());
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    expect(unexpectedChildStderr(stderr)).toBe('');
    const { runId } = JSON.parse(readFileSync(markerPath, 'utf8')) as { runId: string };

    const second = await openBureau(store.storage);
    await second.recovery();
    expect(OPEN_STATES.has(await taskStatusOf(second, runId))).toBe(true);
    // A graceful shutdown leaves a task this process recovered, not started, for the next boot.
    await second.dispose();

    const third = await openBureau(await store.reopen());
    scope.onHang(() => third.shutdown());
    try {
      await third.recovery();
      const durable = await third.tasks.workflow(runId);
      expect(durable?.status).toBe('running');
      expect(OPEN_STATES.has(await taskStatusOf(third, runId))).toBe(true);
      expect(third.reviews.list().some((review) => review.runId === runId)).toBe(true);
      await third.internals.taskRegistry.cancel(runId, 0);
      await waitUntil(async () => (await taskStatusOf(third, runId)) === 'canceled', {
        message: 'the interrupted task can still be canceled',
      });
    } finally {
      await third.shutdown();
    }
  } finally {
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

const outcomes = {
  disposed: await settleScenario((scope) => disposedScenario(scope), HANG_GUARD_MILLISECONDS),
  settlement: await settleScenario((scope) => {
    const settledEvents: string[] = [];
    return crashScenario(
      'settlement',
      scope,
      async (bureau, runId) => {
        const task = await bureau.internals.taskRegistry.get(runId);
        expect(task).toMatchObject({ id: runId, owner: 'api-key:alice', status: 'completed' });
        expect(settledEvents).toEqual([runId]);
      },
      (event) => {
        if (event.type === 'run.settled') {
          settledEvents.push((event as unknown as { readonly runId: string }).runId);
        }
      },
    );
  }, HANG_GUARD_MILLISECONDS),
  admission: await settleScenario(
    (scope) =>
      crashScenario('admission', scope, async (bureau, lostId) => {
        // No run went on without its record: the lost task has neither.
        expect(await bureau.internals.taskRegistry.get(lostId)).toBeUndefined();
        expect(await bureau.tasks.workflow(lostId)).toBeNull();

        const task = await bureau.tasks.start('asker', 'which environment?', {
          principal: 'api-key:alice',
          contextId: 'crash-context',
        });
        const runId = task.id;
        const recorded = await bureau.internals.taskRegistry.get(runId);
        // The context the start named, not the run's own id.
        expect(recorded).toMatchObject({
          id: runId,
          owner: 'api-key:alice',
          agentName: 'asker',
          contextId: 'crash-context',
        });
        const inContext = await bureau.internals.taskRegistry.enumerate({
          contextId: 'crash-context',
          limit: 10,
          offset: 0,
        });
        expect(inContext.tasks.map((listed) => listed.id)).toEqual([runId]);
        const history = await bureau.internals.taskRegistry.history(runId);
        expect(history?.map((message) => message.text)).toEqual(['which environment?']);
        let review = bureau.reviews.list().find((candidate) => candidate.runId === runId);
        for await (const _turn of awakeTurns()) {
          if (!(review === undefined)) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
          review = bureau.reviews.list().find((candidate) => candidate.runId === runId);
        }
        expect(review).toBeDefined();
        await bureau.reviews.resolve({
          id: review!.id,
          decision: 'approve',
          principal: 'api-key:alice',
          payload: 'staging',
        });
        await bureau.tasks.wait(runId);
        for await (const _turn of awakeTurns()) {
          const current = await bureau.internals.taskRegistry.get(runId);
          if (current?.status === 'completed') break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const settled = await bureau.internals.taskRegistry.get(runId);
        expect(settled?.status).toBe('completed');
      }),
    HANG_GUARD_MILLISECONDS,
  ),
};

describe('a task record survives SIGKILL', () => {
  it('leaves a recovered task that a graceful shutdown interrupted working and cancelable at the next boot', () => {
    expectScenarioPassed(outcomes.disposed);
  });

  it('settles a finished task whose settlement write was lost', () => {
    expectScenarioPassed(outcomes.settlement);
  });

  it('leaves no run going on without a record when a task’s admission write was lost, and its context takes the next task, which settles', () => {
    expectScenarioPassed(outcomes.admission);
  });
});
