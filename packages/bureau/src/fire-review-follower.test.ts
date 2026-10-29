/**
 * COR-1621 — the one subscription a process keeps on the durable history of the fires it holds a
 * review of: it follows several owners, adds and drops them as reviews come and go, reads a fire's
 * earlier history when it joins, reads the fires again when retention overtakes it, retries a
 * reaction that fails before the position moves on, and treats a record written without the
 * deduplication key it now carries as the record it always was.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type DurableEventOwner, type Subscription } from '@lostgradient/operative';
import { createFleetEventFeed } from '@lostgradient/weft';
import { type Storage, MemoryStorage } from '@lostgradient/storage';
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
import { awakeTurns, quietFor } from '@lostgradient/testing/wait-until';

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function eventually<T>(check: () => T | undefined, what: string): Promise<T> {
  for await (const _turn of awakeTurns()) {
    const value = check();
    if (value !== undefined) return value;
    await sleep(5);
  }
  throw new Error(`Condition was not met: ${what}`);
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const runOwner = (id: string): DurableEventOwner => ({ kind: 'run', id });
const closing = (reviewId: string) => ({ reviewId, runId: 'ignored', principal: 'p', kind: 'x' });

/**
 * A history over fresh memory storage. A test that stores a record the history cannot decode passes
 * `diagnostics`, so the skip the history reports is collected rather than printed.
 */
async function openHistory(
  diagnostics?: BureauDiagnostic[],
): Promise<{ history: DurableEventHistory; storage: Storage }> {
  const storage = new MemoryStorage();
  const history = createDurableEventHistory(
    storage,
    createManualRuntimeServices(),
    diagnostics === undefined ? undefined : (diagnostic) => diagnostics.push(diagnostic),
  );
  cleanups.push(() => history.dispose());
  return { history, storage };
}

