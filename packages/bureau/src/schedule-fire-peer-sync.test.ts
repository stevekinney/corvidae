/**
 * COR-1621 — instances sharing the stores keep each schedule fire's reviews in step with no client
 * stream open: a peer's decision or expiry drops this instance's copy, a re-gate leaves the next
 * round listed, a decision on a stale round is refused, a close that fails to read durable state is
 * retried, and one canceled review is recorded once.
 *
 * Every test runs two Bureaus on one SQLite store under `workflow-lease` ownership, so each holds
 * the fires it started and sees the other's only through durable state.
 */
import {
  type GenerateFunction,
  stopWhen,
  type Toolbox,
  createAgent,
} from '@lostgradient/operative';
import type { Storage } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BureauError } from './create-bureau';
import {
  OWNER,
  readFrames,
  subscribeRequest,
} from './http/management/management-fixtures.test-support.ts';
import {
  approvalToolbox,
  askingGenerate,
  auditRecordsOf,
  chargesOnce,
  createScheduleFireHarness,
  durableStatus,
  fireOnce,
  handlerOf,
  historyKinds,
  holdingWrites,
  reviewOf,
  reviewsOf,
  storedText,
} from './schedule-fire-fixtures.test-support';
import { fireReviewFollowerOf } from './fire-review-follower';
import { scheduledFireReviewStateOf } from './scheduled-fire-review-state';
import type { DefaultAgentFields } from './testing/default-agent.test-support';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau, BureauOptions, PendingToolApprovalReview } from './types';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});

/** A renewal interval short enough that the holder hears a peer promptly. */
const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const stopAtApproval = stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls());
const peerOptions = {
  generate: chargesOnce,
  stopWhen: stopAtApproval,
  durableOwnership: OWNERSHIP,
  durableBackgroundTasks: 'automatic' as const,
};

