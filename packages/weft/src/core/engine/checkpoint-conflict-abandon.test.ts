/**
 * What abandoning a workflow after a lost checkpoint compare-and-swap releases
 * and refuses to write, and the call paths that reach it besides the generator's
 * own checkpoint message.
 *
 * Losses are forced deterministically: a storage wrapper writes a different
 * checkpoint under the engine at the checkpoint commit that follows an armed
 * step, which is exactly what a second engine's winning write does, so the real
 * conditional batch loses. After that point the wrapper records every write the
 * losing engine attempts.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { KEYS, type BatchOperation, type Storage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createDeferred } from '../../testing/fake-timers.test-support.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { decode } from '../codec/api.ts';
import { DurableActivityScopeError, durableActivity } from '../context/durable-activity.ts';
import { RemoteActivityCancellationRequestedEvent } from '../events.ts';
import { activity, workflow, type WorkflowContext, type WorkflowState } from '../types.ts';
import { clearPurgedWorkflowInMemoryState } from './bulk-operations-purge.ts';
import {
  abandonWorkflowAfterCheckpointConflict,
  emitCheckpointConflictWarning,
  persistCheckpointAbandoningOnConflict,
} from './checkpoint-conflict-abandon.ts';
import {
  WeftWorkflowCheckpointConflictWarning,
  WorkflowCheckpointConflictError,
} from './checkpoint-conflict-error.ts';
import { clearCheckpointConflictForResume } from './checkpoint-conflict-record.ts';
import { stageAtomicWorkflowCommitSideEffects } from './checkpoint-side-effects.ts';
import { getWorkflowResultPromise } from './handle-result.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { workflowFeedListenerKey } from './state-utilities.ts';
import { swallowPromiseRejection } from './strategy-helpers.ts';
import { cleanupTerminalWorkflowMemory } from './termination/cleanup.ts';
import { failWorkflow } from './termination/complete.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

function writeOperations(
  name: string,
  argumentsList: readonly unknown[],
): readonly BatchOperation[] | null {
  if (name === 'batch') return argumentsList[0] as BatchOperation[];
  if (name === 'conditionalBatch') return argumentsList[1] as BatchOperation[];
  return null;
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
      if (!['put', 'delete', 'deletePrefix', 'batch', 'conditionalBatch'].includes(name)) {
        return original.bind(target);
      }
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

describe('abandoning a workflow after a lost checkpoint compare-and-swap', () => {
  it('releases every per-workflow in-memory map for the workflow and no other', async () => {
    const storage = new MemoryStorage();
    const writes: string[] = [];
    const watched = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        if (
          ['put', 'delete', 'deletePrefix', 'batch', 'conditionalBatch'].includes(String(property))
        ) {
          writes.push(String(property));
        }
        return original.bind(target);
      },
    });
    await using engine = new Engine({ storage: watched });
    const internals = getInternals(engine);
    const remoteCancellations: Event[] = [];
    engine.addEventListener(RemoteActivityCancellationRequestedEvent.type, (event) => {
      remoteCancellations.push(event);
    });
    const warning = collectConflictWarnings();

    const seed = (workflowId: string): void => {
      internals.checkpoints.set(workflowId, {} as never);
      internals.heartbeatDetails.set(workflowId, 1);
      internals.lastHeartbeatDetailsByStep.set(workflowId, new Map());
      internals.pendingAsyncActivities.set(`token-${workflowId}`, { workflowId } as never);
      internals.eventLogHeads.set(workflowId, {} as never);
      internals.pendingTimelineEntries.set(workflowId, {} as never);
      internals.pendingAsyncActivityResolutions.set(workflowId, {} as never);
      stageAtomicWorkflowCommitSideEffects(internals, workflowId, {
        conditions: [],
        operations: [{ type: 'put', key: 'staged', value: new Uint8Array([1]) }],
      });
      internals.workflowServices.set(workflowId, { credential: 'closure' });
      internals.workflowHeaders.set(workflowId, new Map());
      internals.workflowVersionTuples.set(workflowId, {} as never);
      internals.cancelHandlersByWorkflow.set(workflowId, []);
      internals.workflowFeedListeners.set(workflowFeedListenerKey(workflowId, 'events'), new Set());
      internals.workflowFeedListeners.set(workflowFeedListenerKey(workflowId, 'tokens'), new Set());
      internals.workflowNestingDepths.set(workflowId, 1);
      internals.deliveredPendingUpdateIds.set(workflowId, new Set());
      internals.workflowTypeByWorkflowId.set(workflowId, {} as never);
      internals.workflowsNeedingTerminalCleanup.add(workflowId);
      internals.parkedInlineWorkflows.add(workflowId);
      internals.durableInlineOperations.set(workflowId, {} as never);
    };
    const holdsState = (workflowId: string): boolean[] => [
      internals.checkpoints.has(workflowId),
      internals.heartbeatDetails.has(workflowId),
      internals.lastHeartbeatDetailsByStep.has(workflowId),
      [...internals.pendingAsyncActivities.values()].some(
        (pending) => pending.workflowId === workflowId,
      ),
      internals.eventLogHeads.has(workflowId),
      internals.pendingTimelineEntries.has(workflowId),
      internals.pendingAsyncActivityResolutions.has(workflowId),
      internals.pendingAtomicWorkflowCommitSideEffects.has(workflowId),
      internals.workflowServices.has(workflowId),
      internals.workflowHeaders.has(workflowId),
      internals.workflowVersionTuples.has(workflowId),
      internals.cancelHandlersByWorkflow.has(workflowId),
      internals.workflowFeedListeners.has(workflowFeedListenerKey(workflowId, 'events')),
      internals.workflowFeedListeners.has(workflowFeedListenerKey(workflowId, 'tokens')),
      internals.workflowNestingDepths.has(workflowId),
      internals.deliveredPendingUpdateIds.has(workflowId),
      internals.workflowTypeByWorkflowId.has(workflowId),
      internals.workflowsNeedingTerminalCleanup.has(workflowId),
      internals.parkedInlineWorkflows.has(workflowId),
      internals.durableInlineOperations.has(workflowId),
    ];
    seed('lost');
    seed('bystander');
    expect(holdsState('lost').every(Boolean)).toBe(true);

    const error = new WorkflowCheckpointConflictError('lost');
    abandonWorkflowAfterCheckpointConflict(internals, error, { swallowPromiseRejection });
    // A second report of the same loss does nothing: one warning, no re-release.
    abandonWorkflowAfterCheckpointConflict(internals, error, { swallowPromiseRejection });
    await warning.received;
    warning.stop();

    expect(holdsState('lost').some(Boolean)).toBe(false);
    expect(holdsState('bystander').every(Boolean)).toBe(true);
    expect(internals.checkpointConflicts.get('lost')?.error).toBe(error);
    expect(warning.warnings.map((emitted) => emitted.workflowId)).toEqual(['lost']);
    // The winner owns the durable task behind a pending async activity.
    expect(remoteCancellations).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('drops the recorded loss on terminal cleanup, purge, and engine disposal', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const internals = getInternals(engine);
    const warning = collectConflictWarnings(3);
    for (const workflowId of ['terminal', 'purged', 'disposed']) {
      abandonWorkflowAfterCheckpointConflict(
        internals,
        new WorkflowCheckpointConflictError(workflowId),
        { swallowPromiseRejection },
      );
    }
    await warning.received;
    warning.stop();
    expect([...internals.checkpointConflicts.keys()]).toEqual(['terminal', 'purged', 'disposed']);

    cleanupTerminalWorkflowMemory(internals, 'terminal', {
      swallowPromiseRejection,
      dispatchEvent: () => {},
    });
    expect(internals.checkpointConflicts.has('terminal')).toBe(false);

    clearPurgedWorkflowInMemoryState(internals, { id: 'purged' } as never, () => {});
    expect(internals.checkpointConflicts.has('purged')).toBe(false);

    await engine[Symbol.asyncDispose]();
    expect(internals.checkpointConflicts.size).toBe(0);
  });

  it('forgets the local workflow-lease claim without a durable write', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const internals = getInternals(engine);
    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'abandoning-engine',
      getNow: () => internals.options.getNow(),
      claimTtlMs: 30_000,
      claimRenewIntervalMs: 5_000,
    });
    internals.workflowClaimRegistry = registry;
    const acquired = await registry.acquire('claimed');
    expect(acquired.status).toBe('acquired');
    const holderBefore = await storage.get(KEYS.workflowOwnerHolder('claimed'));
    expect(registry.currentEpoch('claimed')).not.toBeNull();
    const warning = collectConflictWarnings();

    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError('claimed'),
      {
        swallowPromiseRejection,
      },
    );
    warning.stop();

    expect(registry.currentEpoch('claimed')).toBeNull();
    expect(await storage.get(KEYS.workflowOwnerHolder('claimed'))).toEqual(holderBefore);
  });

  it('refuses to fail an abandoned workflow durably, until the engine launches it again', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const internals = getInternals(engine);
    const warning = collectConflictWarnings();
    abandonWorkflowAfterCheckpointConflict(internals, new WorkflowCheckpointConflictError('gone'), {
      swallowPromiseRejection,
    });
    warning.stop();
    const reads: string[] = [];
    internals.storage = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original === 'function') reads.push(String(property));
        return typeof original === 'function' ? original.bind(target) : original;
      },
    });

    await failWorkflow(internals, 'gone', new Error('late failure'), {} as never);

    expect(reads).toEqual([]);
  });

  it('fails a once-abandoned workflow durably when a later local resume fails before launching it', async () => {
    const storage = new MemoryStorage();
    const parked = workflow({ name: 'abandoned-then-recovered' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('continue');
      return 'completed';
    });
    const firstEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { 'abandoned-then-recovered': parked },
    });
    await firstEngine.start('abandoned-then-recovered', null, { id: 'recovered-run' });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await storage.get(KEYS.checkpoint('recovered-run'))) !== null) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await firstEngine[Symbol.asyncDispose]();

    await using engine = await Engine.create({
      storage,
      recover: false,
      workflows: { 'abandoned-then-recovered': parked },
    });
    const warning = collectConflictWarnings();
    abandonWorkflowAfterCheckpointConflict(
      getInternals(engine),
      new WorkflowCheckpointConflictError('recovered-run'),
      { swallowPromiseRejection },
    );
    await warning.received;
    warning.stop();

    // The recovery hook is a pre-check that runs before the workflow is
    // launched, so its failure is this engine's own, legitimate terminal outcome.
    await engine.recoverAll({
      onRecoveredWorkflow: () => {
        throw new Error('live surface unavailable');
      },
    });

    expect(await readStatus(storage, 'recovered-run')).toBe('failed');
  });

  it('retires the workflow through the active execution strategy and never cancels it', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    // Worker and revision-realm engines run with no inline strategy; the
    // active strategy is the one that owns the workflow's execution.
    const inlineStrategy = internals.inlineStrategy;
    const activeStrategy = internals.strategy;
    const retired: string[] = [];
    const cancelled: string[] = [];
    internals.inlineStrategy = null;
    internals.strategy = new Proxy(activeStrategy, {
      get(target, property) {
        // Real cancellation can discard a worker and fail its other workflows;
        // an abandoned run must take the non-failing retire path instead.
        if (property === 'cancelWorkflow') {
          return (workflowId: string) => cancelled.push(workflowId);
        }
        if (property === 'retireWorkflow') {
          return (workflowId: string) => retired.push(workflowId);
        }
        const original: unknown = Reflect.get(target, property, target);
        return typeof original === 'function' ? original.bind(target) : original;
      },
    });
    const warning = collectConflictWarnings();
    try {
      abandonWorkflowAfterCheckpointConflict(
        internals,
        new WorkflowCheckpointConflictError('worker-run'),
        { swallowPromiseRejection },
      );
      await warning.received;
    } finally {
      warning.stop();
      internals.strategy = activeStrategy;
      internals.inlineStrategy = inlineStrategy;
    }

    expect(retired).toEqual(['worker-run']);
    expect(cancelled).toEqual([]);
  });

  it('finishes abandoning when the strategy cannot retire the execution', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
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
    const pending = getWorkflowResultPromise(internals, 'unreachable-run');
    const conflict = new WorkflowCheckpointConflictError('unreachable-run');
    const warning = collectConflictWarnings();
    try {
      abandonWorkflowAfterCheckpointConflict(internals, conflict, { swallowPromiseRejection });
      await warning.received;
    } finally {
      warning.stop();
      internals.strategy = activeStrategy;
    }

    expect(await rejectionOf(pending)).toBe(conflict);
    expect(internals.checkpointConflicts.get('unreachable-run')?.error).toBe(conflict);
    expect(warning.warnings.map((emitted) => emitted.workflowId)).toEqual(['unreachable-run']);
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

  it('rethrows a persist failure that is not a checkpoint conflict without abandoning', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const internals = getInternals(engine);
    const failure = new Error('storage unavailable');

    const reason = await rejectionOf(
      persistCheckpointAbandoningOnConflict(internals, () => Promise.reject(failure)),
    );

    expect(reason).toBe(failure);
    expect(internals.checkpointConflicts.size).toBe(0);
  });
});

describe('result() after a recorded checkpoint loss', () => {
  const conflictRecord = (workflowId: string, workflowExecutionToken: string | undefined) => ({
    error: new WorkflowCheckpointConflictError(workflowId),
    workflowExecutionToken,
  });

  it('keeps reporting the loss when storage cannot be read', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const internals = getInternals(engine);
    const record = conflictRecord('unreadable', 'lost-run');
    internals.checkpointConflicts.set('unreadable', record);
    internals.storage = new Proxy(storage, {
      get(target, property) {
        if (property === 'get') return () => Promise.reject(new Error('storage unavailable'));
        const original: unknown = Reflect.get(target, property, target);
        return typeof original === 'function' ? original.bind(target) : original;
      },
    });

    expect(await rejectionOf(getWorkflowResultPromise(internals, 'unreadable'))).toBe(record.error);
    expect(internals.checkpointConflicts.get('unreadable')).toBe(record);
  });

  it('drops a loss that storage shows belongs to a run that is gone, then resolves normally', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    internals.checkpointConflicts.set('replaced', conflictRecord('replaced', 'lost-run'));

    const reason = await rejectionOf(getWorkflowResultPromise(internals, 'replaced'));

    expect((reason as Error).message).toContain('not found in storage');
    expect(internals.checkpointConflicts.has('replaced')).toBe(false);
  });

  it('defers to a local launch that cleared the loss while storage was being read', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    internals.checkpointConflicts.set('relaunched', conflictRecord('relaunched', 'lost-run'));
    const pending = getWorkflowResultPromise(internals, 'relaunched');
    internals.checkpointConflicts.delete('relaunched');

    const reason = await rejectionOf(pending);

    expect((reason as Error).message).toContain('not found in storage');
  });

  it('clears a loss for resume with and without a cached handle', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    internals.checkpointConflicts.set('uncached', conflictRecord('uncached', undefined));
    clearCheckpointConflictForResume(internals, 'uncached');
    expect(internals.checkpointConflicts.has('uncached')).toBe(false);

    clearCheckpointConflictForResume(internals, 'never-recorded');
    expect(internals.checkpointConflicts.size).toBe(0);
  });
});

describe('a checkpoint conflict raised outside the generator checkpoint message', () => {
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
    // closing, as it would for any cancellation — never the conflict.
    expect(observedByWorkflow).toEqual([]);
    expect(observedInMemoCallback).toHaveLength(1);
    expect(observedInMemoCallback[0]).toBeInstanceOf(DurableActivityScopeError);
    expect(state.writesAfterLoss).toEqual([]);
    expect(await readStatus(base, 'retry-conflict')).toBe('running');
    expect(warning.warnings.map((emitted) => emitted.workflowId)).toEqual(['retry-conflict']);
    expect(getInternals(engine).inlineStrategy?.hasGenerator('retry-conflict')).toBe(false);
  });

  it('abandons a local parent awaiting a child this engine abandoned, naming the child as cause', async () => {
    const base = new MemoryStorage();
    const armed = { value: false };
    const { storage, state } = createLosingStorage(base, 'abandoned-child', armed);
    const observedByUserCode: unknown[] = [];
    const child = workflow({ name: 'abandoned-child-workflow' }).execute(async function* (
      context: WorkflowContext,
    ) {
      const first = yield* context.run(() => {
        armed.value = true;
        return 'a';
      });
      const second = yield* context.run(() => 'b');
      return first + second;
    });
    const parent = workflow({ name: 'abandoned-child-parent' }).execute(async function* (
      context: WorkflowContext,
    ) {
      try {
        return yield* context.startChild('abandoned-child-workflow', null, {
          id: 'abandoned-child',
        });
      } catch (error) {
        observedByUserCode.push(error);
        throw error;
      }
    });
    const warning = collectConflictWarnings(2);
    await using engine = new Engine({ storage });
    engine.register(child);
    engine.register(parent);

    const parentHandle = await engine.start('abandoned-child-parent', null, {
      id: 'abandoned-child-parent',
    });
    const parentReason = await rejectionOf(parentHandle.result());
    const childReason = await rejectionOf(engine.getHandle('abandoned-child').result());
    await warning.received;
    warning.stop();

    expect(childReason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((childReason as WorkflowCheckpointConflictError).workflowId).toBe('abandoned-child');
    expect(parentReason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((parentReason as WorkflowCheckpointConflictError).workflowId).toBe(
      'abandoned-child-parent',
    );
    expect((parentReason as WorkflowCheckpointConflictError).cause).toBe(childReason);
    expect(observedByUserCode).toEqual([]);
    expect(state.writesAfterLoss).toEqual([]);
    expect(await readStatus(base, 'abandoned-child-parent')).toBe('running');
    expect(await readStatus(base, 'abandoned-child')).toBe('running');
    expect(warning.warnings.map((emitted) => emitted.workflowId).toSorted()).toEqual([
      'abandoned-child',
      'abandoned-child-parent',
    ]);
    const internals = getInternals(engine);
    expect(internals.inlineStrategy?.hasGenerator('abandoned-child-parent')).toBe(false);
    expect(internals.checkpoints.has('abandoned-child-parent')).toBe(false);
  });

  it('rejects a parent that awaits an already-abandoned child, and still surfaces other child failures', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const internals = getInternals(engine);
    const warning = collectConflictWarnings(2);
    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError('earlier-child'),
      { swallowPromiseRejection },
    );
    const { getGeneratorOwnedWorkflowResultPromise } = await import('./handle-result.ts');

    const parentView = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'earlier-child',
      'late-parent',
    );
    // The loss is checked against storage before it is reported, so the parent
    // is abandoned once that read lands; its view of the child never settles.
    await warning.received;
    warning.stop();
    expect(await Promise.race([parentView, Promise.resolve('pending')])).toBe('pending');

    expect(internals.checkpointConflicts.get('late-parent')?.error.cause).toBe(
      internals.checkpointConflicts.get('earlier-child')?.error,
    );

    // A child that merely failed is not a conflict: the parent still sees it.
    const failure = new Error('child failed');
    const waiter = internals.resultResolvers;
    const failing = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'failing-child',
      'other-parent',
    );
    waiter.get('failing-child')!.reject(failure);
    expect(await rejectionOf(failing)).toBe(failure);
    expect(internals.checkpointConflicts.has('other-parent')).toBe(false);
  });
});
