/**
 * What abandoning a workflow after a lost checkpoint compare-and-swap does and
 * refuses to do under `ownership: 'none'`.
 *
 * The loser marks the lost generation (workflow id plus execution token),
 * retires its execution, rejects the pending `result()` waiter, evicts the
 * cached handle, and warns. It releases nothing else and writes nothing: every
 * later wake, terminal failure, and `result()` for that generation is refused
 * instead. The two-engine race that produces a real loss lives in
 * `checkpoint-conflict.test.ts`; these tests drive the abandonment directly, or
 * force one loss through a storage wrapper, and watch what the engine writes.
 */
import { describe, expect, it, mock, spyOn } from 'bun:test';

import { KEYS, type BatchOperation, type Storage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  createDeferred,
  expectPromisePending,
  waitForCondition,
  yieldToEventLoop,
} from '../../testing/fake-timers.test-support.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { decode } from '../codec/api.ts';
import { DurableActivityScopeError, durableActivity } from '../context/durable-activity.ts';
import type { RemoteActivityBroker, RemoteActivityTaskRequest } from '../remote-activity-broker.ts';
import {
  activity,
  workflow,
  type Checkpoint,
  type TimerEntry,
  type WorkflowContext,
  type WorkflowState,
} from '../types.ts';
import {
  abandonedCheckpointGenerationCount,
  isCheckpointGenerationAbandoned,
  markCheckpointGenerationAbandoned,
} from './abandoned-checkpoint-generations.ts';
import { adoptLaunchCheckpoint } from './checkpoint-commit-snapshots.ts';
import {
  abandonWorkflowAfterCheckpointConflict,
  emitCheckpointConflictWarning,
  persistCheckpointAbandoningOnConflict,
} from './checkpoint-conflict-abandon.ts';
import {
  WeftWorkflowCheckpointConflictWarning,
  WorkflowCheckpointConflictError,
} from './checkpoint-conflict-error.ts';
import { notifyConditionWaiters } from './condition-waiters.ts';
import {
  createWorkflowResultWaiter,
  getGeneratorOwnedWorkflowResultPromise,
} from './handle-result.ts';
import { WorkflowHandle } from './handles.ts';
import { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import { registerSignalWaiter } from './signals.ts';
import { failWorkflow } from './termination/complete.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';

const WRITE_METHODS = ['put', 'delete', 'deletePrefix', 'batch', 'conditionalBatch'];

function writeOperations(
  name: string,
  argumentsList: readonly unknown[],
): readonly BatchOperation[] | null {
  if (name === 'batch') return argumentsList[0] as BatchOperation[];
  if (name === 'conditionalBatch') return argumentsList[1] as BatchOperation[];
  return null;
}

/** Wrap `base` so every write the engine attempts is recorded by method name. */
function recordWrites(base: Storage) {
  const writes: string[] = [];
  const storage = new Proxy(base, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      if (WRITE_METHODS.includes(String(property))) {
        return (...argumentsList: unknown[]) => {
          writes.push(String(property));
          return original.apply(target, argumentsList);
        };
      }
      return original.bind(target);
    },
  });
  return { storage, writes };
}

/**
 * Wrap `base` so the first checkpoint write for `workflowId` after `armed` is
 * set lands behind a checkpoint another writer just replaced, then record every
 * write attempted once that commit has lost.
 */
function createLosingStorage(base: Storage, workflowId: string, armed: { value: boolean }) {
  const checkpointKey = KEYS.checkpoint(workflowId);
  const state = { injected: false, lost: false, writesAfterLoss: [] as string[] };
  const storage = new Proxy(base, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      const name = String(property);
      if (!WRITE_METHODS.includes(name)) return original.bind(target);
      return async (...argumentsList: unknown[]) => {
        if (state.lost) state.writesAfterLoss.push(name);
        const operations = writeOperations(name, argumentsList);
        const writesCheckpoint =
          operations?.some(
            (operation) => operation.type === 'put' && operation.key === checkpointKey,
          ) === true;
        if (armed.value && !state.injected && writesCheckpoint) {
          state.injected = true;
          await target.put(checkpointKey, new Uint8Array([0xff]));
        }
        const result: unknown = await original.apply(target, argumentsList);
        if (state.injected && result === false) state.lost = true;
        return result;
      };
    },
  });
  return { storage, state };
}

