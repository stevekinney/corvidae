/**
 * COR-1621 — the one subscription a process keeps on the durable history of the fires it holds a
 * review of: it follows several owners, adds and drops them as reviews come and go, reads a fire's
 * earlier history when it joins, reads the fires again when retention overtakes it, retries a
 * reaction that fails before the position moves on, and treats a record written without the
 * deduplication key it now carries as the record it always was.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type DurableEventOwner, type Subscription } from '@lostgradient/operative';
import { resolveStorage, type Storage } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  createDurableEventHistory,
  createDurableEventProducer,
  type DurableEventHistory,
  type DurableEventOwnersSubscribeOptions,
  type DurableEventOwnersSubscription,
} from './durable-event-history';
import { ReviewCanceledEvent } from './events';
import { createFireReviewFollower, type FireReviewFollower } from './fire-review-follower';
import { reviewCanceledDedupeKey } from './review-closing-events';
import type { Bureau, BureauDiagnostic } from './types';

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function eventually<T>(
  check: () => T | undefined,
  what: string,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Condition was not met: ${what}`);
    await sleep(5);
  }
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const runOwner = (id: string): DurableEventOwner => ({ kind: 'run', id });
const closing = (reviewId: string) => ({ reviewId, runId: 'ignored', principal: 'p', kind: 'x' });

async function openHistory(): Promise<{ history: DurableEventHistory; storage: Storage }> {
  const storage = await resolveStorage({ type: 'memory' });
  const history = createDurableEventHistory(storage, createManualRuntimeServices());
  cleanups.push(() => history.dispose());
  return { history, storage };
}

function openFollower(
  history: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'>,
  overrides: {
    closeReview?: (runId: string, reviewId: string, kind: string) => Promise<void>;
    reread?: (runId: string) => Promise<void>;
    diagnostics?: BureauDiagnostic[];
    retryDelayMilliseconds?: number;
  } = {},
) {
  const closed: string[] = [];
  const reread: string[] = [];
  const follower: FireReviewFollower = createFireReviewFollower({
    history,
    closeReview:
      overrides.closeReview ??
      (async (runId, reviewId, kind) => {
        closed.push(`${runId}|${reviewId}|${kind}`);
      }),
    reread:
      overrides.reread ??
      (async (runId) => {
        reread.push(runId);
      }),
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    diagnose: (diagnostic) => overrides.diagnostics?.push(diagnostic),
    attempts: 3,
    retryDelayMilliseconds: overrides.retryDelayMilliseconds ?? 0,
    maximumRetryDelayMilliseconds: overrides.retryDelayMilliseconds ?? 0,
  });
  cleanups.push(() => follower.dispose());
  return { follower, closed, reread };
}

describe('the history subscription of several owners', () => {
  it('delivers the events of the owners it follows, from the tail, and no other', async () => {
    const { history } = await openHistory();
    await history.record(runOwner('before'), 'review.approved', closing('approval:before:1'));
    const delivered: string[] = [];
    const subscription = history.subscribeEventHistoryOfOwners((event) => {
      delivered.push(`${event.owner.id}|${event.kind}`);
    });
    cleanups.push(() => subscription.unsubscribe());
    subscription.follow(runOwner('one'));
    subscription.follow(runOwner('two'));
    await subscription.ready;

    await history.record(runOwner('one'), 'review.approved', closing('a'));
    await history.record(runOwner('other'), 'review.approved', closing('b'));
    await history.record(runOwner('before'), 'review.expired', closing('c'));
    await history.record(runOwner('two'), 'review.denied', closing('d'));

    await eventually(() => (delivered.length >= 2 ? true : undefined), 'both followed events');
    await sleep(50);
    expect(delivered).toEqual(['one|review.approved', 'two|review.denied']);
    expect(subscription.followed().map((owner) => owner.id)).toEqual(['one', 'two']);
  });

  it('stops delivering an owner once it is unfollowed', async () => {
    const { history } = await openHistory();
    const delivered: string[] = [];
    const subscription = history.subscribeEventHistoryOfOwners((event) => {
      delivered.push(`${event.owner.id}|${event.kind}`);
    });
    cleanups.push(() => subscription.unsubscribe());
    subscription.follow(runOwner('one'));
    subscription.follow(runOwner('two'));
    await subscription.ready;
    subscription.unfollow(runOwner('one'));

    await history.record(runOwner('one'), 'review.approved', closing('a'));
    await history.record(runOwner('two'), 'review.approved', closing('b'));

    await eventually(() => (delivered.length >= 1 ? true : undefined), 'the followed event');
    await sleep(50);
    expect(delivered).toEqual(['two|review.approved']);
  });

  it('does not move past an event until its listener has settled', async () => {
    const { history } = await openHistory();
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const subscription = history.subscribeEventHistoryOfOwners(async (event) => {
      order.push(`start ${event.kind}`);
      if (event.kind === 'review.approved') await gate.promise;
      order.push(`end ${event.kind}`);
    });
    cleanups.push(() => subscription.unsubscribe());
    subscription.follow(runOwner('one'));
    await subscription.ready;
    await history.record(runOwner('one'), 'review.approved', closing('a'));
    await history.record(runOwner('one'), 'review.expired', closing('b'));

    await eventually(() => (order.length >= 1 ? true : undefined), 'the first event');
    await sleep(100);
    expect(order).toEqual(['start review.approved']);
    gate.resolve();
    await eventually(() => (order.length >= 4 ? true : undefined), 'the second event');
    expect(order).toEqual([
      'start review.approved',
      'end review.approved',
      'start review.expired',
      'end review.expired',
    ]);
  });

  it('tells its gap handler when retention overtakes it, before any later event', async () => {
    const { history, storage } = await openHistory();
    const writer = createDurableEventHistory(storage, createManualRuntimeServices());
    cleanups.push(() => writer.dispose());
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const subscription = history.subscribeEventHistoryOfOwners(
      async (event) => {
        order.push(`event ${event.kind}`);
        if (event.kind === 'review.approved') await gate.promise;
      },
      {
        onGap: (gap) => {
          order.push(`gap after ${gap.requestedCursor}`);
        },
      },
    );
    cleanups.push(() => subscription.unsubscribe());
    subscription.follow(runOwner('one'));
    await subscription.ready;
    await writer.record(runOwner('one'), 'review.approved', closing('a'));
    await eventually(() => (order.length >= 1 ? true : undefined), 'the first event');
    await writer.record(runOwner('one'), 'review.expired', closing('b'));
    await writer.record(runOwner('one'), 'review.denied', closing('c'));
    expect(await writer.retainBefore(Date.now() + 1_000_000)).toBeGreaterThan(0);

    gate.resolve();
    await eventually(() => (order.length >= 2 ? true : undefined), 'the gap');
    await writer.record(runOwner('one'), 'review.revoked', closing('d'));
    await eventually(() => (order.length >= 3 ? true : undefined), 'the event after the gap');

    expect(order[0]).toBe('event review.approved');
    expect(order[1]).toMatch(/^gap after /);
    expect(order[2]).toBe('event review.revoked');
  });
});

describe('the fire review follower', () => {
  it('follows several fires with one subscription and reacts to each one’s closings', async () => {
    const { history } = await openHistory();
    const { follower, closed } = openFollower(history);
    follower.follow('fire-a');
    follower.follow('fire-b');
    await follower.settled();

    await history.record(runOwner('fire-a'), 'review.approved', closing('approval:fire-a:1'));
    await history.record(runOwner('fire-b'), 'review.expired', closing('approval:fire-b:1'));
    await history.record(runOwner('fire-c'), 'review.approved', closing('approval:fire-c:1'));
    await history.record(runOwner('fire-a'), 'review.requested', closing('approval:fire-a:2'));

    await eventually(() => (closed.length >= 2 ? true : undefined), 'both closings');
    await sleep(50);
    expect(closed.toSorted()).toEqual([
      'fire-a|approval:fire-a:1|review.approved',
      'fire-b|approval:fire-b:1|review.expired',
    ]);
    expect(follower.followed().toSorted()).toEqual(['fire-a', 'fire-b']);
  });

  it('adds a fire when it is followed, reading what it recorded before', async () => {
    const { history } = await openHistory();
    await history.record(runOwner('fire-a'), 'review.approved', closing('approval:fire-a:1'));
    const { follower, closed } = openFollower(history);

    follower.follow('fire-a');
    await follower.settled();

    expect(closed).toEqual(['fire-a|approval:fire-a:1|review.approved']);
  });

  it('stops following a fire when it is unfollowed, and closes its subscription with the last one', async () => {
    const { history } = await openHistory();
    const { follower, closed } = openFollower(history);
    follower.follow('fire-a');
    follower.follow('fire-b');
    await follower.settled();
    follower.unfollow('fire-a');
    expect(follower.followed()).toEqual(['fire-b']);

    await history.record(runOwner('fire-a'), 'review.approved', closing('approval:fire-a:1'));
    await history.record(runOwner('fire-b'), 'review.approved', closing('approval:fire-b:1'));
    await eventually(() => (closed.length >= 1 ? true : undefined), 'the followed closing');
    await sleep(50);
    expect(closed).toEqual(['fire-b|approval:fire-b:1|review.approved']);

    follower.unfollow('fire-b');
    expect(follower.followed()).toEqual([]);
    await history.record(runOwner('fire-b'), 'review.expired', closing('approval:fire-b:2'));
    await sleep(100);
    expect(closed).toHaveLength(1);

    // A fire followed again after that reads what it recorded while nothing was followed.
    follower.follow('fire-b');
    await follower.settled();
    expect(closed).toContain('fire-b|approval:fire-b:2|review.expired');
  });

  it('retries a reaction that fails before it reads the next event', async () => {
    const { history } = await openHistory();
    const attempts: string[] = [];
    let failures = 2;
    const { follower, reread } = openFollower(history, {
      closeReview: async (_runId, reviewId) => {
        attempts.push(reviewId);
        if (reviewId === 'first' && failures > 0) {
          failures -= 1;
          throw new Error('the session could not be loaded');
        }
      },
    });
    follower.follow('fire-a');
    await follower.settled();

    await history.record(runOwner('fire-a'), 'review.approved', closing('first'));
    await history.record(runOwner('fire-a'), 'review.expired', closing('second'));

    await eventually(() => (attempts.includes('second') ? true : undefined), 'the second event');
    expect(attempts).toEqual(['first', 'first', 'first', 'second']);
    expect(reread).toEqual([]);
  });

  it('reads the fire again from durable state when a reaction keeps failing, and says so when that fails too', async () => {
    const { history } = await openHistory();
    const diagnostics: BureauDiagnostic[] = [];
    const rereads: string[] = [];
    const { follower } = openFollower(history, {
      diagnostics,
      closeReview: async () => {
        throw new Error('the session could not be loaded');
      },
      reread: async (runId) => {
        rereads.push(runId);
        throw new Error('still not loadable');
      },
    });
    follower.follow('fire-a');
    await follower.settled();

    await history.record(runOwner('fire-a'), 'review.approved', closing('approval:fire-a:1'));

    await eventually(() => (rereads.length >= 1 ? true : undefined), 'the fire to be read again');
    await eventually(
      () =>
        diagnostics.some((entry) => entry.message.includes('may keep listing it'))
          ? true
          : undefined,
      'the diagnostic',
    );
    // A fire that cannot be read is reconciled again, not given up on.
    expect(rereads.length).toBeGreaterThanOrEqual(1);
    expect(new Set(rereads)).toEqual(new Set(['fire-a']));
  });

  it('reads every followed fire again when retention overtakes the subscription', async () => {
    const { history, storage } = await openHistory();
    const writer = createDurableEventHistory(storage, createManualRuntimeServices());
    cleanups.push(() => writer.dispose());
    const gate = Promise.withResolvers<void>();
    const { follower, reread } = openFollower(history, {
      closeReview: async (_runId, reviewId) => {
        if (reviewId === 'first') await gate.promise;
      },
    });
    follower.follow('fire-a');
    follower.follow('fire-b');
    await follower.settled();
    await writer.record(runOwner('fire-a'), 'review.approved', closing('first'));
    await sleep(100);
    await writer.record(runOwner('fire-a'), 'review.expired', closing('second'));
    await writer.record(runOwner('fire-b'), 'review.expired', closing('third'));
    expect(await writer.retainBefore(Date.now() + 1_000_000)).toBeGreaterThan(0);

    gate.resolve();

    await eventually(() => (reread.length >= 2 ? true : undefined), 'both fires to be read again');
    expect(reread.toSorted()).toEqual(['fire-a', 'fire-b']);
  });

  it('keeps no subscription open while it follows nothing, and ends with dispose', async () => {
    const { history } = await openHistory();
    const subscriptions: Subscription[] = [];
    const spying: DurableEventHistory = {
      ...history,
      subscribeEventHistoryOfOwners: (listener, options) => {
        const subscription = history.subscribeEventHistoryOfOwners(listener, options);
        subscriptions.push(subscription);
        return subscription;
      },
    };
    const { follower } = openFollower(spying);

    follower.follow('fire-a');
    follower.follow('fire-b');
    expect(subscriptions).toHaveLength(1);
    follower.unfollow('fire-a');
    follower.unfollow('fire-b');
    expect(subscriptions[0]?.closed).toBe(true);
    follower.follow('fire-c');
    expect(subscriptions).toHaveLength(2);
    await follower.dispose();
    expect(subscriptions[1]?.closed).toBe(true);
    expect(follower.followed()).toEqual([]);
  });
});

describe('a canceled review recorded with and without its deduplication key', () => {
  it('keeps one history event for a review round that two instances both record', async () => {
    const { history } = await openHistory();
    const runtime = createManualRuntimeServices();
    const first = canceledBureau();
    const second = canceledBureau();
    const firstProducer = createDurableEventProducer(first.bureau, history, runtime);
    const secondProducer = createDurableEventProducer(second.bureau, history, runtime);
    cleanups.push(() => firstProducer.dispose());
    cleanups.push(() => secondProducer.dispose());
    const event = () =>
      new ReviewCanceledEvent(
        'approval:run-1:call-1',
        'run-1',
        'system:run-abort',
        'tool-approval',
        1,
      );

    first.dispatch(event());
    second.dispatch(event());
    // Another round of the same review is its own closing.
    second.dispatch(
      new ReviewCanceledEvent(
        'approval:run-1:call-1',
        'run-1',
        'system:run-abort',
        'tool-approval',
        2,
      ),
    );
    await firstProducer.waitForAllActiveWrites();
    await secondProducer.waitForAllActiveWrites();

    const page = await history.page(runOwner('run-1'));
    if (!('events' in page)) throw new Error('expected a page');
    expect(page.events.map((entry) => entry.kind)).toEqual(['review.canceled', 'review.canceled']);
    expect(
      await history.wasRecorded(
        runOwner('run-1'),
        'review.canceled',
        reviewCanceledDedupeKey('approval:run-1:call-1', 1),
      ),
    ).toBe(true);
    expect(
      await history.wasRecorded(
        runOwner('run-1'),
        'review.canceled',
        reviewCanceledDedupeKey('approval:run-1:call-1', 2),
      ),
    ).toBe(true);
  });

  it('still reads a canceled event recorded before the key existed, and records one that states no round', async () => {
    const { history } = await openHistory();
    const runtime = createManualRuntimeServices();
    // What an earlier build wrote: no key on the record.
    await history.record(runOwner('run-1'), 'review.canceled', {
      reviewId: 'approval:run-1:call-1',
      runId: 'run-1',
      principal: 'system:run-abort',
      kind: 'tool-approval',
    });
    const { bureau, dispatch } = canceledBureau();
    const producer = createDurableEventProducer(bureau, history, runtime);
    cleanups.push(() => producer.dispose());

    // An event that states no round is recorded as it always was, once per dispatch.
    dispatch(
      new ReviewCanceledEvent(
        'approval:run-1:call-1',
        'run-1',
        'system:run-abort',
        'tool-approval',
      ),
    );
    dispatch(
      new ReviewCanceledEvent(
        'approval:run-1:call-1',
        'run-1',
        'system:run-abort',
        'tool-approval',
      ),
    );
    await runtime.deferred.drain();

    const page = await history.page(runOwner('run-1'));
    if (!('events' in page)) throw new Error('expected a page');
    expect(page.events).toHaveLength(3);
    expect(page.events[0]?.payload).toMatchObject({ reviewId: 'approval:run-1:call-1' });
  });
});

function canceledBureau(): { bureau: Bureau; dispatch: (event: ReviewCanceledEvent) => void } {
  let listener: ((event: ReviewCanceledEvent) => void) | undefined;
  const bureau = {
    addEventListener(type: string, handler: (event: ReviewCanceledEvent) => void) {
      if (type === 'review.canceled') listener = handler;
    },
    removeEventListener() {},
  } as unknown as Bureau;
  return { bureau, dispatch: (event) => listener?.(event) };
}

/**
 * A history whose reads can be made to fail: a storage that cannot read the feed's tail
 * (`down`: every subscription opened ends at once, on its own), and a page read that fails
 * `failPages` times. `endLive` ends the live subscription on its own, as a storage failure would.
 */
