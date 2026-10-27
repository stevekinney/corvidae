/**
 * COR-1596 — every way a schedule fire's approval can end leaves nothing of it behind.
 *
 * A fire's approval state is in two homes, the session's metadata and this process's maps, and
 * the defect class this file guards surfaced on one path after another (a decision, an expiry,
 * the fire settling, the fire being canceled) because each ending released a different subset. The
 * matrix runs every ending against one assertion, so an ending that forgets a home, or a home
 * added later that an ending forgets, fails here. Each ending is also followed by a restart,
 * because the defect that cost the most was an approval a restart brought back.
 */
import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError } from './create-bureau';
import { OWNER, rpc } from './http/management/management-fixtures.test-support.ts';
import {
  approvalToolbox,
  createScheduleFireHarness,
  durableStatus,
  fireOnce,
  handlerOf,
  pollUntil,
  reviewOf,
  reviewsOf,
} from './schedule-fire-fixtures.test-support';
import { scheduledFireHoldings, scheduledFireReviewStateOf } from './scheduled-fire-review-state';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau } from './types';
import { expireReviews } from './testing/expired-reviews.test-support';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});

const SESSION = 'matrix-session';

const keysOf = (value: unknown): string[] =>
  typeof value === 'object' && value !== null ? Object.keys(value) : [];

/** A fire that leaves one tool approval; `continuing` takes another step with it pending. */
async function fireWithApproval(kind: 'stopped' | 'continuing') {
  const storage = { type: 'sqlite' as const, path: harness.nextDatabasePath() };
  const charges: number[] = [];
  const generate: GenerateFunction = async (context) => {
    if (context.step === 0) {
      return {
        content: '',
        toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
      };
    }
    // The second step of a continuing fire ends only when the fire is canceled.
    return new Promise((_resolve, reject) => {
      context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const options = {
    generate,
    toolbox: approvalToolbox(charges),
    stopWhen:
      kind === 'stopped'
        ? stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls())
        : stopWhen.noToolCalls(),
    storage,
    retention: { tasks: { olderThan: 1 } },
  };
  const bureau = await harness.open(options);
  const { fireId, scheduleId } = await fireOnce(bureau, OWNER.alice, SESSION);
  const review = await reviewOf(bureau, fireId);
  if (kind === 'stopped') {
    await pollUntil(
      async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
      'the fire to end at its approval',
    );
  }
  return { bureau, fireId, scheduleId, review, charges, options };
}

async function sessionKeys(bureau: Bureau) {
  const session = await bureau.getSession(SESSION);
  const metadata = session?.metadata ?? {};
  return {
    overrides: keysOf(metadata['pendingApprovalOverrides']),
    rounds: keysOf(metadata['pendingApprovalRounds']),
    authorities: keysOf(metadata['lastRequestAuthorities']),
  };
}

/** Nothing of the fire's approval is in either home, in this process or in the next. */
async function expectNothingRemains(
  bureau: Bureau,
  fireId: string,
  options: Parameters<typeof harness.open>[0],
) {
  const state = scheduledFireReviewStateOf(bureau);
  await pollUntil(
    () => (scheduledFireHoldings(state, fireId).length === 0 ? true : undefined),
    `the in-memory homes to release the fire (${scheduledFireHoldings(state, fireId).join(', ')})`,
  );
  expect(reviewsOf(bureau, fireId)).toEqual([]);
  const inbox = await rpc(handlerOf(bureau), 'bureau.reviews.list', {}, 'alice-key');
  expect(inbox.result?.['reviews']).toEqual([]);
  expect(await sessionKeys(bureau)).toEqual({ overrides: [], rounds: [], authorities: [] });

  // A restart finds nothing to bring back, and nothing to run.
  const restartedCharges: number[] = [];
  const restarted = await harness.open({
    ...options,
    toolbox: approvalToolbox(restartedCharges),
  });
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(reviewsOf(restarted, fireId)).toEqual([]);
  expect(scheduledFireHoldings(scheduledFireReviewStateOf(restarted), fireId)).toEqual([]);
  expect(restartedCharges).toEqual([]);
}

const stopped = {
  approved: async ({ bureau, review }: Context) => {
    await bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: OWNER.alice });
  },
  denied: async ({ bureau, review }: Context) => {
    await bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: OWNER.alice });
  },
  expired: async ({ bureau }: Context) => {
    expect(await expireReviews(bureau, Date.now() + 60 * 60 * 1000)).toBe(1);
  },
  'removed with its task, the approval expired but not swept': async ({
    bureau,
    fireId,
  }: Context) => {
    // Expired at read time, so the listing no longer holds the task open for it.
    const state = scheduledFireReviewStateOf(bureau);
    for (const [id, approval] of state.pendingApprovalOverrides) {
      if (approval.approvalBinding !== undefined) {
        state.pendingApprovalOverrides.set(id, {
          ...approval,
          approvalBinding: { ...approval.approvalBinding, expiresAt: 0 },
        });
      }
    }
    await pollUntil(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await bureau.runDurableMaintenance(Date.now());
      return (await bureau.internals.taskRegistry.record(fireId)) === undefined ? true : undefined;
    }, 'the fire’s task to leave retention');
  },
};

