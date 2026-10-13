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
import {
  abandonedExecutionAttemptCount,
  beginExecutionAttempt,
  isGenerationAbandoned,
} from './execution-attempts.ts';
import { getGeneratorOwnedWorkflowResultPromise } from './generator-owned-result.ts';
import { createWorkflowResultWaiter } from './handle-result.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
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
      expect((reason as WorkflowCheckpointConflictError).message).toContain(`child "${CHILD_ID}"`);
      expect((reason as WorkflowCheckpointConflictError).message).not.toContain(
        'Checkpoint commit for workflow',
      );
      expect(warning.warnings.map((w) => w.lostChildWorkflowId)).toContain(CHILD_ID);
      expect(warning.warnings.at(-1)?.message).toContain('is abandoned because its child');
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
