/**
 * COR-851 — the forwarder that carries an attempt's ending to its controller.
 *
 * Over a real durable engine and real runs, with the goal's store real too:
 * what is asserted is the signal that reaches the engine, and when it does not.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  createActiveRun,
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  type DurableActiveRunContext,
  goalAttemptTerminalSignalName,
  type RegistryAgnosticEngine,
  type RunOptions,
  startDurableRunResult,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAttemptForwarder } from './goal-forwarder';
import { attemptSignalId, createGoalState } from './goal-state';
import { createGoalStore, type GoalStore } from './goal-store';
import { pollUntil } from './testing/goal-fixtures.test-support';
import type { BureauDiagnostic } from './types';

const NOW = '2026-10-02T12:00:00.000Z';
const runtime = createDefaultRuntimeServices();

interface SentSignal {
  readonly workflowId: string;
  readonly name: string;
  readonly payload: unknown;
  readonly signalId: string | undefined;
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function options(
  generate: RunOptions['generate'],
  costEstimation?: RunOptions['costEstimation'],
): RunOptions {
  return {
    generate,
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
    ...(costEstimation === undefined ? {} : { costEstimation }),
  };
}

type SignalFunction = (
  workflowId: string,
  name: string,
  payload: unknown,
  deliveryOptions?: { signalId?: string },
) => Promise<void>;

/** The engine with `signal` replaced. Every other method keeps its own receiver. */
function withSignal(
  engine: RegistryAgnosticEngine,
  signal: SignalFunction,
): RegistryAgnosticEngine {
  return new Proxy(engine, {
    get(target, property) {
      if (property === 'signal') return signal;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value.bind(target) as unknown) : value;
    },
  });
}

async function world(
  goalOverrides: { maximumTotalCostUsd?: number } = {},
  forwarding: {
    retryDelaysMs?: readonly number[];
    settle?: (attemptIndex: number, runId: string) => Promise<void>;
    resolveCostEstimation?: () => Promise<RunOptions['costEstimation'] | undefined>;
  } = {},
) {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const { engine } = await createRunEngine({
    storage,
    runWorkflow: createRunWorkflow(checkpointStore),
    recover: false,
  });
  disposers.push(() => engine[Symbol.dispose]());
  const sent: SentSignal[] = [];
  // Settling and signalling share one log, so a test can say which came first.
  const order: string[] = [];
  const spy = withSignal(engine, (workflowId, name, payload, deliveryOptions) => {
    order.push('signal');
    sent.push({ workflowId, name, payload, signalId: deliveryOptions?.signalId });
    return Promise.resolve();
  });
  const settled: Array<{ attemptIndex: number; runId: string }> = [];
  const durable: DurableActiveRunContext = { engine: spy, checkpointStore };
  const store: GoalStore = createGoalStore(textValueStore(new MemoryStorage()));
  await store.create(
    createGoalState({
      goalRunId: 'g1',
      identity: { name: 'goal', version: '1' },
      objective: { agentName: 'worker', prompt: 'work' },
      validator: { name: 'check', version: '1' },
      conversationPolicy: { kind: 'continue' },
      bounds: { maximumAttempts: 2, maximumTotalSteps: 10, ...goalOverrides },
      now: NOW,
    }),
  );
  const diagnostics: BureauDiagnostic[] = [];
  const costRunIds: string[] = [];
  let closing = false;
  const forwarder = createAttemptForwarder({
    store,
    runtime,
    getDurable: () => durable,
    resolveCostEstimation: (runId) => {
      costRunIds.push(runId);
      return forwarding.resolveCostEstimation?.() ?? Promise.resolve({ model: 'gpt-4o' });
    },
    conversations: {
      settle: async (_record, attemptIndex, runId) => {
        order.push('settle');
        settled.push({ attemptIndex, runId });
        await forwarding.settle?.(attemptIndex, runId);
      },
    },
    ...(forwarding.retryDelaysMs === undefined ? {} : { retryDelaysMs: forwarding.retryDelaysMs }),
    isClosing: () => closing,
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
  });
  return {
    durable,
    engine,
    store,
    sent,
    order,
    settled,
    forwarder,
    diagnostics,
    costRunIds,
    close: () => {
      closing = true;
    },
  };
}