/**
 * Collect conflict warnings. `process.emitWarning` delivers on a later tick, so
 * `received` resolves once `expected` of them have actually arrived.
 */
function collectConflictWarnings(expected = 1) {
  const warnings: WeftWorkflowCheckpointConflictWarning[] = [];
  const reached = createDeferred();
  const listener = (warning: Error): void => {
    if (!(warning instanceof WeftWorkflowCheckpointConflictWarning)) return;
    warnings.push(warning);
    if (warnings.length >= expected) reached.resolve();
  };
  process.on('warning', listener);
  return { warnings, received: reached.promise, stop: () => process.off('warning', listener) };
}

async function readStatus(base: Storage, workflowId: string): Promise<WorkflowState['status']> {
  return (decode((await base.get(KEYS.workflow(workflowId)))!) as WorkflowState).status;
}

function tokenOf(internals: EngineInternals, workflowId: string): string | undefined {
  return internals.checkpoints.get(workflowId)?.workflowExecutionToken;
}

/** Report the loss of whichever generation the engine currently holds for the workflow. */
function loseGeneration(internals: EngineInternals, workflowId: string): void {
  abandonWorkflowAfterCheckpointConflict(
    internals,
    new WorkflowCheckpointConflictError(workflowId, {
      workflowExecutionToken: tokenOf(internals, workflowId),
    }),
  );
}