const continuing = {
  'canceled through its task': async ({ bureau, fireId }: Context) => {
    const canceled = await rpc(
      handlerOf(bureau),
      'bureau.tasks.cancel',
      { taskId: fireId },
      'alice-key',
    );
    expect(canceled.error).toBeUndefined();
  },
  'canceled as a durable run': async ({ bureau, fireId }: Context) => {
    const outcome = await bureau.cancelDurableRun(fireId);
    expect(outcome.status).toBe('requested');
  },
  'canceled in the engine, by a route Bureau did not take': async ({ bureau, fireId }: Context) => {
    await bureau.durableEngine()?.cancel(fireId);
  },
};

type Context = Awaited<ReturnType<typeof fireWithApproval>>;

describe('every ending of a fire’s approval leaves nothing of it behind', () => {
  for (const [ending, end] of Object.entries(stopped)) {
    it(`when the approval is ${ending}`, async () => {
      const context = await fireWithApproval('stopped');

      await end(context);

      await expectNothingRemains(context.bureau, context.fireId, context.options);
    });
  }

  for (const [ending, end] of Object.entries(continuing)) {
    it(`when the fire is ${ending}`, async () => {
      const context = await fireWithApproval('continuing');

      await end(context);

      await pollUntil(
        async () =>
          (await durableStatus(context.bureau, context.fireId)) === 'cancelled' ||
          (await durableStatus(context.bureau, context.fireId)) === 'canceled'
            ? true
            : undefined,
        'the fire to end canceled',
      );
      await expectNothingRemains(context.bureau, context.fireId, context.options);
      expect(context.charges).toEqual([]);
    });
  }

  it('keeps the approval when only the schedule is canceled, which ends no fire', async () => {
    const context = await fireWithApproval('stopped');

    expect(await context.bureau.cancelSchedule(context.scheduleId)).toBe(true);

    expect(reviewsOf(context.bureau, context.fireId)).toHaveLength(1);
    expect(await sessionKeys(context.bureau)).toMatchObject({
      overrides: [context.review.id],
      authorities: [context.fireId],
    });
  });
});