/** Waits, in real time, for a condition another process's write has to reach this one. */
async function eventually<T>(
  check: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 3_500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Condition was not met: ${what}`);
    await sleep(10);
  }
}

/**
 * A tool whose approval reads as a new one whenever `gate.revision` changes (the resumed call is
 * then gated again, as a policy that changed would gate it), and which counts its runs.
 */
function switchedToolbox(charges: number[], gate: { revision: number }): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret: 'schedule-fire-reviews-secret',
      policy: {
        beforeExecute: (context) => {
          if (context.toolName !== 'charge-card') return { status: 'allow' };
          return {
            allow: false,
            status: 'needs_approval',
            reason: `Operator approval required (revision ${gate.revision})`,
            action: { message: 'Approve charge' },
          };
        },
      },
    },
  ) as unknown as Toolbox;
}

async function settleAtApproval(bureau: Bureau, fireId: string): Promise<void> {
  await eventually(
    async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
    'the fire to end at its approval',
  );
}

/** A fire that settled holding a pending approval, and a peer that restored it from the session. */
async function holderAndPeer(
  toolboxes: { holder: Toolbox; peer: Toolbox },
  sessionId: string,
  wrapHolder: (storage: Storage) => Storage = (storage) => storage,
  holderOptions: Partial<BureauOptions> & DefaultAgentFields = {},
) {
  const path = harness.nextDatabasePath();
  const holder = await harness.open({
    ...peerOptions,
    ...holderOptions,
    storage: await harness.sqliteStorage(path, wrapHolder),
    toolbox: toolboxes.holder,
  });
  const { fireId } = await fireOnce(holder, OWNER.alice, sessionId);
  const review = (await reviewOf(holder, fireId)) as PendingToolApprovalReview;
  await settleAtApproval(holder, fireId);
  const peer = await harness.open({
    ...peerOptions,
    storage: await harness.sqliteStorage(path),
    toolbox: toolboxes.peer,
  });
  await reviewOf(peer, fireId);
  return { holder, peer, fireId, review };
}

describe('a fire review a peer closes, with no stream open', () => {
  it('drops the review from the holder once its history subscription delivers the decision', async () => {
    const peerCharges: number[] = [];
    const { holder, peer, fireId, review } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox(peerCharges) },
      'peer-sync-decided',
    );
    expect(reviewsOf(holder, fireId)).toHaveLength(1);

    await peer.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });

    await eventually(
      () => (reviewsOf(holder, fireId).length === 0 ? true : undefined),
      'the holder to drop the decided review',
    );
    expect(peerCharges).toEqual([4242]);
  });

  it('drops the review from the holder when a peer’s sweep expires it', async () => {
    const { holder, peer, fireId } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox([]) },
      'peer-sync-expired',
    );

    expect(await peer.sweepExpiredReviews(Date.now() + 60 * 60 * 1000)).toBe(1);

    await eventually(
      () => (reviewsOf(holder, fireId).length === 0 ? true : undefined),
      'the holder to drop the expired review',
    );
  });

  it('keeps round 1 listed on the holder when the peer re-gates the approval', async () => {
    const peerGate = { revision: 1 };
    const { holder, peer, fireId, review } = await holderAndPeer(
      { holder: switchedToolbox([], { revision: 1 }), peer: switchedToolbox([], peerGate) },
      'peer-sync-regated',
    );
    peerGate.revision = 2;

    const outcome = await peer.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
    });
    expect(outcome.superseded).toBe(true);

    // The holder is told of the round's approval, finds the session still holding the review, and
    // lists the next round rather than the stale one or none.
    const listed = await eventually(() => {
      const [only] = reviewsOf(holder, fireId) as PendingToolApprovalReview[];
      return only?.round === 1 ? only : undefined;
    }, 'the holder to list round 1');
    expect(listed.id).toBe(review.id);
    await sleep(300);
    expect(reviewsOf(holder, fireId).map((listed) => listed.id)).toEqual([review.id]);
  });
});

describe('the fires a Bureau follows', () => {
  it('are the fires it holds a review of, added when one is announced or restored and dropped with the last', async () => {
    const { holder, peer, fireId, review } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox([]) },
      'peer-sync-followed',
    );

    // The holder announced the review and the peer restored it: each follows the fire.
    expect(fireReviewFollowerOf(holder).followed()).toEqual([fireId]);
    expect(fireReviewFollowerOf(peer).followed()).toEqual([fireId]);

    await peer.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });

    // The peer released its last review itself; the holder dropped its copy when it heard.
    expect(fireReviewFollowerOf(peer).followed()).toEqual([]);
    await eventually(
      () => (fireReviewFollowerOf(holder).followed().length === 0 ? true : undefined),
      'the holder to stop following the fire',
    );
  });

  it('are read again from durable state, so a missed event does not strand a review', async () => {
    const { holder, peer, fireId, review } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox([]) },
      'peer-sync-missed',
    );
    // The holder stops following, as if its subscription had been closed before the decision.
    fireReviewFollowerOf(holder).unfollow(fireId);
    await peer.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
    await sleep(300);
    expect(reviewsOf(holder, fireId)).toHaveLength(1);

    // Following it again reads the history the subscription had not.
    fireReviewFollowerOf(holder).follow(fireId);
    await eventually(
      () => (reviewsOf(holder, fireId).length === 0 ? true : undefined),
      'the holder to drop the decided review once it follows the fire again',
    );
  });
});

describe('a fire read again from durable state', () => {
  it('drops a review the session records as decided by a peer', async () => {
    const { holder, peer, fireId, review } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox([]) },
      'peer-sync-reread-decided',
    );
    fireReviewFollowerOf(holder).unfollow(fireId);
    await peer.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
    expect(reviewsOf(holder, fireId)).toHaveLength(1);

    await fireReviewFollowerOf(holder).reread(fireId);

    expect(reviewsOf(holder, fireId)).toHaveLength(0);
  });

  it('lists the round the session holds when a peer re-gated the approval', async () => {
    const peerGate = { revision: 1 };
    const { holder, peer, fireId, review } = await holderAndPeer(
      { holder: switchedToolbox([], { revision: 1 }), peer: switchedToolbox([], peerGate) },
      'peer-sync-reread-regated',
    );
    fireReviewFollowerOf(holder).unfollow(fireId);
    peerGate.revision = 2;
    await peer.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
    expect((reviewsOf(holder, fireId) as PendingToolApprovalReview[])[0]?.round).toBe(0);

    await fireReviewFollowerOf(holder).reread(fireId);

    const [listed] = reviewsOf(holder, fireId) as PendingToolApprovalReview[];
    expect(listed?.id).toBe(review.id);
    expect(listed?.round).toBe(1);
  });
});

describe('a decision on a stale round', () => {
  it('is refused with CONFLICT, the session keeps round 1, and the tool does not run', async () => {
    const holderCharges: number[] = [];
    const peerGate = { revision: 1 };
    const { holder, peer, fireId, review } = await holderAndPeer(
      {
        holder: switchedToolbox(holderCharges, { revision: 1 }),
        peer: switchedToolbox([], peerGate),
      },
      'peer-sync-stale-round',
    );
    // The test does not depend on the holder's subscription: it never hears the re-gate.
    fireReviewFollowerOf(holder).unfollow(fireId);
    peerGate.revision = 2;
    const outcome = await peer.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
    });
    expect(outcome.superseded).toBe(true);
    // The holder's own policy has not changed, so it would run the call: only the round fences it.
    const before = (reviewsOf(holder, fireId) as PendingToolApprovalReview[])[0];
    expect(before?.round).toBe(0);

    const refusal = await rejectionOf(
      holder.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice }),
    );

    expect(refusal).toBeInstanceOf(BureauError);
    expect((refusal as BureauError).code).toBe('CONFLICT');
    expect(holderCharges).toEqual([]);
    const session = await peer.getSession('peer-sync-stale-round');
    expect(session?.metadata['pendingApprovalRounds']).toEqual({ [review.id]: 1 });
    expect(Object.keys(session?.metadata['pendingApprovalOverrides'] as object)).toEqual([
      review.id,
    ]);
    // The refusal refreshed the holder, which now offers the round the session holds.
    const after = (reviewsOf(holder, fireId) as PendingToolApprovalReview[])[0];
    expect(after?.round).toBe(1);
  });
});

describe('a canceled fire review recorded by two Bureaus at once', () => {
  it('leaves one audit record and one history event for the round', async () => {
    const continuing: GenerateFunction = async (context) => {
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
    const path = harness.nextDatabasePath();
    const holdHolder = holdingWrites('review.tool-approval.canceled');
    const holdPeer = holdingWrites('review.tool-approval.canceled');
    harness.onDispose(() => {
      holdHolder.release();
      holdPeer.release();
    });
    const options = {
      ...peerOptions,
      generate: continuing,
      stopWhen: stopWhen.noToolCalls(),
    };
    const holder = await harness.open({
      ...options,
      storage: await harness.sqliteStorage(path, (storage) => holdHolder.wrap(storage)),
      toolbox: approvalToolbox([]),
    });
    const { fireId } = await fireOnce(holder, OWNER.alice, 'peer-sync-cancel');
    const review = await reviewOf(holder, fireId);
    const peer = await harness.open({
      ...options,
      storage: await harness.sqliteStorage(path, (storage) => holdPeer.wrap(storage)),
      toolbox: approvalToolbox([]),
    });
    await reviewOf(peer, fireId);
    holdHolder.arm();
    holdPeer.arm();

    // The engine records the cancel once. The holder closes the review as the fire ends; the peer
    // reads the cancel from the engine when it is asked to decide the review.
    void holder.durableEngine()?.cancel(fireId);
    void peer
      .resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice })
      .catch(() => undefined);
    await Promise.all([
      Promise.race([holdHolder.reached, sleep(5_000)]),
      Promise.race([holdPeer.reached, sleep(5_000)]),
    ]);
    expect(holdHolder.held).toBe(true);
    expect(holdPeer.held).toBe(true);
    holdHolder.release();
    holdPeer.release();
    await eventually(async () => {
      const records = await auditRecordsOf(holder, fireId, 'review.tool-approval.canceled');
      return records.length > 0 ? true : undefined;
    }, 'the canceled review to be recorded');
    await sleep(400);

    expect(
      await auditRecordsOf(holder, fireId, 'review.tool-approval.canceled', review.id),
    ).toHaveLength(1);
    const kinds = await historyKinds(holder, fireId);
    expect(kinds.filter((kind) => kind === 'review.canceled')).toHaveLength(1);
  });
});

describe('a canceled review an earlier build recorded without the deduplication key', () => {
  it('is found closed, so the cancel records nothing more for its round', async () => {
    const continuing: GenerateFunction = async (context) => {
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
    const bureau = await harness.open({
      ...peerOptions,
      storage: await harness.sqliteStorage(harness.nextDatabasePath()),
      agents: {
        default: createAgent({
          generate: continuing,
          stopWhen: stopWhen.noToolCalls(),
          toolbox: approvalToolbox([]),
        }),
      },
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, 'peer-sync-unkeyed');
    const review = (await reviewOf(bureau, fireId)) as PendingToolApprovalReview;
    // What a build before the key wrote: the round's canceled record, with no `dedupeKey`.
    await bureau.auditTrail?.record({
      runId: fireId,
      type: 'review.tool-approval.canceled',
      detail: { review: { ...review, status: 'canceled' }, status: 'canceled' },
      principal: 'system:run-abort',
    });

    void bureau.durableEngine()?.cancel(fireId);
    await eventually(async () => {
      const closed = (await durableStatus(bureau, fireId)) === 'cancelled';
      return closed ? true : undefined;
    }, 'the fire to be canceled');
    await sleep(500);

    const records = await auditRecordsOf(
      bureau,
      fireId,
      'review.tool-approval.canceled',
      review.id,
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.principal).toBe('system:run-abort');
  });
});

describe('a decision whose round advances while its claim is being made', () => {
  it('is refused with CONFLICT once the claim is held, the tool does not run, and the peer’s round survives', async () => {
    const holderCharges: number[] = [];
    const hold = holdingWrites('review-decision:v1:');
    harness.onDispose(() => hold.release());
    const peerGate = { revision: 1 };
    const { holder, peer, fireId, review } = await holderAndPeer(
      {
        holder: switchedToolbox(holderCharges, { revision: 1 }),
        peer: switchedToolbox([], peerGate),
      },
      'peer-sync-claim-race',
      (storage) => hold.wrap(storage),
    );
    // The holder reads the session at round 0, then its claim is held at the write.
    fireReviewFollowerOf(holder).unfollow(fireId);
    hold.arm();
    const deciding = rejectionOf(
      holder.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice }),
    );
    await Promise.race([hold.reached, sleep(3_000)]);
    expect(hold.held).toBe(true);

    // The peer re-gates the approval and gives up its claim of round 0 while the holder waits.
    peerGate.revision = 2;
    const outcome = await peer.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
    });
    expect(outcome.superseded).toBe(true);
    hold.release();
    const refusal = await deciding;

    expect((refusal as BureauError).code).toBe('CONFLICT');
    expect(holderCharges).toEqual([]);
    const session = await peer.getSession('peer-sync-claim-race');
    expect(session?.metadata['pendingApprovalRounds']).toEqual({ [review.id]: 1 });
    expect(Object.keys(session?.metadata['pendingApprovalOverrides'] as object)).toEqual([
      review.id,
    ]);
    // The refusal released the claim: the round the peer left can be claimed by no one, and the
    // holder now lists the round the session holds.
    expect((reviewsOf(holder, fireId) as PendingToolApprovalReview[])[0]?.round).toBe(1);
  });
});

describe('the binding of a re-gated round', () => {
  it('is restored before the round is adopted, so a restore that fails is tried again', async () => {
    const peerGate = { revision: 1 };
    const { holder, peer, fireId, review } = await holderAndPeer(
      { holder: switchedToolbox([], { revision: 1 }), peer: switchedToolbox([], peerGate) },
      'peer-sync-restore-order',
    );
    fireReviewFollowerOf(holder).unfollow(fireId);
    const toolbox = scheduledFireReviewStateOf(holder).runToolboxesByRunId.get(
      fireId,
    ) as unknown as {
      restoreApproval: (approval: unknown) => Promise<void>;
    };
    const restore = toolbox.restoreApproval.bind(toolbox);
    const attempts = { failNext: true, restored: 0 };
    toolbox.restoreApproval = async (approval) => {
      if (attempts.failNext) {
        attempts.failNext = false;
        throw new Error('the approval store is unavailable');
      }
      attempts.restored += 1;
      await restore(approval);
    };
    peerGate.revision = 2;
    await peer.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });

    const failure = await rejectionOf(fireReviewFollowerOf(holder).reread(fireId));
    expect((failure as Error).message).toContain('unavailable');
    // The round was not adopted, so it is still the one the holder lists.
    expect((reviewsOf(holder, fireId) as PendingToolApprovalReview[])[0]?.round).toBe(0);

    await fireReviewFollowerOf(holder).reread(fireId);

    expect(attempts.restored).toBe(1);
    expect((reviewsOf(holder, fireId) as PendingToolApprovalReview[])[0]?.round).toBe(1);
  });
});

describe('a fire read again with one review that cannot be restored', () => {
  it('still refreshes the fire’s other reviews, and then fails the read', async () => {
    const twoCharges: GenerateFunction = async (context) =>
      context.step === 0
        ? {
            content: '',
            toolCalls: [
              { id: 'charge-1', name: 'charge-card', arguments: { cents: 4242 } },
              { id: 'charge-2', name: 'charge-card', arguments: { cents: 4243 } },
            ],
          }
        : { content: 'charged', toolCalls: [] };
    const peerGate = { revision: 1 };
    const { holder, peer, fireId } = await holderAndPeer(
      { holder: switchedToolbox([], { revision: 1 }), peer: switchedToolbox([], peerGate) },
      'peer-sync-partial-reread',
      (storage) => storage,
      { generate: twoCharges },
    );
    await eventually(
      () => (reviewsOf(holder, fireId).length === 2 ? true : undefined),
      'both approvals to be listed on the holder',
    );
    await eventually(
      () => (reviewsOf(peer, fireId).length === 2 ? true : undefined),
      'both approvals to be listed on the peer',
    );
    fireReviewFollowerOf(holder).unfollow(fireId);
    peerGate.revision = 2;
    for (const review of reviewsOf(peer, fireId)) {
      const outcome = await peer.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: OWNER.alice,
      });
      expect(outcome.superseded).toBe(true);
    }
    const toolbox = scheduledFireReviewStateOf(holder).runToolboxesByRunId.get(
      fireId,
    ) as unknown as { restoreApproval: (approval: unknown) => Promise<void> };
    const restore = toolbox.restoreApproval.bind(toolbox);
    let failNext = true;
    toolbox.restoreApproval = async (approval) => {
      if (failNext) {
        failNext = false;
        throw new Error('the approval store is unavailable');
      }
      await restore(approval);
    };
    const roundsOf = () =>
      (reviewsOf(holder, fireId) as PendingToolApprovalReview[]).map((review) => review.round);

    const failure = await rejectionOf(fireReviewFollowerOf(holder).reread(fireId));

    expect((failure as Error).message).toContain('unavailable');
    // One approval could not be restored, and the other was refreshed all the same.
    expect(roundsOf().toSorted((left, right) => left - right)).toEqual([0, 1]);

    await fireReviewFollowerOf(holder).reread(fireId);
    expect(roundsOf()).toEqual([1, 1]);
  });
});

describe('the grace a review is given to reach durable state', () => {
  it('keeps a young review the session no longer records, and drops it once it is thirty seconds old', async () => {
    const skew = { milliseconds: 0 };
    const base = createDefaultRuntimeServices();
    const runtime = {
      ...base,
      clock: {
        now: () => base.clock.now() + skew.milliseconds,
        nowISO: () => new Date(base.clock.now() + skew.milliseconds).toISOString(),
      },
    };
    const { holder, peer, fireId } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox([]) },
      'peer-sync-grace',
      (storage) => storage,
      {
        runtime,
        durableOwnership: { ...OWNERSHIP, workflowClaimTtlMs: 600_000 },
      },
    );
    // The holder hears nothing of the expiry: only a read of durable state can drop the review.
    fireReviewFollowerOf(holder).unfollow(fireId);
    expect(await peer.sweepExpiredReviews(Date.now() + 60 * 60 * 1000)).toBe(1);

    await fireReviewFollowerOf(holder).reread(fireId);
    expect(reviewsOf(holder, fireId)).toHaveLength(1);

    skew.milliseconds = 29_000;
    await fireReviewFollowerOf(holder).reread(fireId);
    expect(reviewsOf(holder, fireId)).toHaveLength(1);

    skew.milliseconds = 31_000;
    await fireReviewFollowerOf(holder).reread(fireId);
    expect(reviewsOf(holder, fireId)).toHaveLength(0);
  });
});

describe('a fire read again when its events cannot be trusted', () => {
  it('drops the approvals it holds when a peer deleted the session they were held in', async () => {
    const { holder, peer, fireId } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox([]) },
      'peer-sync-missing-session',
    );
    // The holder hears nothing of the deletion: it reads durable state, as a gap makes it do.
    fireReviewFollowerOf(holder).unfollow(fireId);
    await peer.deleteSession('peer-sync-missing-session');
    expect(reviewsOf(holder, fireId)).toHaveLength(1);

    await fireReviewFollowerOf(holder).reread(fireId);

    expect(reviewsOf(holder, fireId)).toHaveLength(0);
  });

  it('reads the fire again when the grace of a review it could not verify ends, with no event', async () => {
    const skew = { milliseconds: 0 };
    const base = createDefaultRuntimeServices();
    const runtime = {
      ...base,
      clock: {
        now: () => base.clock.now() + skew.milliseconds,
        nowISO: () => new Date(base.clock.now() + skew.milliseconds).toISOString(),
      },
    };
    // The holder's reads of the history are held, so the peer's closing never reaches it: the
    // event is as good as lost, which is what a history gap makes of it.
    const hold = { armed: false, release: undefined as (() => void) | undefined };
    const released = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    harness.onDispose(() => hold.release?.());
    const { holder, peer, fireId } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox([]) },
      'peer-sync-grace-wait',
      (storage) =>
        new Proxy(storage, {
          get(target, property) {
            const member = Reflect.get(target, property, target) as unknown;
            if (typeof member !== 'function' || typeof property !== 'string') return member;
            return (...args: unknown[]) => {
              const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
              if (
                !hold.armed ||
                property !== 'scan' ||
                !storedText(args).startsWith('fleet-event')
              ) {
                return call();
              }
              // `scan` answers an async iterable, which starts reading once `released` resolves.
              return (async function* () {
                await released;
                yield* call() as AsyncIterable<unknown>;
              })();
            };
          },
        }),
      { runtime, durableOwnership: { ...OWNERSHIP, workflowClaimTtlMs: 600_000 } },
    );
    hold.armed = true;
    // The peer closes the approval just after it was announced.
    expect(await peer.sweepExpiredReviews(Date.now() + 60 * 60 * 1000)).toBe(1);
    skew.milliseconds = 29_900;

    // Too young to tell from a record that has not landed: kept, and read again when the grace ends.
    await fireReviewFollowerOf(holder).reread(fireId);
    expect(reviewsOf(holder, fireId)).toHaveLength(1);

    await eventually(
      () => (reviewsOf(holder, fireId).length === 0 ? true : undefined),
      'the holder to drop the approval once its grace ended',
    );
  });
});

describe('a task stream whose notification fails after the review is dropped', () => {
  it('still ends, because the notification is retried', async () => {
    const failing = { armed: false, failures: 0 };
    const failOnce = (raw: Storage): Storage =>
      new Proxy(raw, {
        get(target, property) {
          const member = Reflect.get(target, property, target) as unknown;
          if (typeof member !== 'function' || typeof property !== 'string') return member;
          return (...args: unknown[]) => {
            if (
              failing.armed &&
              property === 'get' &&
              storedText(args).startsWith('bureau-task:v1:')
            ) {
              failing.armed = false;
              failing.failures += 1;
              return Promise.reject(new Error('the task store is unavailable'));
            }
            return (member as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const { holder, peer, fireId, review } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox([]) },
      'peer-sync-notification',
      failOnce,
    );
    let ended = false;
    const frames = readFrames(
      await handlerOf(holder)(
        subscribeRequest('bureau.tasks.events', { taskId: fireId }, 'alice-key'),
      ),
      { timeoutMs: 20_000 },
    ).finally(() => {
      ended = true;
    });
    frames.catch(() => undefined);
    await sleep(150);

    failing.armed = true;
    await peer.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
    await eventually(() => (failing.failures > 0 ? true : undefined), 'the notification to fail');
    await eventually(() => (ended ? true : undefined), 'the task stream to end');

    const seen = await frames;
    expect(seen.at(-1)?.data).toMatchObject({ status: 'completed' });
    expect(reviewsOf(holder, fireId)).toHaveLength(0);
  });
});

describe('the grace of an approval that may not have reached the session yet', () => {
  it('counts its exact end as ended, and a moment before it as too young to tell', async () => {
    // A clock that stands still until the test moves it, so the grace ends at an exact time.
    const base = createDefaultRuntimeServices();
    const clock = { now: base.clock.now() };
    const runtime = {
      ...base,
      clock: { now: () => clock.now, nowISO: () => new Date(clock.now).toISOString() },
    };
    const requestedAt = clock.now;
    const { holder, peer, fireId } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox([]) },
      'peer-sync-grace-boundary',
      (storage) => storage,
      { runtime, durableOwnership: { ...OWNERSHIP, workflowClaimTtlMs: 600_000 } },
    );
    // The holder hears nothing of the peer's expiry: only a read of durable state can drop it.
    fireReviewFollowerOf(holder).unfollow(fireId);
    expect(await peer.sweepExpiredReviews(Date.now() + 60 * 60 * 1000)).toBe(1);

    clock.now = requestedAt + 29_999;
    await fireReviewFollowerOf(holder).reread(fireId);
    expect(reviewsOf(holder, fireId)).toHaveLength(1);

    clock.now = requestedAt + 30_000;
    await fireReviewFollowerOf(holder).reread(fireId);
    expect(reviewsOf(holder, fireId)).toHaveLength(0);
  });
});

describe('a Bureau that shuts down', () => {
  it('stops following the fires it held, so no subscription outlives it', async () => {
    const { holder, fireId } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox([]) },
      'peer-sync-shutdown',
    );
    const follower = fireReviewFollowerOf(holder);
    expect(follower.followed()).toEqual([fireId]);

    await holder.dispose();

    expect(follower.followed()).toEqual([]);
  });
});

describe('the human wait of a fire', () => {
  const waitOptions = {
    generate: askingGenerate('answer', []),
    humanInput: true,
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    durableOwnership: OWNERSHIP,
    durableBackgroundTasks: 'automatic' as const,
  };

  it('is followed while it is parked, and no longer once a peer has answered it', async () => {
    const path = harness.nextDatabasePath();
    const holder = await harness.open({
      ...waitOptions,
      storage: await harness.sqliteStorage(path),
    });
    const { fireId } = await fireOnce(holder, OWNER.alice, 'peer-sync-wait-lifecycle');
    const review = await reviewOf(holder, fireId);
    expect(review.kind).toBe('human-wait');
    expect(fireReviewFollowerOf(holder).followed()).toEqual([fireId]);
    await sleep(150);
    const peer = await harness.open({ ...waitOptions, storage: await harness.sqliteStorage(path) });

    await peer.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
      payload: 'staging',
    });

    await eventually(
      async () => ((await durableStatus(holder, fireId)) === 'completed' ? true : undefined),
      'the fire to complete',
    );
    await eventually(
      () => (fireReviewFollowerOf(holder).followed().length === 0 ? true : undefined),
      'the holder to stop following the answered fire',
    );
  });

  it('is followed by the Bureau that restores the park after a restart', async () => {
    const path = harness.nextDatabasePath();
    const first = await harness.open({
      ...waitOptions,
      storage: await harness.sqliteStorage(path),
    });
    const { fireId } = await fireOnce(first, OWNER.alice, 'peer-sync-wait-restart');
    const review = await reviewOf(first, fireId);
    await first.dispose();

    const restarted = await harness.open({
      ...waitOptions,
      storage: await harness.sqliteStorage(path),
    });
    const restored = await reviewOf(restarted, fireId);

    expect(restored.id).toBe(review.id);
    expect(fireReviewFollowerOf(restarted).followed()).toEqual([fireId]);
  });
});

describe('a close the holder cannot read durable state for', () => {
  it('is retried, so the review leaves the list and the task stream ends', async () => {
    const failing = { armed: false, failures: 0 };
    // The session store keys a session by its id's UTF-16 code units, in hexadecimal.
    const encodedSessionId = Array.from('peer-sync-retry', (character) =>
      character.charCodeAt(0).toString(16).padStart(4, '0'),
    ).join('');
    const failOnce = (raw: Storage): Storage =>
      new Proxy(raw, {
        get(target, property) {
          const member = Reflect.get(target, property, target) as unknown;
          if (typeof member !== 'function' || typeof property !== 'string') return member;
          return (...args: unknown[]) => {
            if (
              failing.armed &&
              property === 'get' &&
              storedText(args).includes(`agent-session-v2:body:${encodedSessionId}`)
            ) {
              failing.armed = false;
              failing.failures += 1;
              return Promise.reject(new Error('the session store is unavailable'));
            }
            return (member as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const { holder, peer, fireId, review } = await holderAndPeer(
      { holder: approvalToolbox([]), peer: approvalToolbox([]) },
      'peer-sync-retry',
      failOnce,
    );
    let ended = false;
    const frames = readFrames(
      await handlerOf(holder)(
        subscribeRequest('bureau.tasks.events', { taskId: fireId }, 'alice-key'),
      ),
      { timeoutMs: 20_000 },
    ).finally(() => {
      ended = true;
    });
    frames.catch(() => undefined);
    await sleep(100);

    failing.armed = true;
    await peer.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
    await eventually(() => (failing.failures > 0 ? true : undefined), 'the holder’s read to fail');
    await eventually(
      () => (reviewsOf(holder, fireId).length === 0 ? true : undefined),
      'the holder to drop the decided review after the failed read',
    );
    const seen = await frames;

    expect(ended).toBe(true);
    expect(seen.at(-1)?.data).toMatchObject({ status: 'completed' });
  });
});
