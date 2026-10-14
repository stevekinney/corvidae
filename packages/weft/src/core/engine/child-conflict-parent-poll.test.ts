/**
 * A parent awaiting a child its engine lost to a checkpoint compare-and-swap (COR-1426).
 *
 * The loser stops driving the child and writes nothing for it, but the child is healthy under its
 * winner. The parent's view of it becomes a read-only poll of the child's durable state
 * (`child-outcome-poll.ts`), so a parent whose winner drove only the child still settles instead
 * of staying parked forever. If the winner never finishes the child, the parent stays parked.
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
  startParked,
  tokenOf,
  WRITE_METHODS,
  writeOperations,
} from './checkpoint-conflict.test-support.ts';
import { abandonedExecutionAttemptCount, beginExecutionAttempt } from './execution-attempts.ts';
import { getGeneratorOwnedWorkflowResultPromise } from './generator-owned-result.ts';
import { createWorkflowResultWaiter } from './handle-result.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { encodeEpoch, encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

interceptConflictWarnings();

const CHILD_ID = 'poll-child';
const PARENT_ID = 'poll-parent';

function workflows(childFails = false) {
  return {
    'poll-child': workflow({ name: 'poll-child' }).execute(async function* (
      context: WorkflowContext,
    ) {
      const value = yield* context.waitForSignal<string>('go');
      if (childFails) throw new Error('child exploded');
      return value;
    }),
    'poll-parent': workflow({ name: 'poll-parent' }).execute(async function* (
      context: WorkflowContext,
    ) {
      const childResult = yield* context.startChild('poll-child', null, { id: CHILD_ID });
      return `parent saw ${String(childResult)}`;
    }),
  };
}

/** Record the keys of every write, so a test can say what the loser did and did not touch. */
function recordWrittenKeys(base: MemoryStorage) {
  const keys: string[] = [];
  const storage = new Proxy(base, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      const name = String(property);
      if (!WRITE_METHODS.includes(name)) return original.bind(target);
      return (...argumentsList: unknown[]) => {
        const operations = writeOperations(name, argumentsList);
        if (operations !== null) for (const operation of operations) keys.push(operation.key);
        else if (typeof argumentsList[0] === 'string') keys.push(argumentsList[0]);
        return (original as (...a: unknown[]) => unknown).apply(target, argumentsList);
      };
    },
  });
  return { storage, keys };
}

type ScenarioOptions = { manual?: boolean; childFails?: boolean };

/** A loser holding the parent and a child it loses, and a winner that resumed only the child. */
async function lostChildScenario(options: ScenarioOptions = {}) {
  const shared = new MemoryStorage();
  const watched = recordWrittenKeys(shared);
  const loser = await Engine.create({
    storage: watched.storage,
    workflows: workflows(options.childFails),
    recover: false,
    ...(options.manual === true
      ? { backgroundTasks: 'manual' as const, startScheduler: false }
      : {}),
  });
  // Under `ownership: 'none'` the interval is the fixed default; a test shortens it in place.
  getInternals(loser).options.workflowClaimRenewIntervalMs = 10;
  const winner = new Engine({ storage: shared, backgroundTasks: 'manual' });
  for (const definition of Object.values(workflows(options.childFails)))
    winner.register(definition);
  const loserInternals = getInternals(loser);
  const parentHandle = await loser.start('poll-parent', null, { id: PARENT_ID });
  await waitForCondition(() => loserInternals.parkedInlineWorkflows.has(CHILD_ID), {
    label: 'the child parked on the loser',
  });
  const warning = collectConflictWarnings();
  loseGeneration(loserInternals, CHILD_ID);
  await warning.received;
  warning.stop();
  watched.keys.length = 0;

  const finishChildOnWinner = async (): Promise<unknown> => {
    const childOnWinner = await winner.resume(CHILD_ID);
    await waitForCondition(() => getInternals(winner).parkedInlineWorkflows.has(CHILD_ID), {
      label: 'the child parked on the winner',
    });
    await winner.signal(CHILD_ID, 'go', 'done');
    return await childOnWinner.result().then(
      (value) => value,
      (reason: unknown) => reason,
    );
  };
  return {
    shared,
    loser,
    winner,
    loserInternals,
    parentHandle,
    writtenKeys: watched.keys,
    finishChildOnWinner,
    dispose: async () => {
      await winner[Symbol.asyncDispose]();
      await loser[Symbol.asyncDispose]();
    },
  };
}

