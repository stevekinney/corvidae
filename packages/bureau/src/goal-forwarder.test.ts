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

import { attemptSignalId, createAttemptForwarder } from './goal-forwarder';
import { createGoalState } from './goal-state';
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

async function world(goalOverrides: { maximumTotalCostUsd?: number } = {}) {
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
  const spy = withSignal(engine, (workflowId, name, payload, deliveryOptions) => {
    sent.push({ workflowId, name, payload, signalId: deliveryOptions?.signalId });
    return Promise.resolve();
  });
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
  const costLookups: string[] = [];
  let closing = false;
  const forwarder = createAttemptForwarder({
    store,
    runtime,
    getDurable: () => durable,
    resolveCostEstimation: (agentName) => {
      costLookups.push(agentName);
      return Promise.resolve({ model: 'gpt-4o' });
    },
    isClosing: () => closing,
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
  });
  return {
    durable,
    engine,
    store,
    sent,
    forwarder,
    diagnostics,
    costLookups,
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
    const { durable, sent, forwarder, costLookups } = await world();
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
    // No cost bound, so the agent's cost estimation is never even asked for.
    expect(costLookups).toEqual([]);
  });

  it('reports the cost of the run when the goal has a cost bound', async () => {
    const { durable, sent, forwarder, costLookups } = await world({ maximumTotalCostUsd: 1 });
    await finishedRun(durable);

    await forwarder.reconcile(target);

    expect(costLookups).toEqual(['worker']);
    const payload = sent[0]?.payload as { costUsd?: number };
    expect(payload.costUsd).toBeGreaterThan(0);
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
      isClosing: () => false,
      diagnose: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(await quiet.reconcile(target)).toBe('not-needed');
    void forwarder;
    expect(diagnostics).toEqual([]);
  });
});
