/**
 * COR-851 — the goal workflow's ports: what Bureau answers when the controller
 * asks it to start an attempt, run the validator, or stop a run.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createActiveRun,
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  type DurableActiveRunContext,
  type GoalWorkflowPorts,
  type RunOptions,
  startDurableRunResult,
  stopWhen,
  type Validator,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import type { AttemptForwarder, AttemptTarget } from './goal-forwarder';
import {
  attemptPromptFor,
  createGoalPorts,
  createGoalWorkflowHost,
  goalIdentifiers,
  GoalPortsUnboundError,
} from './goal-ports';
import {
  createGoalState,
  goalAttemptId,
  goalAttemptRunId,
  goalDecisionId,
  goalTransitionId,
} from './goal-state';
import { createGoalStore, type GoalStore } from './goal-store';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import { pollUntil } from './testing/goal-fixtures.test-support';
import { throwingRejectionOf } from './testing/promise-outcome.test-support.ts';

const NOW = '2026-10-02T12:00:00.000Z';
const CHECK = { name: 'check', version: '1' } as const;

describe('attemptPromptFor', () => {
  const objective = { agentName: 'worker', prompt: 'work' };
  it.each([
    { kind: 'continue', index: 0, feedback: undefined, expected: 'work' },
    { kind: 'continue', index: 0, feedback: 'ignored', expected: 'work' },
    { kind: 'continue', index: 1, feedback: undefined, expected: 'work' },
    { kind: 'continue', index: 1, feedback: 'say done', expected: 'work\n\nsay done' },
  ] as const)('$kind attempt $index with feedback $feedback is "$expected"', (row) => {
    expect(attemptPromptFor({ objective }, row.index, row.feedback)).toBe(row.expected);
  });
});

describe('createGoalWorkflowHost', () => {
  const request = { goalRunId: 'g1' };

  it('fails every port loudly until the real ports are bound, then forwards to them', async () => {
    const host = createGoalWorkflowHost();
    const calls: string[] = [];
    const unbound = await Promise.allSettled([
      host.ports.loadGoalState('g1'),
      host.ports.commitTransition({} as never),
      host.ports.startAttempt({} as never),
      host.ports.runValidator({} as never),
      host.ports.abortAttempt({} as never),
    ]);
    for (const outcome of unbound) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(GoalPortsUnboundError);
    }

    host.bind({
      identifiers: goalIdentifiers,
      loadGoalState: (id) => {
        calls.push(`load:${id}`);
        return Promise.resolve({ record: undefined, nowMs: 1 });
      },
      commitTransition: () => Promise.resolve({ status: 'applied' }),
      startAttempt: () => Promise.resolve({ status: 'started', sessionId: 's' }),
      runValidator: () => Promise.reject(new Error('unused')),
      abortAttempt: () => Promise.resolve(),
    });

    expect(await host.ports.loadGoalState(request.goalRunId)).toEqual({
      record: undefined,
      nowMs: 1,
    });
    expect(await host.ports.commitTransition({} as never)).toEqual({ status: 'applied' });
    expect(calls).toEqual(['load:g1']);
  });

  it('names the deterministic ids the store keys its records by', () => {
    expect(goalIdentifiers.transitionId('g1', 4)).toBe(goalTransitionId('g1', 4));
    expect(goalIdentifiers.attemptId('g1', 2)).toBe('g1:a2');
    expect(goalIdentifiers.attemptRunId('g1', 2)).toBe('goal-g1-a2');
    expect(goalIdentifiers.decisionId('g1:a2')).toBe('g1:a2:decision');
  });
});

// ---------------------------------------------------------------------------
// The ports over a real engine and store
// ---------------------------------------------------------------------------

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function agentOptions(generate: RunOptions['generate']): RunOptions {
  return {
    generate,
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  };
}

interface WorldOptions {
  readonly validators?: readonly Validator[];
  readonly plan?: { durable: boolean; agentVersion: string } | undefined;
  readonly startAttemptRun?: Parameters<typeof createGoalPorts>[0]['startAttemptRun'];
  readonly cancelRun?: Parameters<typeof createGoalPorts>[0]['cancelRun'];
  readonly bounds?: {
    maximumAttempts: number;
    maximumTotalSteps?: number;
    maximumTotalCostUsd?: number;
  };
}

async function world(options: WorldOptions = {}) {
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
  const durable: DurableActiveRunContext = { engine, checkpointStore };
  const store: GoalStore = createGoalStore(textValueStore(new MemoryStorage()));
  await store.create(
    createGoalState({
      goalRunId: 'g1',
      identity: { name: 'goal', version: '1' },
      objective: { agentName: 'worker', prompt: 'work' },
      validator: CHECK,
      conversationPolicy: { kind: 'continue' },
      retryPolicy: { retryOn: ['validator-fail-retryable'] },
      bounds: options.bounds ?? { maximumAttempts: 3, maximumTotalSteps: 10 },
      principal: 'alice',
      now: NOW,
    }),
  );
  const watched: Array<{ target: AttemptTarget; live: unknown }> = [];
  const forwarder: AttemptForwarder = {
    watch: (target, live) => watched.push({ target, live }),
    reconcile: () => Promise.resolve('not-needed'),
    drain: () => Promise.resolve(),
  };
  const runtime = createManualRuntimeServices();
  const ports: GoalWorkflowPorts = createGoalPorts({
    store,
    catalog: createGoalValidatorCatalog(options.validators ?? []),
    runtime,
    forwarder,
    getDurable: () => durable,
    planAgent: () => ('plan' in options ? options.plan : { durable: true, agentVersion: '1' }),
    startAttemptRun:
      options.startAttemptRun ??
      (() => {
        throw new Error('no attempt run was expected');
      }),
    cancelRun: options.cancelRun ?? (() => Promise.resolve({ status: 'requested' })),
    resolveCostEstimation: () => Promise.resolve(undefined),
  });
  return { durable, engine, store, ports, watched, runtime };
}

const startRequest = (feedback?: string) => ({
  goalRunId: 'g1',
  attemptIndex: feedback === undefined ? 0 : 1,
  attemptId: goalAttemptId('g1', feedback === undefined ? 0 : 1),
  runId: goalAttemptRunId('g1', feedback === undefined ? 0 : 1),
  ...(feedback === undefined ? {} : { feedback }),
});

describe('startAttempt', () => {
  it("starts the run under the attempt's deterministic id, as the goal's principal, and watches it", async () => {
    const starts: unknown[] = [];
    const live = { marker: 'live run' };
    const { ports, watched } = await world({
      startAttemptRun: (start) => {
        starts.push(start);
        return { run: live as never, durablyStarted: Promise.resolve() };
      },
    });

    const outcome = await ports.startAttempt(startRequest('say done'));

    expect(outcome).toEqual({ status: 'started', sessionId: 'goal-g1-a1' });
    expect(starts).toEqual([
      { agentName: 'worker', input: 'work\n\nsay done', runId: 'goal-g1-a1', principal: 'alice' },
    ]);
    expect(watched).toEqual([
      { target: { goalRunId: 'g1', attemptIndex: 1, runId: 'goal-g1-a1' }, live },
    ]);
  });

  it("adopts a run that already exists under the attempt's id instead of starting another", async () => {
    const { ports, durable, watched } = await world();
    await startDurableRunResult(durable, {
      runId: 'goal-g1-a0',
      sessionId: 'goal-g1-a0',
      options: agentOptions(() => Promise.resolve({ content: 'done', toolCalls: [] })),
      prompt: 'work',
    });

    const outcome = await ports.startAttempt(startRequest());

    expect(outcome).toEqual({ status: 'adopted', sessionId: 'goal-g1-a0' });
    expect(watched).toHaveLength(1);
    expect(watched[0]?.live).toBeUndefined();
  });

  it("refuses to adopt a workflow that is not the attempt's run", async () => {
    const { ports, engine } = await world();
    await engine.start('durableHeartbeatTick', {}, { id: 'goal-g1-a0' }).catch(() => undefined);
    // Any workflow holding the id that is not an agent run's will do.
    const taken = await engine.get('goal-g1-a0');
    if (taken === null) return;

    const outcome = await ports.startAttempt(startRequest());

    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { detail: string }).detail).toContain('names a different workflow');
  });

  it('adopts the run when a concurrent start created it first, and rethrows any other failure', async () => {
    let created = false;
    const raced = await world({
      startAttemptRun: () => {
        created = true;
        throw new Error('Run "goal-g1-a0" already exists');
      },
    });
    createActiveRun(
      agentOptions(() => new Promise(() => {})),
      { ...raced.durable, runId: 'goal-g1-a0', prompt: 'work' },
    );
    const original = raced.engine.get.bind(raced.engine);
    await pollUntil(async () => (await original('goal-g1-a0')) !== null);
    // The racer's workflow was not there when this start first looked, and was by the time it failed.
    let reads = 0;
    raced.engine.get = (id: string) =>
      id === 'goal-g1-a0' && reads++ === 0 ? Promise.resolve(null) : original(id);

    expect(await raced.ports.startAttempt(startRequest())).toEqual({
      status: 'adopted',
      sessionId: 'goal-g1-a0',
    });
    expect(created).toBe(true);

    const broken = await world({
      startAttemptRun: () => {
        throw new Error('storage is down');
      },
    });
    expect(await throwingRejectionOf(broken.ports.startAttempt(startRequest()))).toThrow(
      'storage is down',
    );
  });

  it("does not answer until the attempt's workflow is durably started", async () => {
    const started = Promise.withResolvers<void>();
    const { ports, watched } = await world({
      startAttemptRun: () => ({
        run: { marker: 'live' } as never,
        durablyStarted: started.promise,
      }),
    });

    const answer = ports.startAttempt(startRequest());
    let answered = false;
    void answer.then(() => {
      answered = true;
    });
    // Drain every microtask the start could use to answer early.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(answered).toBe(false);
    expect(watched).toEqual([]);

    started.resolve();
    expect(await answer).toEqual({ status: 'started', sessionId: 'goal-g1-a0' });
    expect(watched).toHaveLength(1);
  });

  it('fails the activity when the workflow could not be started, instead of leaving the goal waiting for it', async () => {
    const { ports, watched } = await world({
      startAttemptRun: () => ({
        run: {} as never,
        durablyStarted: Promise.reject(new Error('recovery record write failed')),
      }),
    });

    expect(await throwingRejectionOf(ports.startAttempt(startRequest()))).toThrow(
      'recovery record write failed',
    );
    expect(watched).toEqual([]);
  });

  it('adopts the run when the deferred start failed because a concurrent start created it', async () => {
    const racer = await world({
      startAttemptRun: () => ({
        run: {} as never,
        durablyStarted: Promise.reject(new Error('Run "goal-g1-a0" already exists')),
      }),
    });
    createActiveRun(
      agentOptions(() => new Promise(() => {})),
      { ...racer.durable, runId: 'goal-g1-a0', prompt: 'work' },
    );
    const original = racer.engine.get.bind(racer.engine);
    await pollUntil(async () => (await original('goal-g1-a0')) !== null);
    let reads = 0;
    racer.engine.get = (id: string) =>
      id === 'goal-g1-a0' && reads++ === 0 ? Promise.resolve(null) : original(id);

    expect(await racer.ports.startAttempt(startRequest())).toEqual({
      status: 'adopted',
      sessionId: 'goal-g1-a0',
    });
  });

  it('starts nothing for a goal whose cancellation is already recorded', async () => {
    let starts = 0;
    const { ports, store, watched } = await world({
      startAttemptRun: () => {
        starts += 1;
        return { run: {} as never, durablyStarted: Promise.resolve() };
      },
    });
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);

    const outcome = await ports.startAttempt(startRequest());

    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { detail: string }).detail).toContain('canceled');
    expect(starts).toBe(0);
    expect(watched).toEqual([]);
  });

  it('stops the run it just created when a cancellation was recorded while it was starting', async () => {
    const started = Promise.withResolvers<void>();
    const stopped: string[] = [];
    const { ports, store, watched } = await world({
      startAttemptRun: () => ({ run: {} as never, durablyStarted: started.promise }),
      cancelRun: (runId) => {
        stopped.push(runId);
        return Promise.resolve({ status: 'requested' });
      },
    });

    const answer = ports.startAttempt(startRequest());
    // The canceller wrote its marker while the workflow was still being created.
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    started.resolve();

    const outcome = await answer;
    expect(outcome).toMatchObject({ status: 'failed' });
    expect((outcome as { detail: string }).detail).toContain('canceled');
    expect(stopped).toEqual(['goal-g1-a0']);
    expect(watched).toEqual([]);
  });

  it('fails the attempt, not the controller, when the agent is gone or cannot run durably', async () => {
    const gone = await world({ plan: undefined });
    expect(await gone.ports.startAttempt(startRequest())).toEqual({
      status: 'failed',
      detail: 'Starting the inner run failed: agent "worker" is no longer in the catalog',
    });

    const inProcess = await world({ plan: { durable: false, agentVersion: '1' } });
    expect(await inProcess.ports.startAttempt(startRequest())).toEqual({
      status: 'failed',
      detail: 'Starting the inner run failed: agent "worker" cannot run durably',
    });
  });
});

describe('abortAttempt', () => {
  const request = { goalRunId: 'g1', attemptIndex: 0, attemptId: 'g1:a0', runId: 'goal-g1-a0' };

  it("stops the attempt's run, and treats a run that never existed or already ended as done", async () => {
    const stopped: string[] = [];
    for (const status of [
      'requested',
      'already-terminal',
      'not-found',
      'unsupported-capability',
    ] as const) {
      const { ports } = await world({
        cancelRun: (runId) => {
          stopped.push(runId);
          return Promise.resolve({ status });
        },
      });
      await ports.abortAttempt(request);
    }
    expect(stopped).toEqual(Array.from({ length: 4 }, () => 'goal-g1-a0'));
  });

  it('fails the activity when the engine could not cancel the run, so the controller is retried', async () => {
    const { ports } = await world({
      cancelRun: () => Promise.resolve({ status: 'failed', error: new Error('engine busy') }),
    });

    expect(await throwingRejectionOf(ports.abortAttempt(request))).toThrow('engine busy');
  });
});

describe('runValidator', () => {
  const request = {
    goalRunId: 'g1',
    attemptId: 'g1:a0',
    attemptIndex: 0,
    validator: CHECK,
  };

  /** Records attempt 0 as evaluating, over a run that has really completed. */
  async function evaluating(options: WorldOptions = {}, content = 'done') {
    const context = await world(options);
    await startDurableRunResult(context.durable, {
      runId: 'goal-g1-a0',
      sessionId: 'goal-g1-a0',
      options: agentOptions(() => Promise.resolve({ content, toolCalls: [] })),
      prompt: 'work',
    });
    await context.store.applyTransition({
      goalRunId: 'g1',
      seq: 1,
      transitionId: goalTransitionId('g1', 1),
      to: 'running',
      at: NOW,
      cause: 'attempt 0 started',
      attempt: {
        attemptId: 'g1:a0',
        attemptIndex: 0,
        runId: 'goal-g1-a0',
        sessionId: 'goal-g1-a0',
        startedAt: NOW,
        usage: { steps: 0, tokens: 0 },
        status: 'running',
      },
      usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
    });
    return context;
  }

  it("runs the catalogued validator against the attempt's rebuilt result and projects its verdict", async () => {
    const seen: Array<{ content: string; history: number }> = [];
    const { ports } = await evaluating({
      validators: [
        {
          identity: CHECK,
          validate: ({ result, history }) => {
            seen.push({ content: result.content, history: history.length });
            return { kind: 'pass', evidence: [{ source: 'check', detail: { when: new Date(0) } }] };
          },
        },
      ],
    });

    const result = await ports.runValidator(request);

    expect(seen).toEqual([{ content: 'done', history: 0 }]);
    expect(result).toMatchObject({
      identity: CHECK,
      outcome: {
        kind: 'pass',
        evidence: [{ source: 'check', detail: { when: '1970-01-01T00:00:00.000Z' } }],
      },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('hands the validator the attempts before this one', async () => {
    const seen: Array<{ feedback: (string | undefined)[]; outcome: (string | undefined)[] }> = [];
    const { ports, store, durable } = await evaluating({
      validators: [
        {
          identity: CHECK,
          validate: (input) => {
            seen.push({
              feedback: input.history.map((attempt) => attempt.feedback),
              outcome: input.history.map((attempt) => attempt.validation?.outcome.kind),
            });
            return { kind: 'pass', evidence: [] };
          },
        },
      ],
    });
    // Attempt 0 failed with feedback, and attempt 1 is the one under evaluation.
    const attemptZero = {
      attemptId: 'g1:a0',
      attemptIndex: 0,
      runId: 'goal-g1-a0',
      sessionId: 'goal-g1-a0',
      startedAt: NOW,
      usage: { steps: 1, tokens: 0 },
    } as const;
    await store.applyTransition({
      goalRunId: 'g1',
      seq: 2,
      transitionId: goalTransitionId('g1', 2),
      to: 'evaluating',
      at: NOW,
      cause: 'attempt 0 reached stop-condition',
      attempt: { ...attemptZero, finishReason: 'stop-condition', status: 'evaluating' },
    });
    await store.applyTransition({
      goalRunId: 'g1',
      seq: 3,
      transitionId: goalTransitionId('g1', 3),
      to: 'retrying',
      at: NOW,
      cause: 'retrying',
      attempt: {
        ...attemptZero,
        completedAt: NOW,
        finishReason: 'stop-condition',
        feedback: 'say done',
        validation: {
          identity: CHECK,
          startedAt: NOW,
          completedAt: NOW,
          outcome: { kind: 'fail', feedback: 'say done', evidence: [], retryable: true },
          decisionId: goalDecisionId('g1:a0'),
        },
        status: 'failed',
      },
    });
    await startDurableRunResult(durable, {
      runId: 'goal-g1-a1',
      sessionId: 'goal-g1-a1',
      options: agentOptions(() => Promise.resolve({ content: 'second try', toolCalls: [] })),
      prompt: 'work',
    });
    await store.applyTransition({
      goalRunId: 'g1',
      seq: 4,
      transitionId: goalTransitionId('g1', 4),
      to: 'running',
      at: NOW,
      cause: 'attempt 1 started',
      attempt: {
        attemptId: 'g1:a1',
        attemptIndex: 1,
        runId: 'goal-g1-a1',
        sessionId: 'goal-g1-a1',
        startedAt: NOW,
        usage: { steps: 0, tokens: 0 },
        status: 'running',
      },
    });

    await ports.runValidator({ ...request, attemptId: 'g1:a1', attemptIndex: 1 });

    expect(seen).toEqual([{ feedback: ['say done'], outcome: ['fail'] }]);
  });

  it.each([
    { label: 'is not registered', validators: [], code: 'VALIDATOR_MISSING' },
    {
      label: 'is registered at another version',
      validators: [
        {
          identity: { name: 'check', version: '2' },
          validate: () => ({ kind: 'canceled' as const }),
        },
      ],
      code: 'VALIDATOR_VERSION_MISMATCH',
    },
  ])('answers unavailable, naming it, when the validator $label', async ({ validators, code }) => {
    const { ports } = await evaluating({ validators });

    const result = await ports.runValidator(request);

    expect(result.outcome).toMatchObject({ kind: 'unavailable', error: { kind: 'load', code } });
    expect(result.identity).toEqual(CHECK);
  });

  it("answers an error, not a throw, when the attempt's result cannot be read", async () => {
    const { ports } = await world({
      validators: [{ identity: CHECK, validate: () => ({ kind: 'canceled' }) }],
    });
    await ports.commitTransition({
      goalRunId: 'g1',
      seq: 1,
      transitionId: goalTransitionId('g1', 1),
      to: 'running',
      at: NOW,
      cause: 'attempt 0 started',
      attempt: {
        attemptId: 'g1:a0',
        attemptIndex: 0,
        runId: 'goal-g1-a0',
        sessionId: 'goal-g1-a0',
        startedAt: NOW,
        usage: { steps: 0, tokens: 0 },
        status: 'running',
      },
    });

    const result = await ports.runValidator(request);

    expect(result.outcome).toMatchObject({
      kind: 'error',
      error: { code: 'ATTEMPT_RESULT_UNAVAILABLE' },
    });
  });

  it('turns a validator that throws into an error outcome with its cause projected', async () => {
    const { ports } = await evaluating({
      validators: [
        {
          identity: CHECK,
          validate: () => {
            throw new TypeError('the checker broke');
          },
        },
      ],
    });

    const result = await ports.runValidator(request);

    expect(result.outcome).toMatchObject({
      kind: 'error',
      error: { kind: 'execute', code: 'VALIDATOR_THREW', message: 'the checker broke' },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('ends a validator that outlives its timeout, on the runtime clock', async () => {
    const { ports, runtime } = await evaluating({
      validators: [{ identity: CHECK, validate: () => new Promise(() => {}) }],
    });

    const pending = ports.runValidator({ ...request, validatorTimeoutMs: 50 });
    await pollUntil(() => runtime.pendingTimers().length > 0);
    await runtime.advance(50);
    const result = await pending;

    expect(result.outcome).toMatchObject({
      kind: 'error',
      error: { kind: 'timeout', code: 'VALIDATOR_TIMEOUT' },
    });
  });

  it('brings an outcome over the inline cap under it without changing the verdict', async () => {
    const { ports } = await evaluating({
      validators: [
        {
          identity: CHECK,
          validate: () => ({
            kind: 'fail',
            feedback: 'too much',
            retryable: true,
            evidence: [{ source: 'big', detail: 'x'.repeat(200_000) }],
          }),
        },
      ],
    });

    const result = await ports.runValidator(request);

    expect(result.outcome).toMatchObject({
      kind: 'fail',
      feedback: 'too much',
      retryable: true,
      evidence: [{ source: 'big', detail: { truncated: true, originalByteLength: 200_002 } }],
    });
    expect(JSON.stringify(result.outcome).length).toBeLessThan(65_536);
  });
});