function unreliableHistory(real: DurableEventHistory) {
  const state = { down: false, failPages: 0, opens: 0 };
  let live:
    | {
        subscription: DurableEventOwnersSubscription;
        options: DurableEventOwnersSubscribeOptions | undefined;
      }
    | undefined;
  const history: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'> = {
    page: (...args) => {
      if (state.failPages > 0) {
        state.failPages -= 1;
        return Promise.reject(new Error('storage unavailable'));
      }
      return real.page(...args);
    },
    subscribeEventHistoryOfOwners(listener, options) {
      state.opens += 1;
      if (state.down) {
        const ready = Promise.reject(new Error('storage unavailable'));
        ready.catch(() => undefined);
        const failed: DurableEventOwnersSubscription = {
          follow() {},
          unfollow() {},
          followed: () => [],
          unsubscribe() {},
          closed: true,
          ready,
        };
        queueMicrotask(() => options?.onEnded?.());
        return failed;
      }
      const subscription = real.subscribeEventHistoryOfOwners(listener, options);
      live = { subscription, options };
      return subscription;
    },
  };
  return {
    history,
    state,
    endLive() {
      live?.subscription.unsubscribe();
      live?.options?.onEnded?.();
    },
  };
}

describe('a followed fire that cannot be read', () => {
  it('is caught up after an outage that outlasts the reopens, with no other fire followed', async () => {
    const { history: real } = await openHistory();
    const flaky = unreliableHistory(real);
    const { follower, closed } = openFollower(flaky.history);
    follower.follow('fire-a');
    await follower.settled();

    flaky.state.down = true;
    flaky.endLive();
    await eventually(() => (flaky.state.opens > 6 ? true : undefined), 'the reopens to be tried');
    // The storage recovers, and a peer has closed the fire's review in the meantime.
    flaky.state.down = false;
    await real.record(runOwner('fire-a'), 'review.approved', closing('approval:fire-a:1'));

    await eventually(() => (closed.length > 0 ? true : undefined), 'the closing to be read');
    expect(closed).toEqual(['fire-a|approval:fire-a:1|review.approved']);
  });

  it('is caught up again when the read of its history fails once after the subscription ended', async () => {
    const { history: real } = await openHistory();
    const flaky = unreliableHistory(real);
    const { follower, closed } = openFollower(flaky.history);
    follower.follow('fire-a');
    await follower.settled();

    // The subscription ends and a peer closes the review, before the reopen's catch-up read,
    // which fails once.
    flaky.state.failPages = 1;
    await real.record(runOwner('fire-a'), 'review.approved', closing('approval:fire-a:1'));
    flaky.endLive();

    await eventually(() => (closed.length > 0 ? true : undefined), 'the closing to be read');
    expect(closed).toEqual(['fire-a|approval:fire-a:1|review.approved']);
    expect(flaky.state.failPages).toBe(0);
  });

  it('is read again from durable state when the read a gap makes necessary fails once', async () => {
    const { history, storage } = await openHistory();
    const writer = createDurableEventHistory(storage, createManualRuntimeServices());
    cleanups.push(() => writer.dispose());
    const gate = Promise.withResolvers<void>();
    const failedOnce = new Set<string>();
    const succeeded: string[] = [];
    const { follower } = openFollower(history, {
      closeReview: async (_runId, reviewId) => {
        if (reviewId === 'first') await gate.promise;
      },
      reread: async (runId) => {
        if (!failedOnce.has(runId)) {
          failedOnce.add(runId);
          throw new Error('storage unavailable');
        }
        succeeded.push(runId);
      },
    });
    follower.follow('fire-a');
    follower.follow('fire-b');
    await follower.settled();
    succeeded.length = 0;
    failedOnce.clear();
    await writer.record(runOwner('fire-a'), 'review.approved', closing('first'));
    await sleep(100);
    await writer.record(runOwner('fire-a'), 'review.expired', closing('second'));
    await writer.record(runOwner('fire-b'), 'review.expired', closing('third'));
    expect(await writer.retainBefore(Date.now() + 1_000_000)).toBeGreaterThan(0);

    gate.resolve();

    await eventually(
      () => (succeeded.includes('fire-a') && succeeded.includes('fire-b') ? true : undefined),
      'both fires to be read again after their first read failed',
    );
  });

  it('does not open subscriptions in a loop when each one ends at once without a failure', async () => {
    const { history: real } = await openHistory();
    const state = { opens: 0 };
    const endingAtOnce: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'> = {
      page: (...args) => real.page(...args),
      subscribeEventHistoryOfOwners(listener, options) {
        state.opens += 1;
        const subscription = real.subscribeEventHistoryOfOwners(listener, options);
        // The feed was released under it, as at shutdown: the subscription ends by itself.
        queueMicrotask(() => {
          subscription.unsubscribe();
          options?.onEnded?.();
        });
        return subscription;
      },
    };
    const { follower } = openFollower(endingAtOnce, { retryDelayMilliseconds: 20 });
    follower.follow('fire-a');

    await sleep(400);

    // One open per 20 milliseconds wait at the most: a few tens, not the thousands of a loop.
    expect(state.opens).toBeGreaterThan(1);
    expect(state.opens).toBeLessThan(40);
  });

  it('keeps no timer alive once it is disposed, however long its backoff', async () => {
    const { history: real } = await openHistory();
    const flaky = unreliableHistory(real);
    const live = new Set<ReturnType<typeof setTimeout>>();
    const follower = createFireReviewFollower({
      history: flaky.history,
      closeReview: async () => undefined,
      reread: async () => undefined,
      timers: {
        setTimeout: (callback, ms) => {
          const handle = setTimeout(() => {
            live.delete(handle);
            callback();
          }, ms);
          live.add(handle);
          return handle;
        },
        clearTimeout: (handle) => {
          live.delete(handle as ReturnType<typeof setTimeout>);
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        },
      },
      diagnose: () => undefined,
      attempts: 3,
      retryDelayMilliseconds: 60_000,
      maximumRetryDelayMilliseconds: 60_000,
    });
    flaky.state.down = true;
    follower.follow('fire-a');
    await eventually(() => (live.size > 0 ? true : undefined), 'the backoff to be waiting');

    await follower.dispose();

    expect(live.size).toBe(0);
  });
});