/** Record strategy calls, still calling through, so retirement is observable. */
function observeStrategy(internals: EngineInternals) {
  const retired: string[] = [];
  const cancelled: string[] = [];
  const original = internals.strategy;
  internals.strategy = new Proxy(original, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (property === 'retireWorkflow') {
        return (workflowId: string) => {
          retired.push(workflowId);
          (member as (id: string) => void).call(target, workflowId);
        };
      }
      if (property === 'cancelWorkflow') {
        return (workflowId: string) => {
          cancelled.push(workflowId);
          (member as (id: string) => void).call(target, workflowId);
        };
      }
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return { retired, cancelled, restore: () => (internals.strategy = original) };
}

const parkedOnSignal = (name: string) =>
  workflow({ name }).execute(async function* (context: WorkflowContext) {
    return yield* context.waitForSignal<string>('go');
  });

async function startParked(engine: Engine, name: string, id: string) {
  engine.register(parkedOnSignal(name));
  const handle = await engine.start(name, null, { id });
  await waitForCondition(() => getInternals(engine).parkedInlineWorkflows.has(id), {
    label: `${id} parked on its signal`,
  });
  return handle;
}

describe('abandoning a workflow after a lost checkpoint compare-and-swap', () => {
  it('marks the lost generation, retires it, rejects the waiter, evicts the handle, and releases nothing', async () => {
    const watched = recordWrites(new MemoryStorage());
    await using engine = new Engine({ storage: watched.storage });
    const internals = getInternals(engine);
    const handle = await startParked(engine, 'lost-run', 'lost-run');
    const pendingResult = handle.result();
    const strategy = observeStrategy(internals);
    const held = () => [
      internals.checkpoints.has('lost-run'),
      internals.parkedInlineWorkflows.has('lost-run'),
      internals.eventLogHeads.has('lost-run'),
      internals.workflowVersionTuples.has('lost-run'),
      internals.cancelHandlersByWorkflow.has('lost-run'),
      internals.durableInlineOperations.has('lost-run'),
    ];
    const before = held();
    const checkpointBefore = internals.checkpoints.get('lost-run');
    expect(before.slice(0, 2)).toEqual([true, true]);
    expect(internals.handleCache.has('lost-run')).toBe(true);
    watched.writes.length = 0;
    const warning = collectConflictWarnings();

    try {
      loseGeneration(internals, 'lost-run');
      // A second report of the same loss does nothing: one warning, one retire.
      loseGeneration(internals, 'lost-run');
      await warning.received;
    } finally {
      warning.stop();
      strategy.restore();
    }

    const reason = await rejectionOf(pendingResult);
    expect(reason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((reason as WorkflowCheckpointConflictError).workflowId).toBe('lost-run');
    expect(
      isCheckpointGenerationAbandoned(internals, 'lost-run', tokenOf(internals, 'lost-run')),
    ).toBe(true);
    expect(abandonedCheckpointGenerationCount(internals)).toBe(1);
    expect(strategy.retired).toEqual(['lost-run']);
    expect(strategy.cancelled).toEqual([]);
    expect(internals.resultResolvers.has('lost-run')).toBe(false);
    // The cached handle is gone, so a later getHandle() builds a fresh one.
    expect(internals.handleCache.has('lost-run')).toBe(false);
    expect(engine.getHandle('lost-run')).not.toBe(handle);
    // Nothing else was released, and nothing was written.
    expect(held()).toEqual(before);
    expect(internals.checkpoints.get('lost-run')).toBe(checkpointBefore);
    expect(warning.warnings.map((emitted) => emitted.workflowId)).toEqual(['lost-run']);
    expect(watched.writes).toEqual([]);
  });

  it('finishes abandoning when the strategy cannot retire the execution', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const handle = await startParked(engine, 'unreachable-run', 'unreachable-run');
    const pendingResult = handle.result();
    const activeStrategy = internals.strategy;
    internals.strategy = new Proxy(activeStrategy, {
      get(target, property) {
        if (property === 'retireWorkflow') {
          return () => {
            throw new Error('worker channel closed');
          };
        }
        const original: unknown = Reflect.get(target, property, target);
        return typeof original === 'function' ? original.bind(target) : original;
      },
    });
    const warning = collectConflictWarnings();
    try {
      loseGeneration(internals, 'unreachable-run');
      await warning.received;
    } finally {
      warning.stop();
      internals.strategy = activeStrategy;
    }

    expect(await rejectionOf(pendingResult)).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect(abandonedCheckpointGenerationCount(internals)).toBe(1);
    expect(internals.handleCache.has('unreachable-run')).toBe(false);
  });

  it('ignores a loss that does not name the generation the engine currently holds', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const strategy = observeStrategy(internals);
    internals.checkpoints.set('lost-generation', {
      workflowExecutionToken: 'current-generation',
    } as Checkpoint);

    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError('lost-generation', {
        workflowExecutionToken: 'older-generation',
      }),
    );
    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError('lost-generation'),
    );
    strategy.restore();

    expect(abandonedCheckpointGenerationCount(internals)).toBe(0);
    expect(strategy.retired).toEqual([]);
  });

  it('leaves a replacement generation under the same id alone, through the production start-new path', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    engine.register(parkedOnSignal('replaced-run'));
    const first = await engine.start('replaced-run', null, { id: 'replaced-run' });
    await waitForCondition(() => internals.parkedInlineWorkflows.has('replaced-run'), {
      label: 'first generation parked',
    });
    const firstToken = tokenOf(internals, 'replaced-run');
    await engine.signal('replaced-run', 'go', 'first');
    expect(await first.result()).toBe('first');

    const second = await engine.start('replaced-run', null, {
      id: 'replaced-run',
      onTerminalConflict: 'start-new',
    });
    await waitForCondition(() => internals.parkedInlineWorkflows.has('replaced-run'), {
      label: 'replacement generation parked',
    });
    expect(tokenOf(internals, 'replaced-run')).not.toBe(firstToken);
    const strategy = observeStrategy(internals);
    const warning = collectConflictWarnings();

    // The first generation's commit lost; its error reaches the engine only now.
    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError('replaced-run', { workflowExecutionToken: firstToken }),
    );
    await yieldToEventLoop();
    warning.stop();
    strategy.restore();

    expect(warning.warnings).toEqual([]);
    expect(strategy.retired).toEqual([]);
    expect(abandonedCheckpointGenerationCount(internals)).toBe(0);
    await engine.signal('replaced-run', 'go', 'second');
    expect(await second.result()).toBe('second');
  });

  it('forgets a marker only when the engine launches that same generation again, and on disposal', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    markCheckpointGenerationAbandoned(internals, 'relaunched', 'generation-1');
    markCheckpointGenerationAbandoned(internals, 'relaunched', undefined);
    expect(abandonedCheckpointGenerationCount(internals)).toBe(1);

    adoptLaunchCheckpoint(internals, 'relaunched', {
      workflowExecutionToken: 'generation-2',
    } as Checkpoint);
    expect(abandonedCheckpointGenerationCount(internals)).toBe(1);
    adoptLaunchCheckpoint(internals, 'relaunched', {
      workflowExecutionToken: 'generation-1',
    } as Checkpoint);
    expect(abandonedCheckpointGenerationCount(internals)).toBe(0);

    markCheckpointGenerationAbandoned(internals, 'relaunched', 'generation-1');
    await engine[Symbol.asyncDispose]();
    expect(abandonedCheckpointGenerationCount(internals)).toBe(0);
  });

  it('warns through console.warn where the runtime has no process.emitWarning', () => {
    const warning = new WeftWorkflowCheckpointConflictWarning('browser-run');
    const consoleWarn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      emitCheckpointConflictWarning(warning, null);
      expect(consoleWarn).toHaveBeenCalledWith(warning);
    } finally {
      consoleWarn.mockRestore();
    }
    const emitted: Error[] = [];
    emitCheckpointConflictWarning(warning, { emitWarning: (value) => emitted.push(value) });
    expect(emitted).toEqual([warning]);
  });
});

