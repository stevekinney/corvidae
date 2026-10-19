/**
 * A result waiter belongs to the run generation it was created for. `resultResolvers` is keyed
 * by workflow id and a `start-new` replacement reuses the id, so each settle site must refuse a
 * waiter bound to a different run instead of handing it the replacement's outcome.
 *
 * These use stub `EngineInternals`: the behavior lives in the resolver and the settle helpers,
 * not in claim ownership, which the two-engine regression in `workflow-claim-two-engine.test.ts`
 * covers end to end.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { encode } from '../codec.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import type { WorkflowResultWaiter } from './engine-internal-types.ts';
import { bootstrapWorkflowResultResolver, getWorkflowResultPromise } from './handle-result.ts';
import { ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING, Engine } from './index.ts';
import {
  bindResultWaiterToRun,
  resultWaiterForRun,
  waiterBelongsToRun,
  workflowRunReplacedError,
} from './result-waiter-run.ts';

const WORKFLOW_ID = 'bound-waiter-1';

function createWaiter(workflowExecutionToken?: string): WorkflowResultWaiter {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  void promise.catch(() => {});
  return { promise, resolve, reject, workflowExecutionToken };
}

function createInternals(storage: MemoryStorage = new MemoryStorage()) {
  return {
    storage,
    workflowClaimRegistry: null,
    resultResolvers: new Map<string, WorkflowResultWaiter>(),
    checkpoints: new Map<string, { workflowExecutionToken?: string }>(),
    handleCache: new Map(),
    finalizationRegistry: { unregister: () => {} },
    disposed: false,
  } as any;
}

async function seedState(storage: MemoryStorage, state: Record<string, unknown>): Promise<void> {
  await storage.put(KEYS.workflow(WORKFLOW_ID), encode({ id: WORKFLOW_ID, ...state }));
}

describe('waiterBelongsToRun', () => {
  it('matches the same token, and treats a missing token on either side as the same run', () => {
    expect(waiterBelongsToRun(createWaiter('run-a'), 'run-a')).toBe(true);
    expect(waiterBelongsToRun(createWaiter('run-a'), 'run-b')).toBe(false);
    expect(waiterBelongsToRun(createWaiter(undefined), 'run-b')).toBe(true);
    expect(waiterBelongsToRun(createWaiter('run-a'), undefined)).toBe(true);
  });

  it('binds an unbound waiter once and never rebinds it', () => {
    const waiter = createWaiter();
    bindResultWaiterToRun(waiter, undefined);
    expect(waiter.workflowExecutionToken).toBeUndefined();
    bindResultWaiterToRun(waiter, 'run-a');
    bindResultWaiterToRun(waiter, 'run-b');
    expect(waiter.workflowExecutionToken).toBe('run-a');
  });
});

describe('resultWaiterForRun', () => {
  it('returns the waiter of the same run and leaves it registered', () => {
    const internals = createInternals();
    const waiter = createWaiter('run-a');
    internals.resultResolvers.set(WORKFLOW_ID, waiter);
    expect(resultWaiterForRun(internals, WORKFLOW_ID, 'run-a')).toBe(waiter);
    expect(internals.resultResolvers.get(WORKFLOW_ID)).toBe(waiter);
  });

  it('rejects and drops a waiter bound to an older run instead of returning it', async () => {
    const internals = createInternals();
    const waiter = createWaiter('run-a');
    internals.resultResolvers.set(WORKFLOW_ID, waiter);
    expect(resultWaiterForRun(internals, WORKFLOW_ID, 'run-b')).toBeUndefined();
    expect(internals.resultResolvers.has(WORKFLOW_ID)).toBe(false);
    expect(await rejectionOf(waiter.promise)).toEqual(workflowRunReplacedError(WORKFLOW_ID));
  });

  it('returns nothing when no waiter is registered', () => {
    expect(resultWaiterForRun(createInternals(), WORKFLOW_ID, 'run-a')).toBeUndefined();
  });
});

describe('bootstrapWorkflowResultResolver', () => {
  it('rejects a waiter for run A as replaced once the record under the id is run B and terminal', async () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const storage = new MemoryStorage();
      const internals = createInternals(storage);
      await seedState(storage, { status, workflowExecutionToken: 'run-b', result: 'from-b' });
      const waiter = createWaiter('run-a');
      internals.resultResolvers.set(WORKFLOW_ID, waiter);

      expect(await bootstrapWorkflowResultResolver(internals, WORKFLOW_ID, waiter)).toBe('settled');

      expect(await rejectionOf(waiter.promise)).toEqual(workflowRunReplacedError(WORKFLOW_ID));
      expect(internals.resultResolvers.has(WORKFLOW_ID)).toBe(false);
    }
  });

  it('keeps a waiter for run A pending while the record under the id is a run B that has not ended', async () => {
    for (const status of ['running', 'suspended'] as const) {
      const storage = new MemoryStorage();
      const internals = createInternals(storage);
      await seedState(storage, { status, workflowExecutionToken: 'run-b' });
      const waiter = createWaiter('run-a');
      internals.resultResolvers.set(WORKFLOW_ID, waiter);

      expect(await bootstrapWorkflowResultResolver(internals, WORKFLOW_ID, waiter)).toBe('pending');

      expect(internals.resultResolvers.get(WORKFLOW_ID)).toBe(waiter);
    }
  });

  it('binds a waiter created without a local checkpoint from its first read, then keeps it bound', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);
    await seedState(storage, { status: 'running', workflowExecutionToken: 'run-a' });
    const waiter = createWaiter();
    internals.resultResolvers.set(WORKFLOW_ID, waiter);

    expect(await bootstrapWorkflowResultResolver(internals, WORKFLOW_ID, waiter)).toBe('pending');
    expect(waiter.workflowExecutionToken).toBe('run-a');

    await seedState(storage, { status: 'completed', workflowExecutionToken: 'run-b' });
    expect(await bootstrapWorkflowResultResolver(internals, WORKFLOW_ID, waiter)).toBe('settled');
    expect(await rejectionOf(waiter.promise)).toEqual(workflowRunReplacedError(WORKFLOW_ID));
  });

  it('does not link a stale waiter to a replacement waiter registered for a newer run', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);
    await seedState(storage, { status: 'running', workflowExecutionToken: 'run-b' });
    const stale = createWaiter('run-a');
    const replacement = createWaiter('run-b');
    internals.resultResolvers.set(WORKFLOW_ID, replacement);

    expect(await bootstrapWorkflowResultResolver(internals, WORKFLOW_ID, stale)).toBe('settled');
    replacement.resolve('from-b');

    expect(await rejectionOf(stale.promise)).toEqual(workflowRunReplacedError(WORKFLOW_ID));
    expect(internals.resultResolvers.get(WORKFLOW_ID)).toBe(replacement);
  });

  it('does not link a stale waiter to a replacement when the stored record is already gone', async () => {
    const internals = createInternals();
    const stale = createWaiter('run-a');
    const replacement = createWaiter('run-b');
    internals.resultResolvers.set(WORKFLOW_ID, replacement);

    expect(await bootstrapWorkflowResultResolver(internals, WORKFLOW_ID, stale)).toBe('settled');
    replacement.resolve('from-b');

    expect(await rejectionOf(stale.promise)).toEqual(workflowRunReplacedError(WORKFLOW_ID));
  });

  it('still settles a waiter of the same run from the terminal record', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);
    await seedState(storage, {
      status: 'completed',
      workflowExecutionToken: 'run-a',
      result: 'from-a',
    });
    const waiter = createWaiter('run-a');
    internals.resultResolvers.set(WORKFLOW_ID, waiter);

    expect(await bootstrapWorkflowResultResolver(internals, WORKFLOW_ID, waiter)).toBe('settled');
    expect(await waiter.promise).toBe('from-a');
  });
});

describe('getWorkflowResultPromise', () => {
  it('binds a new waiter to the run this engine holds, and retires one left by an older run', async () => {
    const storage = new MemoryStorage();
    const internals = createInternals(storage);
    await seedState(storage, { status: 'running', workflowExecutionToken: 'run-b' });
    internals.checkpoints.set(WORKFLOW_ID, { workflowExecutionToken: 'run-b' });
    const stale = createWaiter('run-a');
    internals.resultResolvers.set(WORKFLOW_ID, stale);

    const promise = getWorkflowResultPromise(internals, WORKFLOW_ID);

    expect(promise).not.toBe(stale.promise);
    expect(await rejectionOf(stale.promise)).toEqual(workflowRunReplacedError(WORKFLOW_ID));
    expect(internals.resultResolvers.get(WORKFLOW_ID)?.workflowExecutionToken).toBe('run-b');
  });
});

describe('a result() call while this engine holds the run suspended (COR-1604)', () => {
  const maybeWait = workflow({ name: 'cor-1604-maybe-wait' }).execute(async function* (
    ctx: WorkflowContext,
    input: { wait: boolean; value: string },
  ) {
    if (input.wait) yield* ctx.waitForSignal('go');
    return input.value;
  });

  /** A view of `shared` whose `get` of `key` waits for `gate` once `armed` is set. */
  function gatedView(
    shared: MemoryStorage,
    key: string,
    gate: { armed: boolean; reached: PromiseWithResolvers<void>; release: Promise<void> },
  ): MemoryStorage {
    return new Proxy(shared, {
      get(target, property) {
        if (property === 'get') {
          return async (requested: string) => {
            if (gate.armed && requested === key) {
              gate.armed = false;
              gate.reached.resolve();
              await gate.release;
            }
            return await target.get(requested);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('rejects as replaced when another engine replaces and ends the run before the first read', async () => {
    const id = 'cor-1604-suspended-waiter';
    const shared = new MemoryStorage();
    const release = Promise.withResolvers<void>();
    const gate = { armed: false, reached: Promise.withResolvers<void>(), release: release.promise };
    await using holder = new Engine({ storage: gatedView(shared, KEYS.workflow(id), gate) });
    await using other = new Engine({ storage: shared });
    holder.register(maybeWait);
    other.register(maybeWait);

    await holder.start(maybeWait.name, { wait: true, value: 'original' }, { id });
    await holder[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING](id);
    await holder.suspend(id);

    // The holder keeps no checkpoint for a suspended run, only the attempt that launched it.
    gate.armed = true;
    const result = holder.getHandle(id).result();
    await gate.reached.promise;

    // Another engine cancels the run and a `start-new` replacement runs to completion, all
    // before the holder's result() reads the record for the first time.
    await other.cancel(id);
    const replacement = await other.start(
      maybeWait.name,
      { wait: false, value: 'replacement' },
      { id, onTerminalConflict: 'start-new' },
    );
    expect(await replacement.result()).toBe('replacement');
    release.resolve();

    const reason = await rejectionOf(result);
    expect(reason).toEqual(workflowRunReplacedError(id));
  });
});