const target = { goalRunId: 'g1', attemptIndex: 0, runId: 'goal-g1-a0' } as const;

const finishedRun = async (context: DurableActiveRunContext, content = 'all done') =>
  startDurableRunResult(context, {
    runId: target.runId,
    sessionId: target.runId,
    options: options(
      () =>
        Promise.resolve({
          content,
          toolCalls: [],
          usage: { prompt: 100, completion: 50, total: 150 },
        }),
      { model: 'gpt-4o' },
    ),
    prompt: 'go',
  });

describe('createAttemptForwarder', () => {
  it('sends the ended attempt to its controller under a stable signal id', async () => {
    const { durable, sent, forwarder, costRunIds } = await world(
      {},
      { resolveCostEstimation: () => Promise.resolve(undefined) },
    );
    await finishedRun(durable);

    expect(await forwarder.reconcile(target)).toBe('signal-resent');

    expect(sent).toEqual([
      {
        workflowId: 'goal:g1',
        name: goalAttemptTerminalSignalName(0),
        payload: { finishReason: 'stop-condition', steps: 1, tokens: 150 },
        signalId: attemptSignalId('g1', 0),
      },
    ]);
    expect(attemptSignalId('g1', 0)).toBe('attempt-terminal:g1:0');
    // The run's persisted estimator is always read, bound or not; this one declared none.
    expect(costRunIds).toEqual([target.runId]);
  });

  it('reports the cost of the run even when the goal has no cost bound', async () => {
    const { durable, sent, forwarder, costRunIds } = await world();
    await finishedRun(durable);

    await forwarder.reconcile(target);

    // The bound only decides whether a missing estimate is fatal: the terminal
    // result is rebuilt with the persisted estimator either way, so the signal
    // and the goal's aggregate usage account for the cost the live run had.
    expect(costRunIds).toEqual([target.runId]);
    const payload = sent[0]?.payload as { costUsd?: number };
    expect(payload.costUsd).toBeGreaterThan(0);
  });

  it("commits the attempt's transcript to its session before it tells the controller the attempt ended", async () => {
    const { durable, order, settled, forwarder } = await world();
    await finishedRun(durable);

    await forwarder.reconcile(target);

    expect(order).toEqual(['settle', 'signal']);
    expect(settled).toEqual([{ attemptIndex: 0, runId: 'goal-g1-a0' }]);
  });

  it('commits nothing for a run that has not ended', async () => {
    const { durable, order, forwarder } = await world();
    startDurableRunResult(durable, {
      runId: target.runId,
      sessionId: target.runId,
      options: options(() => new Promise(() => {})),
      prompt: 'go',
    }).catch(() => undefined);
    await pollUntil(async () => (await durable.engine.get(target.runId)) !== null);

    expect(await forwarder.reconcile(target)).toBe('watching');

    expect(order).toEqual([]);
  });

  it('reports the cost of the run when the goal has a cost bound', async () => {
    const { durable, sent, forwarder, costRunIds } = await world({ maximumTotalCostUsd: 1 });
    await finishedRun(durable);

    await forwarder.reconcile(target);

    expect(costRunIds).toEqual([target.runId]);
    const payload = sent[0]?.payload as { costUsd?: number };
    expect(payload.costUsd).toBeGreaterThan(0);
  });

  it('prices the run from the attempt run it is reading, never from the goal or the catalog', async () => {
    const { durable, forwarder, costRunIds } = await world({ maximumTotalCostUsd: 1 });
    await finishedRun(durable);

    await forwarder.reconcile(target);

    // The estimator is the one persisted with that run, whatever the goal's
    // prompt or the catalog's agent now say.
    expect(costRunIds).toEqual([target.runId]);
  });

  it('retries a cost estimator that failed in passing instead of reporting the attempt as unaccounted', async () => {
    let failures = 2;
    const { durable, sent, forwarder, diagnostics, costRunIds } = await world(
      { maximumTotalCostUsd: 1 },
      {
        retryDelaysMs: [0, 0, 0],
        resolveCostEstimation: () => {
          if (failures > 0) {
            failures -= 1;
            return Promise.reject(new Error('pricing service hiccup'));
          }
          return Promise.resolve({ model: 'gpt-4o' });
        },
      },
    );
    await finishedRun(durable);

    forwarder.watch(target);
    await pollUntil(() => sent.length === 1);

    // The signal says what the run cost; it never went out without a cost.
    expect(costRunIds).toHaveLength(3);
    const payload = sent[0]?.payload as { costUsd?: number } | undefined;
    expect(payload?.costUsd).toBeGreaterThan(0);
    expect(diagnostics).toEqual([]);
  });

  it('sends nothing, and reports the failure, when the cost estimator is down for a goal with a cost bound', async () => {
    const { durable, sent, forwarder } = await world(
      { maximumTotalCostUsd: 1 },
      { resolveCostEstimation: () => Promise.reject(new Error('pricing service is down')) },
    );
    await finishedRun(durable);

    const failure = await forwarder.reconcile(target).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toEqual(expect.objectContaining({ message: 'pricing service is down' }));
    expect(sent).toEqual([]);
  });

  it('sends the same signal id each time it is asked, which is what makes re-sending safe', async () => {
    const { durable, sent, forwarder } = await world();
    await finishedRun(durable);

    await forwarder.reconcile(target);
    await forwarder.reconcile(target);

    expect(sent.map((signal) => signal.signalId)).toEqual([
      'attempt-terminal:g1:0',
      'attempt-terminal:g1:0',
    ]);
    expect(sent[1]?.payload).toEqual(sent[0]?.payload);
  });

  it('reports a run that does not exist, and sends nothing for it', async () => {
    const { sent, forwarder } = await world();

    expect(await forwarder.reconcile(target)).toBe('missing');
    expect(sent).toEqual([]);
  });

  it('attaches to a run that is still going and sends its ending when it comes', async () => {
    const { durable, sent, forwarder, engine } = await world();
    createActiveRun(
      options(() => new Promise(() => {})),
      { ...durable, runId: target.runId, prompt: 'go' },
    );
    await pollUntil(async () => (await engine.get(target.runId)) !== null);

    expect(await forwarder.reconcile(target)).toBe('watching');
    expect(sent).toEqual([]);

    await engine.cancel(target.runId);
    await pollUntil(() => sent.length === 1);
    expect(sent[0]).toMatchObject({
      name: 'attempt-terminal:0',
      payload: { finishReason: 'aborted' },
    });
  });

  it('waits for the engine to record the ending when the live handle settles first', async () => {
    const { durable, sent, forwarder, engine } = await world();
    const release = Promise.withResolvers<void>();
    createActiveRun(
      options(async () => {
        await release.promise;
        return { content: 'done', toolCalls: [] };
      }),
      { ...durable, runId: target.runId, prompt: 'go' },
    );
    await pollUntil(async () => (await engine.get(target.runId)) !== null);

    // The in-process handle settles on an event, which is not proof the engine's
    // terminal write has committed; here it settles while the run is still going.
    forwarder.watch(target, { result: () => Promise.resolve({}) } as never);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(sent).toEqual([]);

    release.resolve();
    await pollUntil(() => sent.length === 1);
    expect(sent[0]).toMatchObject({ payload: { finishReason: 'stop-condition' } });
  });

  it('sends nothing once the goal has ended, has been canceled, or the bureau is closing', async () => {
    const { durable, sent, forwarder, store, close } = await world();
    await finishedRun(durable);

    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    expect(await forwarder.reconcile(target)).toBe('not-needed');

    const {
      forwarder: closingForwarder,
      close: closeSecond,
      sent: secondSent,
      durable: secondDurable,
    } = await world();
    await finishedRun(secondDurable);
    closeSecond();
    expect(await closingForwarder.reconcile(target)).toBe('not-needed');

    expect(sent).toEqual([]);
    expect(secondSent).toEqual([]);
    close();
  });

  it('stands down without committing the transcript when a cancellation landed after it read the goal', async () => {
    // The cost estimator runs between the forwarder's first read of the goal and
    // its commit, so a cancellation requested there is exactly the stale-record
    // window: the first read saw a running goal.
    const { durable, order, settled, sent, forwarder, store } = await world(
      { maximumTotalCostUsd: 5 },
      {
        resolveCostEstimation: async () => {
          await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
          return { model: 'gpt-4o' };
        },
      },
    );
    await finishedRun(durable);

    expect(await forwarder.reconcile(target)).toBe('not-needed');

    expect(settled).toEqual([]);
    expect(order).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('never reports an empty run for an attempt whose checkpoint could not be read', async () => {
    const { durable, sent, forwarder } = await world();
    await finishedRun(durable);
    const load = durable.checkpointStore.loadCheckpoint.bind(durable.checkpointStore);
    let failures = 1;
    durable.checkpointStore.loadCheckpoint = (runId) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('checkpoint store unavailable'));
      }
      return load(runId);
    };

    let caught: unknown;
    try {
      await forwarder.reconcile(target);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error | undefined)?.message).toBe('checkpoint store unavailable');
    expect(sent).toEqual([]);

    expect(await forwarder.reconcile(target)).toBe('signal-resent');
    expect(sent.map((signal) => signal.payload)).toEqual([
      { finishReason: 'stop-condition', steps: 1, tokens: 150, costUsd: expect.any(Number) },
    ]);
  });

  it('does not read a missing engine as an attempt that owes nothing', async () => {
    const { store } = await world();
    const withoutEngine = createAttemptForwarder({
      store,
      runtime,
      getDurable: () => undefined,
      resolveCostEstimation: () => Promise.resolve(undefined),
      conversations: { settle: () => Promise.resolve() },
      isClosing: () => false,
      diagnose: () => {},
    });

    let caught: unknown;
    try {
      await withoutEngine.reconcile(target);
    } catch (error) {
      caught = error;
    }

    expect((caught as Error | undefined)?.message).toContain('no durable engine');
  });

  it('does not report a signal that failed because the controller had just ended', async () => {
    const { durable, forwarder, store, diagnostics } = await world();
    await finishedRun(durable);
    const failing: DurableActiveRunContext = {
      ...durable,
      engine: withSignal(durable.engine, async () => {
        await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
        throw new Error('workflow is terminal');
      }),
    };
    const quiet = createAttemptForwarder({
      store,
      runtime,
      getDurable: () => failing,
      resolveCostEstimation: () => Promise.resolve(undefined),
      conversations: { settle: () => Promise.resolve() },
      isClosing: () => false,
      diagnose: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(await quiet.reconcile(target)).toBe('not-needed');
    void forwarder;
    expect(diagnostics).toEqual([]);
  });

  it('sends the ending again, in this process, when forwarding it failed in passing', async () => {
    let failures = 2;
    const { durable, sent, forwarder, diagnostics } = await world(
      {},
      {
        retryDelaysMs: [0, 0, 0],
        settle: async () => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('session store hiccup');
          }
        },
      },
    );
    await finishedRun(durable);

    forwarder.watch(target);
    await pollUntil(() => sent.length === 1);

    expect(failures).toBe(0);
    expect(sent[0]).toMatchObject({ name: 'attempt-terminal:0' });
    expect(diagnostics).toEqual([]);
  });

  it('gives up with one diagnostic once its retries are spent, leaving the rest to recovery', async () => {
    const { durable, sent, forwarder, diagnostics } = await world(
      {},
      {
        retryDelaysMs: [0, 0],
        settle: () => Promise.reject(new Error('session store is down')),
      },
    );
    await finishedRun(durable);

    forwarder.watch(target);
    await pollUntil(() => diagnostics.length === 1);
    await forwarder.drain();

    expect(sent).toEqual([]);
    expect(diagnostics[0]).toMatchObject({ level: 'error', scope: 'goals' });
    expect(diagnostics[0]?.message).toContain('session store is down');
  });
});
