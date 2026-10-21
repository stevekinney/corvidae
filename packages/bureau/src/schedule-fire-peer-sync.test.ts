/**
 * COR-1621 — instances sharing the stores keep each schedule fire's reviews in step with no client
 * stream open: a peer's decision or expiry drops this instance's copy, a re-gate leaves the next
 * round listed, a decision on a stale round is refused, a close that fails to read durable state is
 * retried, and one canceled review is recorded once.
 *
 * Every test runs two Bureaus on one SQLite store under `workflow-lease` ownership, so each holds
 * the fires it started and sees the other's only through durable state.
 */
import { type GenerateFunction, stopWhen, type Toolbox } from '@lostgradient/operative';
import type { Storage } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
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
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau, PendingToolApprovalReview } from './types';

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
) {
  const path = harness.nextDatabasePath();
  const holder = await harness.open({
    ...peerOptions,
    toolbox: toolboxes.holder,
    storage: await harness.sqliteStorage(path, wrapHolder),
  });
  const { fireId } = await fireOnce(holder, OWNER.alice, sessionId);
  const review = (await reviewOf(holder, fireId)) as PendingToolApprovalReview;
  await settleAtApproval(holder, fireId);
  const peer = await harness.open({
    ...peerOptions,
    toolbox: toolboxes.peer,
    storage: await harness.sqliteStorage(path),
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
      toolbox: approvalToolbox([]),
      storage: await harness.sqliteStorage(path, (storage) => holdHolder.wrap(storage)),
    });
    const { fireId } = await fireOnce(holder, OWNER.alice, 'peer-sync-cancel');
    const review = await reviewOf(holder, fireId);
    const peer = await harness.open({
      ...options,
      toolbox: approvalToolbox([]),
      storage: await harness.sqliteStorage(path, (storage) => holdPeer.wrap(storage)),
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
      generate: continuing,
      stopWhen: stopWhen.noToolCalls(),
      toolbox: approvalToolbox([]),
      storage: await harness.sqliteStorage(harness.nextDatabasePath()),
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
