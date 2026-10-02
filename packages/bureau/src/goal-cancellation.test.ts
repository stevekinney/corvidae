/**
 * COR-851 — what `cancel()` answers for, one fresh read at a time.
 *
 * `goals.test.ts` shows a real cancellation end to end. These tests drive
 * `cancelGoal` with a scripted engine so that each thing the read-back waits
 * for can be left unfinished in turn, and the answer is `cancellation-pending`
 * naming exactly that.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { cancelGoal } from './goal-cancellation';
import { commitCancellation, type GoalControlDependencies } from './goal-controller';
import { createGoalState, goalAttemptId, goalAttemptRunId, goalTransitionId } from './goal-state';
import { createGoalStore, type GoalStore } from './goal-store';
import type { GoalEngine } from './goal-types';
import type { BureauDiagnostic } from './types';

const NOW = '2026-10-02T12:00:00.000Z';

async function runningGoal(): Promise<GoalStore> {
  const store = createGoalStore(textValueStore(new MemoryStorage()));
  await store.create(
    createGoalState({
      goalRunId: 'g1',
      identity: { name: 'goal', version: '1' },
      objective: { agentName: 'worker', prompt: 'work' },
      validator: { name: 'check', version: '1' },
      conversationPolicy: { kind: 'continue' },
      bounds: { maximumAttempts: 2, maximumTotalSteps: 10 },
      now: NOW,
    }),
  );
  const attemptId = goalAttemptId('g1', 0);
  const runId = goalAttemptRunId('g1', 0);
  await store.applyTransition({
    goalRunId: 'g1',
    seq: 1,
    transitionId: goalTransitionId('g1', 1),
    to: 'running',
    at: NOW,
    cause: 'attempt 0 started',
    attempt: {
      attemptId,
      attemptIndex: 0,
      runId,
      sessionId: runId,
      startedAt: NOW,
      usage: { steps: 0, tokens: 0 },
      status: 'running',
    },
    usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
    active: { kind: 'attempt', attemptId, runId, startedAt: NOW },
  });
  return store;
}

interface Script {
  /** Statuses `engine.get` answers, by workflow id. A missing key is `null`. */
  readonly workflows: Record<string, string>;
  readonly finalizer?: { status: string } | null;
  /** Runs inside `engine.cancel`, before it settles. */
  readonly onCancel?: () => Promise<void>;
  readonly cancelThrows?: boolean;
}

function scriptedEngine(script: Script) {
  const calls: string[] = [];
  const engine = {
    get: (id: string) => {
      const status = script.workflows[id];
      return Promise.resolve(status === undefined ? null : { id, status });
    },
    signal: (id: string, name: string) => {
      calls.push(`signal:${id}:${name}`);
      return Promise.resolve();
    },
    cancel: async (id: string) => {
      calls.push(`cancel:${id}`);
      await script.onCancel?.();
      if (script.cancelThrows === true) throw new Error('engine unavailable');
    },
    getFinalizerStatus: () => Promise.resolve(script.finalizer ?? null),
  } as unknown as GoalEngine;
  return { engine, calls };
}

function dependencies(
  store: GoalStore,
  engine: GoalEngine,
  extra: Partial<GoalControlDependencies> = {},
) {
  const diagnostics: BureauDiagnostic[] = [];
  const stopped: string[] = [];
  const control: GoalControlDependencies = {
    store,
    clock: { now: () => Date.parse(NOW), nowISO: () => NOW },
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
    getEngine: () => engine,
    cancelRun: (runId) => {
      stopped.push(runId);
      return Promise.resolve({ status: 'requested' });
    },
    forwarder: {
      watch: () => {},
      reconcile: () => Promise.resolve('not-needed'),
      drain: () => Promise.resolve(),
    },
    startAttempt: () => Promise.reject(new Error('never starts an attempt')),
    isClosing: () => false,
    ...extra,
  };
  return { control, diagnostics, stopped };
}

