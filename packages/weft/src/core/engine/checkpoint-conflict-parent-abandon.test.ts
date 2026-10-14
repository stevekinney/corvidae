/**
 * A parent that awaits a child its own engine abandoned after a lost checkpoint
 * compare-and-swap (COR-1426).
 *
 * `ownership: 'none'` has no claim to fence two engines, so the engine that loses a child's
 * checkpoint race stops driving the child and writes nothing for it. A parent on that engine
 * awaiting the child through `ctx.startChild()`'s default `parentClosePolicy: 'await'` used to
 * stay parked forever whenever the winner drove only the child: nothing on the losing engine
 * ever settled the parent's view of it. The parent now gives up the same way the child did.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  createDeferred,
  expectPromisePending,
  waitForCondition,
  yieldToEventLoop,
} from '../../testing/fake-timers.test-support.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import {
  collectConflictWarnings,
  interceptConflictWarnings,
  loseGeneration,
  readStatus,
  recordWrites,
  startParked,
  tokenOf,
} from './checkpoint-conflict.test-support.ts';
import { executeChildWorkflow } from './child-workflow.ts';
import {
  abandonedExecutionAttemptCount,
  abandonExecutionAttempt,
  beginExecutionAttempt,
  currentExecutionAttempt,
  isGenerationAbandoned,
} from './execution-attempts.ts';
import { getGeneratorOwnedWorkflowResultPromise } from './generator-owned-result.ts';
import { createWorkflowResultWaiter } from './handle-result.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import {
  parentEligibleForChildConflictAbandonment,
  type ParentAbandonmentEligibilityInput,
} from './parent-abandonment-eligibility.ts';
import { encodeEpoch, encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

interceptConflictWarnings();

const CHILD_ID = 'conflict-child';
const PARENT_ID = 'conflict-parent';

function parentAndChildWorkflows() {
  return {
    'conflict-child': workflow({ name: 'conflict-child' }).execute(async function* (
      context: WorkflowContext,
    ) {
      return yield* context.waitForSignal<string>('go');
    }),
    'conflict-parent': workflow({ name: 'conflict-parent' }).execute(async function* (
      context: WorkflowContext,
    ) {
      const childResult = yield* context.startChild('conflict-child', null, { id: CHILD_ID });
      return `parent saw ${String(childResult)}`;
    }),
  };
}

describe('a parent awaiting a child its engine abandoned', () => {
  it('fails fast with a typed error and writes nothing when the winner drives only the child', async () => {
    const shared = new MemoryStorage();
    const watched = recordWrites(shared);
    const loser = await Engine.create({
      storage: watched.storage,
      workflows: parentAndChildWorkflows(),
      backgroundTasks: 'manual',
      startScheduler: false,
    });
    // Built without recovery and registering only the workflows it is told about, so the winner
    // drives nothing until the test resumes the child on it.
    const winner = new Engine({ storage: shared, backgroundTasks: 'manual' });
    for (const definition of Object.values(parentAndChildWorkflows())) winner.register(definition);
    try {
      const loserInternals = getInternals(loser);
      const parentHandle = await loser.start('conflict-parent', null, { id: PARENT_ID });
      await waitForCondition(() => loserInternals.parkedInlineWorkflows.has(CHILD_ID), {
        label: 'the child parked on its signal',
      });
      const parentToken = tokenOf(loserInternals, PARENT_ID);
      // Observed from the start: the parent's rejection can land before this test looks again.
      const parentOutcome = rejectionOf(parentHandle.result());

      const warning = collectConflictWarnings(2);
      loseGeneration(loserInternals, CHILD_ID);
      watched.writes.length = 0;

      // The winner resumes only the child: it never drives the parent.
      const childOnWinner = await winner.resume(CHILD_ID);
      await waitForCondition(() => getInternals(winner).parkedInlineWorkflows.has(CHILD_ID), {
        label: 'the child parked on the winner',
      });
      await winner.signal(CHILD_ID, 'go', 'done');
      expect(await childOnWinner.result()).toBe('done');

      // Without the fix the parent's view of the child never settles and this stays pending.
      const reason = await Promise.race([
        parentOutcome,
        yieldToEventLoop().then(() => 'pending' as const),
      ]);
      expect(reason).toBeInstanceOf(WorkflowCheckpointConflictError);
      expect((reason as WorkflowCheckpointConflictError).workflowId).toBe(PARENT_ID);
      expect((reason as WorkflowCheckpointConflictError).cause).toBeInstanceOf(
        WorkflowCheckpointConflictError,
      );
      await warning.received;
      warning.stop();
      // The parent's own checkpoint did not lose a race, so the error and the warning must say the
      // child did, rather than claiming a lost checkpoint for a parent that is unchanged.
      expect((reason as WorkflowCheckpointConflictError).lostChildWorkflowId).toBe(CHILD_ID);
      expect((reason as WorkflowCheckpointConflictError).message).toContain(
        `workflow "${CHILD_ID}"`,
      );
      expect((reason as WorkflowCheckpointConflictError).message).not.toContain(
        'Checkpoint commit for workflow',
      );
      expect(warning.warnings.map((w) => w.lostChildWorkflowId)).toContain(CHILD_ID);
      expect(warning.warnings.at(-1)?.message).toContain(
        'is abandoned because the workflow it awaits',
      );
      expect(isGenerationAbandoned(loserInternals, PARENT_ID, parentToken)).toBe(true);
      expect(watched.writes).toEqual([]);
      expect(await readStatus(shared, PARENT_ID)).toBe('running');
      expect(await readStatus(shared, CHILD_ID)).toBe('completed');
    } finally {
      await winner[Symbol.asyncDispose]();
      await loser[Symbol.asyncDispose]();
    }
  });
});

describe('abandoning a parent for a lost child', () => {
  it('abandons the parent once however many lost children it awaits', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const parentHandle = await startParked(engine, 'parked-parent', 'many-children-parent');
    const parentOutcome = rejectionOf(parentHandle.result());
    const warning = collectConflictWarnings();
    const views = ['child-a', 'child-b'].map((childId) => {
      const waiter = createWorkflowResultWaiter(internals, childId);
      const view = getGeneratorOwnedWorkflowResultPromise(internals, childId, parentHandle.id);
      return { waiter, view, childId };
    });

    for (const { waiter, childId } of views) {
      waiter.reject(new WorkflowCheckpointConflictError(childId));
    }
    await warning.received;
    warning.stop();

    const reason = await parentOutcome;
    expect(reason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((reason as WorkflowCheckpointConflictError).workflowId).toBe(parentHandle.id);
    expect(abandonedExecutionAttemptCount(internals)).toBe(1);
    for (const { view } of views) await expectPromisePending(view);
  });

  it('leaves a parent this engine relaunched since it began awaiting the child alone', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const parentHandle = await startParked(engine, 'relaunched-parent', 'relaunched-parent-id');
    const waiter = createWorkflowResultWaiter(internals, 'late-lost-child');
    const view = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'late-lost-child',
      parentHandle.id,
    );
    // The engine launches the same generation again: a new attempt that the late loss is not about.
    beginExecutionAttempt(internals, parentHandle.id, tokenOf(internals, parentHandle.id));

    waiter.reject(new WorkflowCheckpointConflictError('late-lost-child'));
    await yieldToEventLoop();

    await expectPromisePending(view);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    await engine.signal(parentHandle.id, 'go', 'still driven');
    expect(await parentHandle.result()).toBe('still driven');
  });
});

describe('a lost child that no longer concerns the parent', () => {
  it('leaves a parent alone when the awaiting ctx.race branch was aborted', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const parentHandle = await startParked(engine, 'race-parent', 'race-parent-id');
    const loserBranch = new AbortController();
    const waiter = createWorkflowResultWaiter(internals, 'race-lost-child');
    const view = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'race-lost-child',
      parentHandle.id,
      loserBranch.signal,
    );
    loserBranch.abort();

    waiter.reject(new WorkflowCheckpointConflictError('race-lost-child'));
    await yieldToEventLoop();

    await expectPromisePending(view);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    await engine.signal(parentHandle.id, 'go', 'still driven');
    expect(await parentHandle.result()).toBe('still driven');
  });

  it('leaves a parent alone once a successor holds its ownership claim', async () => {
    const storage = new MemoryStorage();
    await using engine = await Engine.create({
      storage,
      ownership: 'workflow-lease',
      workflowClaimTtl: 200,
      workflowClaimRenewInterval: 20,
      recover: false,
    });
    const internals = getInternals(engine);
    const parentHandle = await startParked(engine, 'claim-parent', 'claim-parent-id');
    const waiter = createWorkflowResultWaiter(internals, 'claim-lost-child');
    const view = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'claim-lost-child',
      parentHandle.id,
    );
    // A successor takes the parent over before the child's conflict is delivered.
    await storage.batch([
      { type: 'put', key: KEYS.workflowOwnerEpoch(parentHandle.id), value: encodeEpoch(99) },
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder(parentHandle.id),
        value: encodeWorkflowClaimHolder({
          engineId: 'successor-engine',
          epoch: 99,
          expiresAt: internals.options.getNow() + 60_000,
          claimedAt: internals.options.getNow(),
        }),
      },
    ]);

    waiter.reject(new WorkflowCheckpointConflictError('claim-lost-child'));
    await yieldToEventLoop();

    await expectPromisePending(view);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
  });
});

describe('the parent a lost child is judged against', () => {
  it('binds to the run that began awaiting, not one relaunched during child startup', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const parentHandle = await startParked(engine, 'startup-parent', 'startup-parent-id');
    const waiter = createWorkflowResultWaiter(internals, 'startup-child');
    const startupRead = createDeferred<null>();
    const awaiting = executeChildWorkflow(
      internals,
      parentHandle.id,
      {
        type: 'child-workflow',
        workflowType: 'startup-child-type',
        input: null,
        operationId: 'op',
      } as never,
      0,
      {
        getComposedWorkflowInterceptor: () => null,
        getHandle: () => ({ id: 'startup-child' }) as never,
        loadWorkflowState: () => startupRead.promise,
        start: async () => ({ id: 'startup-child' }) as never,
      },
    );
    // The engine launches the same generation again while the child is still starting up.
    beginExecutionAttempt(internals, parentHandle.id, tokenOf(internals, parentHandle.id));
    startupRead.resolve(null);
    // Attached before the rejection can land, so the parent's view is never unobserved.
    const view = rejectionOrNothing(awaiting);

    waiter.reject(new WorkflowCheckpointConflictError('startup-child'));
    await yieldToEventLoop();

    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    void view;
    await engine.signal(parentHandle.id, 'go', 'still driven');
    expect(await parentHandle.result()).toBe('still driven');
  });

  it('does not abandon for a race branch that is aborted while the ownership check is in flight', async () => {
    const storage = new MemoryStorage();
    const gate = createDeferred();
    let gating = false;
    const gated = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        if (property === 'get') {
          return async (key: string) => {
            if (gating && key === KEYS.workflowOwnerHolder('inflight-parent-id'))
              await gate.promise;
            return (original as (k: string) => Promise<unknown>).call(target, key);
          };
        }
        return original.bind(target);
      },
    });
    await using engine = await Engine.create({
      storage: gated,
      ownership: 'workflow-lease',
      workflowClaimTtl: 200,
      workflowClaimRenewInterval: 20,
      recover: false,
    });
    const internals = getInternals(engine);
    const parentHandle = await startParked(engine, 'inflight-parent', 'inflight-parent-id');
    const branch = new AbortController();
    const waiter = createWorkflowResultWaiter(internals, 'inflight-child');
    const view = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'inflight-child',
      parentHandle.id,
      branch.signal,
    );
    gating = true;

    waiter.reject(new WorkflowCheckpointConflictError('inflight-child'));
    await yieldToEventLoop();
    branch.abort();
    gate.resolve();
    await yieldToEventLoop();

    await expectPromisePending(view);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
  });

  it('keeps naming the lost child to a later getHandle(parent).result()', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const parentHandle = await startParked(engine, 'named-parent', 'named-parent-id');
    const first = rejectionOf(parentHandle.result());
    const waiter = createWorkflowResultWaiter(internals, 'named-child');
    void getGeneratorOwnedWorkflowResultPromise(internals, 'named-child', parentHandle.id);

    waiter.reject(new WorkflowCheckpointConflictError('named-child'));
    await first;

    const later = await rejectionOf(engine.getHandle(parentHandle.id).result());
    expect(later).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((later as WorkflowCheckpointConflictError).lostChildWorkflowId).toBe('named-child');
    expect((later as WorkflowCheckpointConflictError).message).toContain('workflow "named-child"');
    expect((later as WorkflowCheckpointConflictError).cause).toBeInstanceOf(
      WorkflowCheckpointConflictError,
    );
    expect(
      ((later as WorkflowCheckpointConflictError).cause as WorkflowCheckpointConflictError)
        .workflowId,
    ).toBe('named-child');
  });
});

function rejectionOrNothing(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => value,
    (reason: unknown) => reason,
  );
}

describe('which parents a lost descendant reaches', () => {
  it('leaves a suspended parent alone: a suspension keeps its attempt but it awaits nothing', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const parentHandle = await startParked(engine, 'suspended-parent', 'suspended-parent-id');
    const waiter = createWorkflowResultWaiter(internals, 'suspended-lost-child');
    void getGeneratorOwnedWorkflowResultPromise(internals, 'suspended-lost-child', parentHandle.id);
    await engine.suspend(parentHandle.id);

    waiter.reject(new WorkflowCheckpointConflictError('suspended-lost-child'));
    await yieldToEventLoop();

    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    expect(await readStatus(internals.storage, parentHandle.id)).toBe('suspended');
  });

  it('names the descendant that actually lost through A -> B -> C', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const grandparent = await startParked(engine, 'chain-a', 'chain-a-id');
    const parent = await startParked(engine, 'chain-b', 'chain-b-id');
    const lostWaiter = createWorkflowResultWaiter(internals, 'chain-c-id');
    void getGeneratorOwnedWorkflowResultPromise(internals, 'chain-c-id', parent.id);
    void getGeneratorOwnedWorkflowResultPromise(internals, parent.id, grandparent.id);
    const grandparentOutcome = rejectionOf(grandparent.result());
    const parentOutcome = rejectionOf(parent.result());

    lostWaiter.reject(new WorkflowCheckpointConflictError('chain-c-id'));
    const reason = (await grandparentOutcome) as WorkflowCheckpointConflictError;
    await parentOutcome;

    expect(reason.workflowId).toBe(grandparent.id);
    expect(reason.lostChildWorkflowId).toBe('chain-c-id');
    expect((reason.cause as WorkflowCheckpointConflictError).workflowId).toBe('chain-c-id');
  });
});

describe('parentEligibleForChildConflictAbandonment', () => {
  async function eligibleParent() {
    const engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const handle = await startParked(engine, 'eligible-parent', 'eligible-parent-id');
    const input: ParentAbandonmentEligibilityInput = {
      parentWorkflowId: handle.id,
      parkedAttempt: currentExecutionAttempt(internals, handle.id),
      signal: undefined,
      stillAwaiting: true,
      ownershipConfirmed: true,
    };
    return { engine, internals, handle, input };
  }

  it('holds for a parked, owned, awaiting parent', async () => {
    const { engine, internals, input } = await eligibleParent();
    try {
      expect(parentEligibleForChildConflictAbandonment(internals, input)).toBe(true);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it.each([
    ['the parent held no attempt when it began awaiting', 'no-attempt'],
    ['the engine relaunched the parent since', 'relaunched'],
    ['the parent is already abandoned', 'abandoned'],
    ['the parent is suspended and holds no checkpoint', 'suspended'],
    ['the parent is terminalizing', 'terminalizing'],
    ['the awaiting race branch was aborted', 'aborted'],
    ['the parent no longer awaits this child', 'settled'],
  ])('is false when %s', async (_label, state) => {
    const { engine, internals, handle, input } = await eligibleParent();
    try {
      let probe = input;
      if (state === 'no-attempt') probe = { ...input, parkedAttempt: undefined };
      if (state === 'relaunched') {
        beginExecutionAttempt(internals, handle.id, tokenOf(internals, handle.id));
      }
      if (state === 'abandoned') {
        abandonExecutionAttempt(internals, handle.id, tokenOf(internals, handle.id));
      }
      if (state === 'suspended') await engine.suspend(handle.id);
      if (state === 'terminalizing') internals.terminalizingWorkflows.add(handle.id);
      if (state === 'aborted') probe = { ...input, signal: AbortSignal.abort() };
      if (state === 'settled') probe = { ...input, stillAwaiting: false };
      expect(parentEligibleForChildConflictAbandonment(internals, probe)).toBe(false);
    } finally {
      internals.terminalizingWorkflows.delete(handle.id);
      await engine[Symbol.asyncDispose]();
    }
  });

  it('is false once the engine is disposed', async () => {
    const { engine, internals, input } = await eligibleParent();
    await engine[Symbol.asyncDispose]();
    expect(parentEligibleForChildConflictAbandonment(internals, input)).toBe(false);
  });

  it('requires confirmed ownership only where a claim registry exists', async () => {
    const none = await eligibleParent();
    try {
      expect(
        parentEligibleForChildConflictAbandonment(none.internals, {
          ...none.input,
          ownershipConfirmed: false,
        }),
      ).toBe(true);
    } finally {
      await none.engine[Symbol.asyncDispose]();
    }
    await using leased = await Engine.create({
      storage: new MemoryStorage(),
      ownership: 'workflow-lease',
      workflowClaimTtl: 200,
      workflowClaimRenewInterval: 20,
      recover: false,
    });
    const internals = getInternals(leased);
    const handle = await startParked(leased, 'leased-eligible', 'leased-eligible-id');
    const input: ParentAbandonmentEligibilityInput = {
      parentWorkflowId: handle.id,
      parkedAttempt: currentExecutionAttempt(internals, handle.id),
      signal: undefined,
      stillAwaiting: true,
      ownershipConfirmed: true,
    };
    expect(parentEligibleForChildConflictAbandonment(internals, input)).toBe(true);
    expect(
      parentEligibleForChildConflictAbandonment(internals, { ...input, ownershipConfirmed: false }),
    ).toBe(false);
  });
});

describe('a lost child while the parent is in a state abandonment must not touch', () => {
  it('leaves a parent alone while its ownership read fails', async () => {
    const storage = new MemoryStorage();
    let failing = false;
    const flaky = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        if (property === 'get') {
          return async (key: string) => {
            if (failing && key === KEYS.workflowOwnerHolder('flaky-parent-id')) {
              throw new Error('storage read unavailable');
            }
            return (original as (k: string) => Promise<unknown>).call(target, key);
          };
        }
        return original.bind(target);
      },
    });
    await using engine = await Engine.create({
      storage: flaky,
      ownership: 'workflow-lease',
      workflowClaimTtl: 200,
      workflowClaimRenewInterval: 20,
      recover: false,
    });
    const internals = getInternals(engine);
    const parentHandle = await startParked(engine, 'flaky-parent', 'flaky-parent-id');
    const waiter = createWorkflowResultWaiter(internals, 'flaky-child');
    const view = getGeneratorOwnedWorkflowResultPromise(internals, 'flaky-child', parentHandle.id);
    failing = true;

    waiter.reject(new WorkflowCheckpointConflictError('flaky-child'));
    await yieldToEventLoop();
    failing = false;

    await expectPromisePending(view);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
  });

  it('leaves a parent alone while a terminal outcome is in progress', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const parentHandle = await startParked(engine, 'ending-parent', 'ending-parent-id');
    const waiter = createWorkflowResultWaiter(internals, 'ending-child');
    const view = getGeneratorOwnedWorkflowResultPromise(internals, 'ending-child', parentHandle.id);
    internals.terminalizingWorkflows.add(parentHandle.id);

    waiter.reject(new WorkflowCheckpointConflictError('ending-child'));
    await yieldToEventLoop();
    internals.terminalizingWorkflows.delete(parentHandle.id);

    await expectPromisePending(view);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
  });
});