describe('persistCheckpointAbandoningOnConflict', () => {
  it('returns the persist promise itself, so a successful persist settles with no extra hop', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const persisted = Promise.resolve();

    expect(persistCheckpointAbandoningOnConflict(getInternals(engine), () => persisted)).toBe(
      persisted,
    );
    await persisted;
    expect(abandonedCheckpointGenerationCount(getInternals(engine))).toBe(0);
  });

  it('abandons before the caller observes a conflict, and rethrows anything else untouched', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    internals.checkpoints.set('persisting', { workflowExecutionToken: 'token' } as Checkpoint);
    const conflict = new WorkflowCheckpointConflictError('persisting', {
      workflowExecutionToken: 'token',
    });
    const warning = collectConflictWarnings();

    const reason = await rejectionOf(
      persistCheckpointAbandoningOnConflict(internals, () => Promise.reject(conflict)),
    );
    await warning.received;
    warning.stop();

    expect(reason).toBe(conflict);
    expect(isCheckpointGenerationAbandoned(internals, 'persisting', 'token')).toBe(true);

    const failure = new Error('storage unavailable');
    expect(
      await rejectionOf(
        persistCheckpointAbandoningOnConflict(internals, () => Promise.reject(failure)),
      ),
    ).toBe(failure);
    expect(abandonedCheckpointGenerationCount(internals)).toBe(1);
  });

  it('abandons at the durableActivity retry-sleep persist without delivering the error to user code', async () => {
    const base = new MemoryStorage();
    const armed = { value: false };
    const { storage, state } = createLosingStorage(base, 'retry-conflict', armed);
    const observedInMemoCallback: unknown[] = [];
    const observedByWorkflow: unknown[] = [];
    let attempts = 0;
    const flakyTool = activity({
      name: 'flakyTool',
      retry: { maxAttempts: 2, initialBackoff: 1_000, backoffMultiplier: 1, maxBackoff: 1_000 },
      execute: async () => {
        attempts += 1;
        if (attempts === 1) {
          // The retry-sleep checkpoint persist is the next checkpoint write.
          armed.value = true;
          throw new Error('transient failure');
        }
        return 'done';
      },
      verify: (_result, context) =>
        context?.phase === 'pre-dispatch-reconciliation' ? 'not-completed' : true,
    });
    const definition = workflow({ name: 'retry-conflict' })
      .activities({ flakyTool })
      .execute(async function* (context: WorkflowContext) {
        try {
          return yield* context.memo('step-0', async () => {
            try {
              return await durableActivity(flakyTool, { idempotencyKey: 'retry:conflict' });
            } catch (error) {
              observedInMemoCallback.push(error);
              throw error;
            }
          });
        } catch (error) {
          observedByWorkflow.push(error);
          throw error;
        }
      });
    const warning = collectConflictWarnings();
    await using engine = new Engine({ storage, getNow: () => 0 });
    engine.register(definition);

    const handle = await engine.start('retry-conflict', null, { id: 'retry-conflict' });
    const reason = await rejectionOf(handle.result());
    await warning.received;
    warning.stop();

    expect(reason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect(state.lost).toBe(true);
    // Nothing reaches the generator, and the memo callback sees only its scope
    // closing, as it would for any cancellation, never the conflict.
    expect(observedByWorkflow).toEqual([]);
    expect(observedInMemoCallback).toHaveLength(1);
    expect(observedInMemoCallback[0]).toBeInstanceOf(DurableActivityScopeError);
    expect(state.writesAfterLoss).toEqual([]);
    expect(await readStatus(base, 'retry-conflict')).toBe('running');
    expect(warning.warnings.map((emitted) => emitted.workflowId)).toEqual(['retry-conflict']);
    expect(getInternals(engine).inlineStrategy?.hasGenerator('retry-conflict')).toBe(false);
  });
});