describe('a parent awaiting a child its engine lost', () => {
  it('completes with the child result the winner made durable, and the loser writes nothing for the child', async () => {
    const scenario = await lostChildScenario();
    try {
      // Observed from the start so a rejection could never go unseen.
      const parentOutcome = scenario.parentHandle.result();
      expect(await scenario.finishChildOnWinner()).toBe('done');

      expect(await parentOutcome).toBe('parent saw done');
      expect(abandonedExecutionAttemptCount(scenario.loserInternals)).toBe(1);
      expect(scenario.writtenKeys.filter((key) => key.includes(CHILD_ID))).toEqual([]);
    } finally {
      await scenario.dispose();
    }
  });

  it("fails with the child's own failure when the child fails on the winner", async () => {
    const scenario = await lostChildScenario({ childFails: true });
    try {
      const parentOutcome = rejectionOf(scenario.parentHandle.result());
      expect(await scenario.finishChildOnWinner()).toBeInstanceOf(Error);

      expect(((await parentOutcome) as Error).message).toContain('child exploded');
    } finally {
      await scenario.dispose();
    }
  });

  it('stays parked, with no error, while the winner never finishes the child', async () => {
    const scenario = await lostChildScenario();
    try {
      const parentOutcome = scenario.parentHandle.result();
      const settled = parentOutcome.then(
        () => 'settled' as const,
        () => 'settled' as const,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      expect(await Promise.race([settled, yieldToEventLoop().then(() => 'pending' as const)])).toBe(
        'pending',
      );
      expect(abandonedExecutionAttemptCount(scenario.loserInternals)).toBe(1);
    } finally {
      await scenario.dispose();
    }
  });

  it('stops polling, and holds no timer, once the engine is disposed', async () => {
    const scenario = await lostChildScenario();
    void scenario.parentHandle.result().catch(() => {});
    await waitForCondition(() => scenario.loserInternals.pendingResultPollTimers.size > 0, {
      label: 'the poll timer armed',
    });

    await scenario.loser[Symbol.asyncDispose]();

    expect(scenario.loserInternals.pendingResultPollTimers.size).toBe(0);
    await scenario.winner[Symbol.asyncDispose]();
  });

  it('settles through runMaintenance when no background timer runs', async () => {
    const scenario = await lostChildScenario({ manual: true });
    try {
      const parentOutcome = scenario.parentHandle.result();
      await yieldToEventLoop();
      expect(scenario.loserInternals.pendingResultPollTimers.size).toBe(0);
      expect(await scenario.finishChildOnWinner()).toBe('done');
      await expectPromisePending(parentOutcome);

      await scenario.loser.runMaintenance();

      expect(await parentOutcome).toBe('parent saw done');
    } finally {
      await scenario.dispose();
    }
  });

  it('recovers through engine.resume(parent) on the loser', async () => {
    const scenario = await lostChildScenario({ manual: true });
    try {
      const resumed = await scenario.loser.resume(PARENT_ID);
      const resumedOutcome = resumed.result();
      expect(await scenario.finishChildOnWinner()).toBe('done');

      await scenario.loser.runMaintenance();

      expect(await resumedOutcome).toBe('parent saw done');
    } finally {
      await scenario.dispose();
    }
  });
});

describe('a parent that no longer awaits the lost child', () => {
  /** A durable terminal child on the winner, and a parked parent on a manual loser. */
  async function parkedParentWithTerminalChild() {
    const storage = new MemoryStorage();
    const loser = await Engine.create({
      storage,
      recover: false,
      backgroundTasks: 'manual',
      startScheduler: false,
    });
    const winner = await Engine.create({
      storage,
      recover: false,
      workflows: {
        'done-child': workflow({ name: 'done-child' }).execute(async function* () {
          return 'durable result';
        }),
      },
    });
    const doneChild = await winner.start('done-child', null, { id: 'done-child-id' });
    await doneChild.result();
    const parent = await startParked(loser, 'quiet-parent', 'quiet-parent-id');
    const internals = getInternals(loser);
    const waiter = createWorkflowResultWaiter(internals, 'done-child-id');
    return { loser, winner, internals, parent, waiter };
  }

  it('stops when the awaiting ctx.race branch was aborted', async () => {
    const { loser, winner, internals, parent, waiter } = await parkedParentWithTerminalChild();
    try {
      const branch = new AbortController();
      const view = getGeneratorOwnedWorkflowResultPromise(
        internals,
        'done-child-id',
        parent.id,
        branch.signal,
      );
      branch.abort();
      waiter.reject(new WorkflowCheckpointConflictError('done-child-id'));
      await yieldToEventLoop();

      await loser.runMaintenance();

      await expectPromisePending(view);
    } finally {
      await winner[Symbol.asyncDispose]();
      await loser[Symbol.asyncDispose]();
    }
  });

  it('stops when this engine no longer holds the parent claim', async () => {
    const storage = new MemoryStorage();
    const winner = await Engine.create({
      storage,
      recover: false,
      workflows: {
        'done-child': workflow({ name: 'done-child' }).execute(async function* () {
          return 'durable result';
        }),
      },
    });
    const doneChild = await winner.start('done-child', null, { id: 'done-child-id' });
    await doneChild.result();
    const loser = await Engine.create({
      storage,
      ownership: 'workflow-lease',
      workflowClaimTtl: 200,
      workflowClaimRenewInterval: 20,
      recover: false,
    });
    try {
      const internals = getInternals(loser);
      const parent = await startParked(loser, 'claimed-parent', 'claimed-parent-id');
      const waiter = createWorkflowResultWaiter(internals, 'done-child-id');
      // A successor holds the parent before the child's conflict is delivered.
      await storage.batch([
        { type: 'put', key: KEYS.workflowOwnerEpoch(parent.id), value: encodeEpoch(99) },
        {
          type: 'put',
          key: KEYS.workflowOwnerHolder(parent.id),
          value: encodeWorkflowClaimHolder({
            engineId: 'successor-engine',
            epoch: 99,
            expiresAt: internals.options.getNow() + 60_000,
            claimedAt: internals.options.getNow(),
          }),
        },
      ]);
      const view = getGeneratorOwnedWorkflowResultPromise(internals, 'done-child-id', parent.id);
      waiter.reject(new WorkflowCheckpointConflictError('done-child-id'));
      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      await expectPromisePending(view);
      expect(internals.pendingResultPollTimers.size).toBe(0);
    } finally {
      await winner[Symbol.asyncDispose]();
      await loser[Symbol.asyncDispose]();
    }
  });

  it('stops when the parent was suspended', async () => {
    const { loser, winner, internals, parent, waiter } = await parkedParentWithTerminalChild();
    try {
      const view = getGeneratorOwnedWorkflowResultPromise(internals, 'done-child-id', parent.id);
      await loser.suspend(parent.id);
      waiter.reject(new WorkflowCheckpointConflictError('done-child-id'));
      await yieldToEventLoop();

      await loser.runMaintenance();

      await expectPromisePending(view);
    } finally {
      await winner[Symbol.asyncDispose]();
      await loser[Symbol.asyncDispose]();
    }
  });

  it('stops when the engine relaunched the parent since it began awaiting', async () => {
    const { loser, winner, internals, parent, waiter } = await parkedParentWithTerminalChild();
    try {
      const view = getGeneratorOwnedWorkflowResultPromise(internals, 'done-child-id', parent.id);
      beginExecutionAttempt(internals, parent.id, tokenOf(internals, parent.id));
      waiter.reject(new WorkflowCheckpointConflictError('done-child-id'));
      await yieldToEventLoop();

      await loser.runMaintenance();

      await expectPromisePending(view);
    } finally {
      await winner[Symbol.asyncDispose]();
      await loser[Symbol.asyncDispose]();
    }
  });

  it('stops while a terminal outcome is in progress for the parent', async () => {
    const { loser, winner, internals, parent, waiter } = await parkedParentWithTerminalChild();
    try {
      const view = getGeneratorOwnedWorkflowResultPromise(internals, 'done-child-id', parent.id);
      internals.terminalizingWorkflows.add(parent.id);
      waiter.reject(new WorkflowCheckpointConflictError('done-child-id'));
      await yieldToEventLoop();

      await loser.runMaintenance();
      internals.terminalizingWorkflows.delete(parent.id);

      await expectPromisePending(view);
    } finally {
      await winner[Symbol.asyncDispose]();
      await loser[Symbol.asyncDispose]();
    }
  });
});