describe('the deduplication key of a canceled review', () => {
  it('names the review and the round, and leaves a short review id as it was written', () => {
    expect(reviewCanceledDedupeKey('approval:run-1:call-1', 1)).toBe(
      'review.canceled:approval:run-1:call-1:1',
    );
    expect(reviewCanceledDedupeKey('human-wait:run-1:answer:0', 0)).toBe(
      'review.canceled:human-wait:run-1:answer:0:0',
    );
  });

  it('bounds a long review id, so the persisted key stays short and still tells reviews and rounds apart', async () => {
    const longId = `human-wait:run-1:${'s'.repeat(5_000)}:0`;
    const otherLongId = `human-wait:run-1:${'t'.repeat(5_000)}:0`;

    const key = reviewCanceledDedupeKey(longId, 0);

    expect(key.length).toBeLessThan(200);
    expect(key).toMatch(/^review\.canceled:human-wait:sha256:[0-9a-f]{64}:0$/);
    expect(reviewCanceledDedupeKey(longId, 0)).toBe(key);
    expect(reviewCanceledDedupeKey(otherLongId, 0)).not.toBe(key);
    expect(reviewCanceledDedupeKey(longId, 1)).not.toBe(key);

    // Recorded twice, as two instances would, the closing is one record in the history.
    const { history } = await openHistory();
    const runtime = createManualRuntimeServices();
    const first = canceledBureau();
    const second = canceledBureau();
    const firstProducer = createDurableEventProducer(first.bureau, history, runtime);
    const secondProducer = createDurableEventProducer(second.bureau, history, runtime);
    cleanups.push(() => firstProducer.dispose());
    cleanups.push(() => secondProducer.dispose());
    const event = () =>
      new ReviewCanceledEvent(longId, 'run-1', 'system:run-abort', 'human-wait', 0);
    first.dispatch(event());
    second.dispatch(event());
    await firstProducer.waitForAllActiveWrites();
    await secondProducer.waitForAllActiveWrites();
    const page = await history.page(runOwner('run-1'));
    if (!('events' in page)) throw new Error('expected a page');
    expect(page.events).toHaveLength(1);
  });
});