describe('wakes for an abandoned generation', () => {
  it('discards the wake in every ownership mode without consulting the claim registry', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    internals.checkpoints.set('marked', { workflowExecutionToken: 'lost' } as Checkpoint);
    internals.checkpoints.set('healthy', { workflowExecutionToken: 'fine' } as Checkpoint);
    markCheckpointGenerationAbandoned(internals, 'marked', 'lost');

    expect(await confirmWakeOwnership(internals, 'marked', 'signal')).toBe('discard');
    expect(await confirmWakeOwnership(internals, 'healthy', 'signal')).toBe('proceed');
    // A different generation under the marked id is not the abandoned one.
    internals.checkpoints.set('marked', { workflowExecutionToken: 'replacement' } as Checkpoint);
    expect(await confirmWakeOwnership(internals, 'marked', 'signal')).toBe('proceed');
    internals.checkpoints.set('marked', { workflowExecutionToken: 'lost' } as Checkpoint);

    internals.workflowClaimRegistry = {
      engineId: 'engine',
      currentEpoch: () => {
        throw new Error('the abandoned generation must be discarded before the registry is read');
      },
    } as never;
    expect(await confirmWakeOwnership(internals, 'marked', 'signal')).toBe('discard');
    internals.workflowClaimRegistry = null;
  });

  it('does not wake the abandoned generation for a delivered signal', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    await startParked(engine, 'signalled-run', 'signalled-run');
    await startParked(engine, 'signalled-bystander', 'signalled-bystander');
    const markedWaiter = mock(() => {});
    const bystanderWaiter = mock(() => {});
    registerSignalWaiter(internals, 'signalled-run', 'signalled-run:go', markedWaiter);
    registerSignalWaiter(
      internals,
      'signalled-bystander',
      'signalled-bystander:go',
      bystanderWaiter,
    );
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'signalled-run');
    await warning.received;
    warning.stop();

    await engine.signal('signalled-run', 'go', 'late');
    await engine.signal('signalled-bystander', 'go', 'on time');
    await yieldToEventLoop();

    expect(markedWaiter).not.toHaveBeenCalled();
    expect(internals.signalWaiters.has('signalled-run:go')).toBe(true);
    expect(bystanderWaiter).toHaveBeenCalledTimes(1);
  });

  it('does not wake the abandoned generation for a condition poke', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    await startParked(engine, 'poked-run', 'poked-run');
    await startParked(engine, 'bystander-run', 'bystander-run');
    const markedWaiter = mock(() => {});
    const bystanderWaiter = mock(() => {});
    internals.conditionWaiters.set('poked-run', markedWaiter);
    internals.conditionWaiters.set('bystander-run', bystanderWaiter);
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'poked-run');
    await warning.received;
    warning.stop();

    notifyConditionWaiters(internals, 'poked-run');
    notifyConditionWaiters(internals, 'bystander-run');
    await yieldToEventLoop();

    expect(markedWaiter).not.toHaveBeenCalled();
    expect(bystanderWaiter).toHaveBeenCalledTimes(1);
  });

  it('does not feed the abandoned generation an async activity completion', async () => {
    const requests: RemoteActivityTaskRequest[] = [];
    const broker: RemoteActivityBroker = {
      async enqueue(request) {
        requests.push(request);
      },
    };
    await using engine = new Engine({ activityExecution: { mode: 'remote', broker } });
    const internals = getInternals(engine);
    const chargeCard = activity({
      name: 'chargeCard',
      execute: async (_input: { orderId: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'remote-lost' })
        .activities({ chargeCard })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(chargeCard, { orderId: 'ord-1' });
        }),
    );
    await engine.start('remote-lost', null, { id: 'remote-lost' });
    await waitForCondition(() => requests.length > 0, { label: 'activity enqueued' });
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'remote-lost');
    await warning.received;
    warning.stop();
    // A worker or revision-realm engine has no inline strategy: the completion
    // would be fed to the execution strategy, which still holds the stale run.
    const resumed: string[] = [];
    const activeStrategy = internals.strategy;
    internals.strategy = new Proxy(activeStrategy, {
      get(target, property) {
        if (property === 'resumeWorkflow') {
          return (message: { workflowId: string }) => resumed.push(message.workflowId);
        }
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const inlineStrategy = internals.inlineStrategy;
    internals.inlineStrategy = null;
    try {
      await engine.completeAsyncActivity(requests[0]!.operationId, 'charged');
    } finally {
      internals.inlineStrategy = inlineStrategy;
      internals.strategy = activeStrategy;
    }

    // Delivery would stage the resolution record's deletion and resume the
    // execution; a discarded delivery does neither and leaves the record alone.
    expect(resumed).toEqual([]);
    expect(internals.pendingAtomicWorkflowCommitSideEffects.has('remote-lost')).toBe(false);
  });

  it('keeps the winner durable timers when the loser scheduler fires them', async () => {
    let now = 1_000_000;
    const watched = recordWrites(new MemoryStorage());
    await using engine = await Engine.create({
      storage: watched.storage,
      workflows: {
        'timers-condition': workflow({ name: 'timers-condition' }).execute(async function* (
          context: WorkflowContext,
        ) {
          return yield* context.waitUntil(() => false, '5m');
        }),
        'timers-sleep': workflow({ name: 'timers-sleep' }).execute(async function* (
          context: WorkflowContext,
        ) {
          yield* context.sleep('5m');
          return 'woke';
        }),
      },
      getNow: () => now,
      backgroundTasks: 'manual',
      startScheduler: false,
    });
    const internals = getInternals(engine);
    await engine.start('timers-condition', null, { id: 'condition-run', executionTimeout: '10m' });
    await engine.start('timers-sleep', null, { id: 'sleep-run' });
    await waitForCondition(
      () =>
        internals.conditionWaiters.has('condition-run') &&
        internals.sleepResolversByWorkflow.has('sleep-run'),
      { label: 'both runs parked on a durable timer' },
    );
    const reviewHandler = mock(async () => true);
    internals.reviewEscalationHandlers.set('review-1', reviewHandler);
    const reviewTimer: TimerEntry = {
      id: 'review-escalation:review-1:1000',
      workflowId: 'condition-run',
      fireAt: now + 1_000,
      kind: 'sleep',
      workflowExecutionToken: tokenOf(internals, 'condition-run')!,
    };
    await internals.scheduler.schedule(reviewTimer);
    const timerKeys = async (): Promise<string[]> => {
      const keys: string[] = [];
      for await (const [key] of watched.storage.scan('timer-idx:')) keys.push(key);
      return keys.sort();
    };
    const timersBefore = await timerKeys();
    expect(timersBefore.length).toBeGreaterThanOrEqual(4);

    const warning = collectConflictWarnings(2);
    loseGeneration(internals, 'condition-run');
    loseGeneration(internals, 'sleep-run');
    await warning.received;
    warning.stop();
    watched.writes.length = 0;

    // Every timer is due on this engine's scheduler: sleep, condition deadline,
    // execution deadline, and the review escalation.
    now += 11 * 60 * 1000;
    await engine.scheduler.tick(now);

    // The scheduler retries them: the records stay for the winner, nothing was
    // written, no waiter was woken, and no review handler ran.
    expect(await timerKeys()).toEqual(timersBefore);
    expect(watched.writes).toEqual([]);
    expect(reviewHandler).not.toHaveBeenCalled();
    expect(internals.conditionWaiters.has('condition-run')).toBe(true);
    expect(internals.sleepResolversByWorkflow.has('sleep-run')).toBe(true);
    expect((await engine.get('condition-run'))?.status).toBe('running');
    expect((await engine.get('sleep-run'))?.status).toBe('running');
  });
});