describe('a fire with several approvals', () => {
  async function fireWithTwoApprovals() {
    const storage = { type: 'sqlite' as const, path: harness.nextDatabasePath() };
    const charges: number[] = [];
    const generate: GenerateFunction = async (context) =>
      context.step === 0
        ? {
            content: '',
            toolCalls: [
              { id: 'charge-A', name: 'charge-card', arguments: { cents: 100 } },
              { id: 'charge-B', name: 'charge-card', arguments: { cents: 200 } },
            ],
          }
        : { content: 'done', toolCalls: [] };
    const options = {
      generate,
      toolbox: approvalToolbox(charges),
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
      storage,
    };
    const bureau = await harness.open(options);
    const { fireId } = await fireOnce(bureau, OWNER.alice, SESSION);
    await pollUntil(
      () => (reviewsOf(bureau, fireId).length === 2 ? true : undefined),
      'both approvals to be listed',
    );
    return { bureau, fireId, charges, options };
  }

  it('does not release a sibling that expired but was not swept when the other is decided', async () => {
    const { bureau, fireId, charges, options } = await fireWithTwoApprovals();
    const expiredId = `approval:${fireId}:charge-A`;
    const state = scheduledFireReviewStateOf(bureau);
    const approval = state.pendingApprovalOverrides.get(expiredId);
    if (approval?.approvalBinding === undefined) throw new Error('expected a bound approval');
    // Expired at read time: the listing drops it, though nothing has swept it yet.
    state.pendingApprovalOverrides.set(expiredId, {
      ...approval,
      approvalBinding: { ...approval.approvalBinding, expiresAt: 0 },
    });
    expect(reviewsOf(bureau, fireId).map((review) => review.id)).toEqual([
      `approval:${fireId}:charge-B`,
    ]);

    await bureau.reviews.resolve({
      id: `approval:${fireId}:charge-B`,
      decision: 'approve',
      principal: OWNER.alice,
    });

    expect(charges).toEqual([200]);
    // The expired sibling is still held, in memory and in the session, for the sweep to find.
    expect(scheduledFireHoldings(state, fireId)).toContain('pendingApprovalOverrides');
    expect(await sessionKeys(bureau)).toMatchObject({
      overrides: [expiredId],
      authorities: [fireId],
    });

    expect(await expireReviews(bureau, Date.now())).toBe(1);

    await expectNothingRemains(bureau, fireId, options);
    expect(charges).toEqual([200]);
  });

  it('lists each approval of a fire that continues at its own request time', async () => {
    const storage = { type: 'sqlite' as const, path: harness.nextDatabasePath() };
    const generate: GenerateFunction = async (context) => {
      if (context.step === 0) {
        return {
          content: '',
          toolCalls: [{ id: 'charge-A', name: 'charge-card', arguments: { cents: 100 } }],
        };
      }
      if (context.step === 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          content: '',
          toolCalls: [{ id: 'charge-B', name: 'charge-card', arguments: { cents: 200 } }],
        };
      }
      return { content: 'done', toolCalls: [] };
    };
    const bureau = await harness.open({
      storage,
      agents: {
        default: createAgent({
          generate,
          toolbox: approvalToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, SESSION);
    // The second approval is a real delay behind the first, which a count of turns does not span.
    await pollUntil(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return reviewsOf(bureau, fireId).length === 2 ? true : undefined;
    }, 'both approvals to be listed');

    const requestedAt = Object.fromEntries(
      reviewsOf(bureau, fireId).map((review) => [review.id, review.requestedAt]),
    );
    const first = requestedAt[`approval:${fireId}:charge-A`] ?? 0;
    const second = requestedAt[`approval:${fireId}:charge-B`] ?? 0;

    expect(second - first).toBeGreaterThanOrEqual(50);
  });
});

const decoder = new TextDecoder();
/** The text a storage call carries, whichever of strings and bytes its keys and values are. */
function storedText(value: unknown): string {
  if (value instanceof Uint8Array) return decoder.decode(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(storedText).join(' ');
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).map(storedText).join(' ');
  }
  return '';
}

/** A continuing fire with a committed approval, over storage whose prune can be held for good. */
async function fireForCrash() {
  let armed = false;
  let held = false;
  const reached = Promise.withResolvers<void>();
  const raw = new MemoryStorage();
  const holdingStorage = new Proxy(raw, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== 'function' || typeof property !== 'string') return member;
      return (...args: unknown[]) => {
        const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
        if (property !== 'conditionalBatch' || held || !armed) return call();
        if (storedText(args).includes('pendingApprovalOverrides')) {
          held = true;
          reached.resolve();
          return new Promise(() => {});
        }
        return call();
      };
    },
  });
  const generate: GenerateFunction = async (context) => {
    if (context.step === 0) {
      return {
        content: '',
        toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
      };
    }
    return new Promise((_resolve, reject) => {
      context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const options = { generate, stopWhen: stopWhen.noToolCalls() };
  const first = await harness.open({
    ...options,
    storage: holdingStorage,
    toolbox: approvalToolbox([]),
  });
  const { fireId } = await fireOnce(first, OWNER.alice, SESSION);
  await reviewOf(first, fireId);
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  return {
    first,
    fireId,
    options,
    raw,
    /** The cancel is issued and the first process dies at the prune of the approval. */
    async cancelAndCrash(cancel: () => void) {
      armed = true;
      cancel();
      await Promise.race([reached.promise, new Promise((resolve) => setTimeout(resolve, 3000))]);
      expect(held).toBe(true);
    },
  };
}

describe('a crash between a fire’s cancel and the release of its approval', () => {
  const routes = {
    'canceled through its task, crashed before the release': (first: Bureau, fireId: string) => {
      void rpc(handlerOf(first), 'bureau.tasks.cancel', { taskId: fireId }, 'alice-key');
    },
    'canceled as a durable run, crashed before the release': (first: Bureau, fireId: string) => {
      void first.cancelDurableRun(fireId);
    },
    'canceled in the engine, crashed before the release': (first: Bureau, fireId: string) => {
      void first.durableEngine()?.cancel(fireId);
    },
  };

  for (const [name, cancel] of Object.entries(routes)) {
    it(name, async () => {
      const crash = await fireForCrash();
      await crash.cancelAndCrash(() => cancel(crash.first, crash.fireId));
      expect(await durableStatus(crash.first, crash.fireId)).toBe('cancelled');

      // The next process: the engine says the fire was canceled, so the approval is not restored.
      const charges: number[] = [];
      const restarted = await harness.open({
        ...crash.options,
        storage: crash.raw,
        toolbox: approvalToolbox(charges),
      });
      for (let turn = 0; turn < 50; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      expect(reviewsOf(restarted, crash.fireId)).toEqual([]);
      await pollUntil(
        () =>
          scheduledFireHoldings(scheduledFireReviewStateOf(restarted), crash.fireId).length === 0
            ? true
            : undefined,
        'the restarted Bureau to hold nothing of the fire',
      );
      expect(await sessionKeys(restarted)).toEqual({ overrides: [], rounds: [], authorities: [] });
      expect(charges).toEqual([]);
    });
  }
});

describe('a cancel by a peer, with the holder alive', () => {
  it('canceled by a peer while this process holds it', async () => {
    const storage = { type: 'sqlite' as const, path: harness.nextDatabasePath() };
    const holderCharges: number[] = [];
    const generate: GenerateFunction = async (context) => {
      if (context.step === 0) {
        return {
          content: '',
          toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
        };
      }
      return new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    };
    const options = {
      generate,
      stopWhen: stopWhen.noToolCalls(),
      storage,
      durableOwnership: { ownership: 'workflow-lease' as const },
    };
    const holder = await harness.open({
      ...options,
      toolbox: approvalToolbox(holderCharges),
    });
    const { fireId } = await fireOnce(holder, OWNER.alice, SESSION);
    const review = await reviewOf(holder, fireId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const peer = await harness.open({
      ...options,
      toolbox: approvalToolbox([]),
    });

    const outcome = await peer.cancelDurableRun(fireId);
    expect(outcome.status).toBe('requested');
    await pollUntil(
      async () => ((await durableStatus(peer, fireId)) === 'cancelled' ? true : undefined),
      'the engine to record the cancel',
    );

    // No restart: the holder still has the approval in memory, and the engine says canceled.
    const refusal = await rejectionOf(
      holder.reviews.resolve({ id: review.id, decision: 'approve', principal: OWNER.alice }),
    );

    expect((refusal as BureauError).code).toBe('CONFLICT');
    expect(holderCharges).toEqual([]);
    await pollUntil(
      () => (reviewsOf(holder, fireId).length === 0 ? true : undefined),
      'the holder to list nothing',
    );
    expect(scheduledFireHoldings(scheduledFireReviewStateOf(holder), fireId)).toEqual([]);
  });
});

describe('a restart keeps what the engine did not cancel', () => {
  it('boot keeps a completed fire’s committed approval', async () => {
    const context = await fireWithApproval('stopped');

    const charges: number[] = [];
    const restarted = await harness.open({
      ...context.options,
      toolbox: approvalToolbox(charges),
    });
    const restored = await reviewOf(restarted, context.fireId);
    await restarted.reviews.resolve({
      id: restored.id,
      decision: 'approve',
      principal: OWNER.alice,
    });

    expect(restored.id).toBe(context.review.id);
    expect(charges).toEqual([4242]);
  });

  it('boot keeps a failed fire’s committed approval', async () => {
    const storage = { type: 'sqlite' as const, path: harness.nextDatabasePath() };
    const generate: GenerateFunction = async (context) => {
      if (context.step === 0) {
        return {
          content: '',
          toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
        };
      }
      throw new Error('the provider is down after the approval');
    };
    const diagnostics: string[] = [];
    const options = {
      generate,
      stopWhen: stopWhen.noToolCalls(),
      storage,
      onDiagnostic: (diagnostic: { message: string }) => diagnostics.push(diagnostic.message),
    };
    const bureau = await harness.open({
      ...options,
      toolbox: approvalToolbox([]),
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, SESSION);
    await reviewOf(bureau, fireId);
    await pollUntil(async () => {
      const status = await durableStatus(bureau, fireId);
      return status !== undefined && !['pending', 'running', 'suspended'].includes(status)
        ? status
        : undefined;
    }, 'the fire to end after its approval');

    const charges: number[] = [];
    const restarted = await harness.open({
      ...options,
      toolbox: approvalToolbox(charges),
    });
    const restored = await reviewOf(restarted, fireId);
    await restarted.reviews.resolve({
      id: restored.id,
      decision: 'approve',
      principal: OWNER.alice,
    });

    expect(charges).toEqual([4242]);
  });
});

describe('a boot that cannot read the engine’s status', () => {
  it('restores nothing and prunes nothing, says so once, and a later boot lists the approval', async () => {
    const raw = new MemoryStorage();
    const generate: GenerateFunction = async (context) =>
      context.step === 0
        ? {
            content: '',
            toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
          }
        : { content: 'done', toolCalls: [] };
    const options = {
      generate,
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
    };
    const first = await harness.open({
      ...options,
      storage: raw,
      toolbox: approvalToolbox([]),
    });
    const { fireId } = await fireOnce(first, OWNER.alice, SESSION);
    const review = await reviewOf(first, fireId);
    await pollUntil(
      async () => ((await durableStatus(first, fireId)) === 'completed' ? true : undefined),
      'the fire to end at its approval',
    );

    // The same storage, with the fire's workflow record failing to read while `unreadable`.
    let unreadable = true;
    const diagnostics: string[] = [];
    const faultyStorage = new Proxy(raw, {
      get(target, property) {
        const member = Reflect.get(target, property, target) as unknown;
        if (typeof member !== 'function' || typeof property !== 'string') return member;
        return (...args: unknown[]) => {
          if (property === 'get' && unreadable && args[0] === `wf:${fireId}`) {
            return Promise.reject(new Error('the engine record is unreadable'));
          }
          return (member as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const faulty = await harness.open({
      ...options,
      storage: faultyStorage,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      toolbox: approvalToolbox([]),
    });
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));

    expect(reviewsOf(faulty, fireId)).toEqual([]);
    expect(await sessionKeys(faulty)).toMatchObject({ overrides: [review.id] });
    expect(diagnostics.filter((message) => message.includes('engine status'))).toHaveLength(1);

    unreadable = false;
    const later = await harness.open({
      ...options,
      storage: raw,
      toolbox: approvalToolbox([]),
    });
    const restored = await reviewOf(later, fireId);
    expect(restored.id).toBe(review.id);
  });
});