function openFollower(
  history: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'>,
  overrides: {
    closeReview?: (runId: string, reviewId: string, kind: string) => Promise<void>;
    reread?: (runId: string) => Promise<number | undefined>;
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
        return undefined;
      }),
    now: () => Date.now(),
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
    await quietFor(50);
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
    await quietFor(50);
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
    await quietFor(100);
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
    await quietFor(50);
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
    await quietFor(50);
    expect(closed).toEqual(['fire-b|approval:fire-b:1|review.approved']);

    follower.unfollow('fire-b');
    expect(follower.followed()).toEqual([]);
    await history.record(runOwner('fire-b'), 'review.expired', closing('approval:fire-b:2'));
    await quietFor(100);
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
    const entered = Promise.withResolvers<void>();
    const { follower, reread } = openFollower(history, {
      closeReview: async (_runId, reviewId) => {
        if (reviewId === 'first') {
          entered.resolve();
          await gate.promise;
        }
      },
    });
    follower.follow('fire-a');
    follower.follow('fire-b');
    await follower.settled();
    await writer.record(runOwner('fire-a'), 'review.approved', closing('first'));
    // The first closing is being applied, held at the gate, before the later ones are recorded.
    await entered.promise;
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
    const entered = Promise.withResolvers<void>();
    const failedOnce = new Set<string>();
    const succeeded: string[] = [];
    const { follower } = openFollower(history, {
      closeReview: async (_runId, reviewId) => {
        if (reviewId === 'first') {
          entered.resolve();
          await gate.promise;
        }
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
    // The first closing is being applied, held at the gate, before the later ones are recorded.
    await entered.promise;
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
    // The waits the follower asks for fire at once, so the test is not paced by a clock: what it
    // proves is that every reopen is preceded by a wait of the configured length.
    const { requested, timers } = recordingTimers();
    const follower = createFireReviewFollower({
      history: endingAtOnce,
      closeReview: async () => undefined,
      reread: async () => undefined,
      now: () => Date.now(),
      timers,
      diagnose: () => undefined,
      attempts: 3,
      retryDelayMilliseconds: 20,
      maximumRetryDelayMilliseconds: 20,
    });
    cleanups.push(() => follower.dispose());
    follower.follow('fire-a');

    await eventually(() => (state.opens >= 5 ? true : undefined), 'five reopens');
    await follower.dispose();

    // Each reopen after the first waited its 20 milliseconds first: a reopen with no wait would
    // be the thousands of a loop.
    expect(requested.length).toBeGreaterThanOrEqual(state.opens - 1);
    expect(requested.every((ms) => ms === 20)).toBe(true);
  });

  it('keeps no timer alive once it is disposed, however long its backoff', async () => {
    const { history: real } = await openHistory();
    const flaky = unreliableHistory(real);
    const live = new Set<ReturnType<typeof setTimeout>>();
    const follower = createFireReviewFollower({
      history: flaky.history,
      closeReview: async () => undefined,
      reread: async () => undefined,
      now: () => Date.now(),
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

/** Timers that run on the real clock and remember every wait the follower asked for. */
function recordingTimers(holdMilliseconds?: number) {
  const requested: number[] = [];
  const live = new Set<ReturnType<typeof setTimeout>>();
  return {
    requested,
    live,
    now: () => Date.now(),
    timers: {
      // load-proof: tests wait for the callbacks to have RUN (the pending set `live` empties), never for a timer to be asked for, so the macrotask each callback waits for orders nothing
      setTimeout: (callback: () => void, ms?: number) => {
        requested.push(ms ?? 0);
        // A wait of the held length never ends: the stretch a subscription must stay up for.
        if (ms === holdMilliseconds) return undefined;
        const handle = setTimeout(() => {
          live.delete(handle);
          callback();
        }, 0);
        live.add(handle);
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        if (handle === undefined) return;
        live.delete(handle as ReturnType<typeof setTimeout>);
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
  };
}

describe('a followed fire whose subscription keeps ending', () => {
  for (const endAfter of [0, 2, 5]) {
    it(`is reopened with a growing wait when each subscription ends ${endAfter} ms after its pass`, async () => {
      const { history: real } = await openHistory();
      const state = { opens: 0 };
      const endingLater: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'> = {
        page: (...args) => real.page(...args),
        subscribeEventHistoryOfOwners(listener, options) {
          state.opens += 1;
          const subscription = real.subscribeEventHistoryOfOwners(listener, options);
          // Opens fine, and ends on its own after the reconciliation pass that opened it.
          void subscription.ready.then(() =>
            setTimeout(() => {
              subscription.unsubscribe();
              options?.onEnded?.();
            }, endAfter),
          );
          return subscription;
        },
      };
      // The waits fire at once, so what is checked is the waits asked for, not a window of time.
      const { requested, timers } = recordingTimers(5_000);
      const follower = createFireReviewFollower({
        history: endingLater,
        closeReview: async () => undefined,
        reread: async () => undefined,
        now: () => Date.now(),
        timers,
        diagnose: () => undefined,
        attempts: 3,
        // The Bureau's own values.
        retryDelayMilliseconds: 10,
        maximumRetryDelayMilliseconds: 5_000,
      });
      cleanups.push(() => follower.dispose());
      follower.follow('fire-a');

      await eventually(() => (state.opens >= 6 ? true : undefined), 'six reopens');
      await follower.dispose();

      // Waits of 10, 20, 40, ... milliseconds: each reopen waits twice as long as the one before.
      expect(requested.filter((ms) => ms !== 5_000).slice(0, 5)).toEqual([10, 20, 40, 80, 160]);
    });
  }

  /**
   * A follower whose subscriptions each end at once, on timers that hold any request for
   * `capMilliseconds` (the stretch a subscription must stay up for, and the longest wait).
   */
  async function followerWhoseSubscriptionsEnd(capMilliseconds: number) {
    const { history: real } = await openHistory();
    const { requested, timers } = recordingTimers(capMilliseconds);
    const endsAtOnce: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'> = {
      page: (...args) => real.page(...args),
      subscribeEventHistoryOfOwners(listener, options) {
        const subscription = real.subscribeEventHistoryOfOwners(listener, options);
        void subscription.ready.then(() => {
          subscription.unsubscribe();
          options?.onEnded?.();
        });
        return subscription;
      },
    };
    const follower = createFireReviewFollower({
      history: endsAtOnce,
      closeReview: async () => undefined,
      reread: async () => undefined,
      now: () => Date.now(),
      timers,
      diagnose: () => undefined,
      attempts: 3,
      retryDelayMilliseconds: 10,
      maximumRetryDelayMilliseconds: capMilliseconds,
    });
    cleanups.push(() => follower.dispose());
    follower.follow('fire-a');
    return requested;
  }

  it('doubles the wait with each consecutive end', async () => {
    const requested = await followerWhoseSubscriptionsEnd(100_000);

    // The cap, which is also the stretch a subscription must stay up for, is held and filtered.
    const waits = () => requested.filter((ms) => ms !== 100_000);
    await eventually(() => (waits().length >= 8 ? true : undefined), 'eight waits to be asked for');

    expect(waits().slice(0, 8)).toEqual([10, 20, 40, 80, 160, 320, 640, 1_280]);
  });

  it('stops doubling at its cap', async () => {
    const requested = await followerWhoseSubscriptionsEnd(50);

    // Each open asks for the 50 ms stability timer, and the wait that reaches the cap is held too.
    await eventually(
      () => (requested.filter((ms) => ms === 50).length >= 5 ? true : undefined),
      'the wait to reach its cap',
    );

    expect(requested.filter((ms) => ms !== 50)).toEqual([10, 20, 40]);
  });

  it('starts the wait over once a subscription has stayed up for the cap', async () => {
    const { history: real } = await openHistory();
    // The stretch a subscription must stay up for (5 000 ms) passes at once here.
    const { requested, live, timers } = recordingTimers();
    const lives: Array<() => void> = [];
    const endable: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'> = {
      page: (...args) => real.page(...args),
      subscribeEventHistoryOfOwners(listener, options) {
        const subscription = real.subscribeEventHistoryOfOwners(listener, options);
        lives.push(() => {
          subscription.unsubscribe();
          options?.onEnded?.();
        });
        return subscription;
      },
    };
    const follower = createFireReviewFollower({
      history: endable,
      closeReview: async () => undefined,
      reread: async () => undefined,
      now: () => Date.now(),
      timers,
      diagnose: () => undefined,
      attempts: 3,
      retryDelayMilliseconds: 10,
      maximumRetryDelayMilliseconds: 5_000,
    });
    cleanups.push(() => follower.dispose());
    follower.follow('fire-a');
    await follower.settled();
    // Ends once, and again after it has stayed up for the cap: each is the first of its run.
    lives[0]?.();
    await eventually(() => (lives.length >= 2 ? true : undefined), 'the first reopen');
    await follower.settled();
    // The stability timer fires (the recording timers run it on a macrotask of their own), which is
    // the cap elapsing. Being asked for is not firing: end the subscription only once nothing the
    // follower scheduled is still waiting to run.
    await eventually(
      () => (requested.length >= 3 && live.size === 0 ? true : undefined),
      'the stability timer to have fired',
    );
    lives[1]?.();
    await eventually(() => (lives.length >= 3 ? true : undefined), 'the second reopen');

    const betweenOpens = requested.filter((ms) => ms !== 5_000);
    expect(betweenOpens).toEqual([10, 10]);
  });

  it('starts the wait over once a subscription has delivered an event', async () => {
    const { history: real } = await openHistory();
    // The stretch a subscription must stay up for never passes here: only an event can reset.
    const { requested, timers } = recordingTimers(5_000);
    const lives: Array<() => void> = [];
    const endable: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'> = {
      page: (...args) => real.page(...args),
      subscribeEventHistoryOfOwners(listener, options) {
        const subscription = real.subscribeEventHistoryOfOwners(listener, options);
        lives.push(() => {
          subscription.unsubscribe();
          options?.onEnded?.();
        });
        return subscription;
      },
    };
    const waitsAsked = () => requested.filter((ms) => ms !== 5_000);
    const follower = createFireReviewFollower({
      history: endable,
      closeReview: async () => undefined,
      reread: async () => undefined,
      now: () => Date.now(),
      timers,
      diagnose: () => undefined,
      attempts: 3,
      retryDelayMilliseconds: 10,
      maximumRetryDelayMilliseconds: 5_000,
    });
    cleanups.push(() => follower.dispose());
    follower.follow('fire-b');
    await follower.settled();
    const first = lives.length - 1;
    lives[first]?.();
    await eventually(() => (lives.length >= first + 2 ? true : undefined), 'the first reopen');
    await follower.settled();
    // The reopened subscription delivers an event of a followed fire.
    await real.record(runOwner('fire-b'), 'review.requested', closing('approval:fire-b:1'));
    await quietFor(100);
    lives[lives.length - 1]?.();
    await eventually(() => (lives.length >= first + 3 ? true : undefined), 'the second reopen');

    expect(waitsAsked()).toEqual([10, 10]);
  });

  it('keeps no subscription open when the last fire is unfollowed during a failing catch-up', async () => {
    const { history: real } = await openHistory();
    const opened: DurableEventOwnersSubscription[] = [];
    let pageStarted: (() => void) | undefined;
    const history: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'> = {
      page: () =>
        new Promise((_resolve, reject) => {
          pageStarted?.();
          // load-proof: a stand-in storage that fails after a delay, which nothing waits out as a deadline
          setTimeout(() => reject(new Error('storage unavailable')), 30);
        }),
      subscribeEventHistoryOfOwners(listener, options) {
        const subscription = real.subscribeEventHistoryOfOwners(listener, options);
        opened.push(subscription);
        return subscription;
      },
    };
    const follower = createFireReviewFollower({
      history,
      closeReview: async () => undefined,
      reread: async () => undefined,
      now: () => Date.now(),
      timers: {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      diagnose: () => undefined,
      attempts: 3,
      retryDelayMilliseconds: 10,
      maximumRetryDelayMilliseconds: 5_000,
    });
    cleanups.push(() => follower.dispose());
    const started = new Promise<void>((resolve) => {
      pageStarted = resolve;
    });
    follower.follow('fire-a');
    await started;
    // The fire's last review is released while its catch-up read is in flight.
    follower.unfollow('fire-a');
    await quietFor(300);
    await follower.settled();

    expect(follower.followed()).toEqual([]);
    expect(opened.filter((subscription) => !subscription.closed)).toHaveLength(0);
  });
});

describe('a followed fire whose reviews cannot all be verified', () => {
  function followerWithRereads(
    history: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'>,
    reread: (runId: string) => Promise<number | undefined>,
    live = new Set<ReturnType<typeof setTimeout>>(),
  ) {
    const follower = createFireReviewFollower({
      history,
      closeReview: async () => undefined,
      reread,
      now: () => Date.now(),
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
      retryDelayMilliseconds: 1,
      maximumRetryDelayMilliseconds: 1,
    });
    cleanups.push(() => follower.dispose());
    return { follower, live };
  }

  it('reads a fire again when the grace it asked for ends, outside what settled() waits for', async () => {
    const { history } = await openHistory();
    const times: number[] = [];
    const { follower, live } = followerWithRereads(history, async () => {
      times.push(Date.now());
      // The first read finds a review too young to verify: ask again in 60 ms.
      return times.length === 1 ? Date.now() + 60 : undefined;
    });

    follower.follow('fire-a');
    await follower.settled();
    await follower.reread('fire-a');
    const settledAt = Date.now();

    // `settled()` did not wait for the grace, and a timer is armed for it.
    expect(times).toHaveLength(1);
    expect(live.size).toBeGreaterThan(0);
    await eventually(() => (times.length >= 2 ? true : undefined), 'the grace to end');
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(50);
    expect(Date.now() - settledAt).toBeGreaterThanOrEqual(0);
    await quietFor(50);
    expect(times).toHaveLength(2);
    expect(live.size).toBe(0);
  });

  it('clears the grace wait when the fire is unfollowed and when it is disposed', async () => {
    const { history } = await openHistory();
    const { follower, live } = followerWithRereads(history, async () => Date.now() + 60_000);

    follower.follow('fire-a');
    follower.follow('fire-b');
    await follower.settled();
    await follower.reread('fire-a');
    await follower.reread('fire-b');
    const armed = live.size;
    follower.unfollow('fire-a');
    const afterUnfollow = live.size;
    await follower.dispose();

    expect(armed).toBeGreaterThanOrEqual(2);
    expect(afterUnfollow).toBe(armed - 1);
    expect(live.size).toBe(0);
  });

  it('reads a fire again when an event of its subscription cannot be decoded', async () => {
    const skipped: BureauDiagnostic[] = [];
    const { history, storage } = await openHistory(skipped);
    const rereads: string[] = [];
    const { follower } = followerWithRereads(history, async (runId) => {
      rereads.push(runId);
      return undefined;
    });
    follower.follow('fire-a');
    await follower.settled();
    rereads.length = 0;

    // A stored record that is not the wrapper the history writes.
    const rawFeed = createFleetEventFeed(storage);
    await rawFeed.append({
      kind: 'review.approved',
      workflowId: 'run:fire-a',
      emittedAtMs: 0,
      payload: 'not-a-wrapper',
    });
    rawFeed.dispose();

    await eventually(() => (rereads.length > 0 ? true : undefined), 'the fire to be read again');
    expect(rereads).toEqual(['fire-a']);
    expect(skipped.some((entry) => entry.message.includes('Skipped corrupt durable record'))).toBe(
      true,
    );
  });

  it('reads a fire again when its catch-up page skips a record it cannot decode', async () => {
    const skipped: BureauDiagnostic[] = [];
    const { history, storage } = await openHistory(skipped);
    const rawFeed = createFleetEventFeed(storage);
    await rawFeed.append({
      kind: 'review.approved',
      workflowId: 'run:fire-a',
      emittedAtMs: 0,
      payload: 'not-a-wrapper',
    });
    rawFeed.dispose();
    const rereads: string[] = [];
    const { follower } = followerWithRereads(history, async (runId) => {
      rereads.push(runId);
      return undefined;
    });

    follower.follow('fire-a');
    await follower.settled();

    expect(rereads).toEqual(['fire-a']);
    expect(skipped.some((entry) => entry.message.includes('Skipped corrupt durable record'))).toBe(
      true,
    );
  });

  it('marks a fire for reconciliation when the read an undecodable event asks for fails', async () => {
    const skipped: BureauDiagnostic[] = [];
    const { history, storage } = await openHistory(skipped);
    let calls = 0;
    const { follower } = followerWithRereads(history, async () => {
      calls += 1;
      if (calls === 1) throw new Error('storage unavailable');
      return undefined;
    });
    follower.follow('fire-a');
    await follower.settled();
    calls = 0;
    const rawFeed = createFleetEventFeed(storage);
    await rawFeed.append({
      kind: 'review.approved',
      workflowId: 'run:fire-a',
      emittedAtMs: 0,
      payload: 'not-a-wrapper',
    });
    rawFeed.dispose();

    // The first read fails; the reconciliation it marks reads the fire's history, which skips the
    // same record and so reads the fire again, and that one succeeds.
    await eventually(() => (calls >= 2 ? true : undefined), 'the fire to be reconciled');
    expect(skipped.some((entry) => entry.message.includes('Skipped corrupt durable record'))).toBe(
      true,
    );
  });
});

describe('a read the follower started beside its reconciliation', () => {
  function slowFollower(
    history: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'>,
    reread: (runId: string) => Promise<number | undefined>,
  ) {
    const follower = createFireReviewFollower({
      history,
      closeReview: async () => undefined,
      reread,
      now: () => Date.now(),
      timers: {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      diagnose: () => undefined,
      attempts: 3,
      retryDelayMilliseconds: 1,
      maximumRetryDelayMilliseconds: 1,
    });
    cleanups.push(() => follower.dispose());
    return follower;
  }

  it('is waited for by dispose when a grace started it', async () => {
    const { history } = await openHistory();
    const gate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const follower = slowFollower(history, async (runId) => {
      calls.push(runId);
      if (calls.length === 1) return Date.now() + 20;
      await gate.promise;
      return undefined;
    });
    follower.follow('fire-a');
    await follower.settled();
    await follower.reread('fire-a');
    await eventually(() => (calls.length >= 2 ? true : undefined), 'the grace read to start');

    let disposed = false;
    const disposing = follower.dispose().then(() => {
      disposed = true;
    });
    await quietFor(50);
    expect(disposed).toBe(false);
    gate.resolve();
    await disposing;

    expect(disposed).toBe(true);
  });

  it('is waited for by dispose when a skipped record started it', async () => {
    const skipped: BureauDiagnostic[] = [];
    const { history, storage } = await openHistory(skipped);
    const gate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const follower = slowFollower(history, async (runId) => {
      calls.push(runId);
      await gate.promise;
      return undefined;
    });
    follower.follow('fire-a');
    await follower.settled();
    const rawFeed = createFleetEventFeed(storage);
    await rawFeed.append({
      kind: 'review.approved',
      workflowId: 'run:fire-a',
      emittedAtMs: 0,
      payload: 'not-a-wrapper',
    });
    rawFeed.dispose();
    await eventually(() => (calls.length >= 1 ? true : undefined), 'the skipped record’s read');

    let disposed = false;
    const disposing = follower.dispose().then(() => {
      disposed = true;
    });
    await quietFor(50);
    expect(disposed).toBe(false);
    gate.resolve();
    await disposing;

    expect(disposed).toBe(true);
    expect(skipped.some((entry) => entry.message.includes('Skipped corrupt durable record'))).toBe(
      true,
    );
  });
});

describe('a history page whose skip handler throws', () => {
  it('still answers the page, and reports the handler', async () => {
    const { history, storage } = await openHistory();
    const diagnostics: BureauDiagnostic[] = [];
    const reporting = createDurableEventHistory(storage, createManualRuntimeServices(), (entry) =>
      diagnostics.push(entry),
    );
    cleanups.push(() => reporting.dispose());
    await history.record(runOwner('fire-a'), 'review.approved', closing('approval:fire-a:1'));
    const rawFeed = createFleetEventFeed(storage);
    await rawFeed.append({
      kind: 'review.approved',
      workflowId: 'run:fire-a',
      emittedAtMs: 0,
      payload: 'not-a-wrapper',
    });
    rawFeed.dispose();

    const page = await reporting.page(runOwner('fire-a'), {
      onSkipped: () => {
        throw new Error('the handler failed');
      },
    });

    if (!('events' in page)) throw new Error('expected a page');
    expect(page.events).toHaveLength(1);
    expect(diagnostics.some((entry) => entry.message.includes('page skip handler'))).toBe(true);
  });
});

describe('a reaction that took the fire’s local copy away and then failed to notify', () => {
  it('finishes its notification with the backoff, until it succeeds', async () => {
    const { history } = await openHistory();
    const calls: string[] = [];
    const diagnostics: BureauDiagnostic[] = [];
    let failures = 2;
    const holder: { follower?: FireReviewFollower } = {};
    const follower = createFireReviewFollower({
      history,
      closeReview: async (runId, reviewId) => {
        calls.push(`${runId}|${reviewId}`);
        // The first attempt releases the review, which unfollows the fire, and then fails to tell.
        holder.follower?.unfollow(runId);
        if (failures > 0) {
          failures -= 1;
          throw new Error('the task could not be read');
        }
      },
      reread: async () => undefined,
      now: () => Date.now(),
      timers: {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      diagnose: (diagnostic) => diagnostics.push(diagnostic),
      attempts: 3,
      retryDelayMilliseconds: 1,
      maximumRetryDelayMilliseconds: 5,
    });
    holder.follower = follower;
    cleanups.push(() => follower.dispose());
    follower.follow('fire-a');
    await follower.settled();

    await history.record(runOwner('fire-a'), 'review.approved', closing('approval:fire-a:1'));

    await eventually(
      () => (calls.length >= 3 ? true : undefined),
      'the notification to be retried',
    );
    // One error per failed attempt, and none once it succeeded.
    await quietFor(30);
    expect(calls).toEqual([
      'fire-a|approval:fire-a:1',
      'fire-a|approval:fire-a:1',
      'fire-a|approval:fire-a:1',
    ]);
    expect(
      diagnostics.filter((entry) => entry.message.includes('Could not tell those following')),
    ).toHaveLength(2);
  });

  it('stops retrying once it is disposed', async () => {
    const { history } = await openHistory();
    let calls = 0;
    const holder: { follower?: FireReviewFollower } = {};
    const follower = createFireReviewFollower({
      history,
      closeReview: async (runId) => {
        calls += 1;
        holder.follower?.unfollow(runId);
        throw new Error('the task could not be read');
      },
      reread: async () => undefined,
      now: () => Date.now(),
      timers: {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      diagnose: () => undefined,
      attempts: 3,
      retryDelayMilliseconds: 1,
      maximumRetryDelayMilliseconds: 5,
    });
    holder.follower = follower;
    follower.follow('fire-a');
    await follower.settled();
    await history.record(runOwner('fire-a'), 'review.approved', closing('approval:fire-a:1'));
    await eventually(() => (calls >= 3 ? true : undefined), 'a few attempts');

    await follower.dispose();
    const atDispose = calls;
    await quietFor(50);

    expect(calls).toBe(atDispose);
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