describe('failing an abandoned generation', () => {
  const noCallbacks = new Proxy({}, { get: () => () => {} }) as never;

  async function startParkedEngine(name: string, storage: Storage) {
    const engine = await Engine.create({ storage, recover: false });
    engine.register(parkedOnSignal(name));
    await engine.start(name, null, { id: name });
    return engine;
  }

  it('refuses the terminal write for the marked generation', async () => {
    const storage = new MemoryStorage();
    await using engine = await startParkedEngine('refused-failure', storage);
    const internals = getInternals(engine);
    markCheckpointGenerationAbandoned(
      internals,
      'refused-failure',
      tokenOf(internals, 'refused-failure'),
    );
    const watched = recordWrites(storage);
    internals.storage = watched.storage;

    await failWorkflow(internals, 'refused-failure', new Error('late failure'), noCallbacks);
    internals.storage = storage;

    expect(watched.writes).toEqual([]);
    expect(await readStatus(storage, 'refused-failure')).toBe('running');
  });

  it('still fails a later generation under an id whose earlier generation was abandoned', async () => {
    const storage = new MemoryStorage();
    await using engine = await startParkedEngine('later-generation', storage);
    const internals = getInternals(engine);
    markCheckpointGenerationAbandoned(internals, 'later-generation', 'abandoned-generation');

    await failWorkflow(internals, 'later-generation', new Error('pre-launch failure'), noCallbacks);

    expect(await readStatus(storage, 'later-generation')).toBe('failed');
  });

  it('drops a failure already in flight when the run is abandoned before its terminal commit', async () => {
    const storage = new MemoryStorage();
    await using engine = await startParkedEngine('in-flight', storage);
    const internals = getInternals(engine);
    // Hold the failure at its first storage read, as an interleaving turn would.
    const reachedRead = createDeferred();
    const releaseRead = createDeferred();
    internals.storage = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        if (property === 'get') {
          return async (key: string) => {
            if (key === KEYS.attribute('in-flight')) {
              reachedRead.resolve();
              await releaseRead.promise;
            }
            return original.call(target, key);
          };
        }
        return original.bind(target);
      },
    });

    const failing = failWorkflow(internals, 'in-flight', new Error('late failure'), noCallbacks);
    await reachedRead.promise;
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'in-flight');
    await warning.received;
    warning.stop();
    releaseRead.resolve();
    await failing;
    internals.storage = storage;

    expect(await readStatus(storage, 'in-flight')).toBe('running');
  });
});