const settled = { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' };

async function cancelWith(script: Script, extra: Partial<GoalControlDependencies> = {}) {
  const store = await runningGoal();
  const { engine, calls } = scriptedEngine(script);
  const { control, diagnostics, stopped } = dependencies(store, engine, extra);
  const record = (await store.get('g1'))!;
  const outcome = await cancelGoal(control, record, { principal: 'alice', reason: 'stop' });
  return { outcome, calls, diagnostics, stopped, store };
}

describe('cancelGoal', () => {
  it('answers canceled only when the record, the controller, the finalizer, and the attempt are all terminal', async () => {
    const { outcome, calls, stopped } = await cancelWith({ workflows: settled });

    expect(outcome).toMatchObject({ outcome: 'canceled', goal: { status: 'canceled' } });
    // Signal first, then the durable cancel, then the attempt's run is stopped.
    expect(calls).toEqual(['signal:goal:g1:cancel', 'cancel:goal:g1']);
    expect(stopped).toEqual(['goal-g1-a0']);
  });

  it('is pending on the controller while its workflow has not reached a terminal status', async () => {
    const { outcome, store } = await cancelWith({
      workflows: { ...settled, 'goal:g1': 'running' },
      cancelThrows: true,
    });

    expect(outcome).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['controller'] });
    // The marker is durable and the host committed the goal's end regardless.
    const goal = await store.get('g1');
    expect(goal).toMatchObject({
      status: 'canceled',
      cancellation: { principal: 'alice', reason: 'stop' },
    });
  });

  it.each([
    { label: 'pending', finalizer: { status: 'pending' } },
    { label: 'running', finalizer: { status: 'running' } },
    { label: 'failed', finalizer: { status: 'failed' } },
  ])('is pending on the finalizer while it is $label', async ({ finalizer }) => {
    const { outcome } = await cancelWith({ workflows: settled, finalizer });

    expect(outcome).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['finalizer'] });
  });

  it('accepts a finalizer that has succeeded', async () => {
    const { outcome } = await cancelWith({
      workflows: settled,
      finalizer: { status: 'succeeded' },
    });

    expect(outcome.outcome).toBe('canceled');
  });

  it('is pending on the attempt while its run has not reached a terminal status, and says why it could not stop it', async () => {
    const { outcome, diagnostics } = await cancelWith(
      { workflows: { ...settled, 'goal-g1-a0': 'running' } },
      { cancelRun: () => Promise.resolve({ status: 'failed', error: new Error('engine busy') }) },
    );

    expect(outcome).toMatchObject({ outcome: 'cancellation-pending', awaiting: ['attempt-run'] });
    expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain('engine busy');
  });

  it('names everything that is unfinished, not only the first', async () => {
    const { outcome } = await cancelWith({
      workflows: { 'goal:g1': 'running', 'goal-g1-a0': 'running' },
      finalizer: { status: 'running' },
      cancelThrows: true,
    });

    expect(outcome).toMatchObject({
      outcome: 'cancellation-pending',
      awaiting: ['controller', 'finalizer', 'attempt-run'],
    });
  });

  it('treats a controller that already committed canceled as success, not a conflict', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({
      workflows: settled,
      // The cooperative controller wins the race: it commits `canceled` while the host's cancel is in flight.
      onCancel: async () => {
        const marked = (await store.get('g1'))!;
        await commitCancellation(store, marked, Date.parse(NOW));
      },
    });
    const { control } = dependencies(store, engine);

    const outcome = await cancelGoal(control, (await store.get('g1'))!, {});

    expect(outcome).toMatchObject({
      outcome: 'canceled',
      goal: { status: 'canceled', transitionSeq: 2 },
    });
    const record = await store.get('g1');
    expect(record?.attempts.map((attempt) => attempt.status)).toEqual(['aborted']);
  });

  it('changes nothing for a goal that has already ended', async () => {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    await commitCancellation(store, (await store.get('g1'))!, Date.parse(NOW));
    const ended = (await store.get('g1'))!;
    const { engine, calls } = scriptedEngine({ workflows: settled });
    const { control, stopped } = dependencies(store, engine);

    const outcome = await cancelGoal(control, ended, {});

    expect(outcome).toEqual({ outcome: 'already-terminal', goal: ended });
    expect(calls).toEqual([]);
    expect(stopped).toEqual([]);
    expect(await store.get('g1')).toEqual(ended);
  });
});