describe('result() for an abandoned generation', () => {
  it('rejects for a fresh handle without reading storage, while the generation is current', async () => {
    const storage = new MemoryStorage();
    let reads = 0;
    const counting = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        if (property === 'get') {
          return (...argumentsList: unknown[]) => {
            reads += 1;
            return original.apply(target, argumentsList);
          };
        }
        return original.bind(target);
      },
    });
    await using engine = new Engine({ storage: counting });
    const internals = getInternals(engine);
    await startParked(engine, 'fresh-handle', 'fresh-handle');
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'fresh-handle');
    await warning.received;
    warning.stop();
    reads = 0;

    const freshHandle = new WorkflowHandle('fresh-handle', internals.engine);
    const reason = await rejectionOf(freshHandle.result());

    expect(reason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((reason as WorkflowCheckpointConflictError).workflowId).toBe('fresh-handle');
    expect((reason as WorkflowCheckpointConflictError).workflowExecutionToken).toBe(
      tokenOf(internals, 'fresh-handle'),
    );
    expect(reads).toBe(0);
    expect(internals.resultResolvers.has('fresh-handle')).toBe(false);
  });

  it('is untouched for a workflow whose generation was not abandoned', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const handle = await startParked(engine, 'healthy-run', 'healthy-run');
    await startParked(engine, 'lost-neighbour', 'lost-neighbour');
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'lost-neighbour');
    await warning.received;
    warning.stop();

    await engine.signal('healthy-run', 'go', 'fine');
    expect(await handle.result()).toBe('fine');
  });
});

describe('a child this engine abandoned', () => {
  it('never reports a failure to the parent awaiting it, and mutates nothing', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const waiter = createWorkflowResultWaiter(internals, 'abandoned-child');
    const viewedByParent = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'abandoned-child',
      'parent',
    );

    waiter.reject(new WorkflowCheckpointConflictError('abandoned-child'));
    await yieldToEventLoop();

    await expectPromisePending(viewedByParent);
    expect(abandonedCheckpointGenerationCount(internals)).toBe(0);
  });

  it('still surfaces every other child failure, including another workflow conflict', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const failure = new Error('child failed');
    const failedChild = createWorkflowResultWaiter(internals, 'failed-child');
    const viewOfFailure = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'failed-child',
      'parent',
    );
    failedChild.reject(failure);
    const unrelatedConflict = new WorkflowCheckpointConflictError('grandchild');
    const conflictedChild = createWorkflowResultWaiter(internals, 'other-child');
    const viewOfConflict = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'other-child',
      'parent',
    );
    conflictedChild.reject(unrelatedConflict);

    expect(await rejectionOf(viewOfFailure)).toBe(failure);
    expect(await rejectionOf(viewOfConflict)).toBe(unrelatedConflict);
  });
});
