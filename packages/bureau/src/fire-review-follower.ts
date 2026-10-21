/**
 * The one subscription a process keeps on the durable history of the schedule fires whose
 * reviews it holds (COR-1621).
 *
 * A review of a fire can be closed by another process sharing the stores: a peer decides it,
 * expires it, or re-gates its approval. The closing is in the fire's durable history, which is
 * shared, and this process must read it to drop or refresh its own copy. It used to read it only
 * while a client held `bureau.tasks.events` open, so with no stream an instance listed a decided
 * review indefinitely. Here one subscription follows every fire the process holds a review of:
 * a fire is added when one of its reviews is announced or restored and removed when its last
 * review is released, so a process holding none keeps no subscription open.
 *
 * Its guarantees, in the order a reader needs them:
 *
 * - An event is reacted to before the subscription's position moves past it. The history awaits
 *   this module's listener, and the listener retries a failed reaction (a session that cannot be
 *   loaded, a release that rejects) and then reads the fire's reviews again from durable state.
 * - Everything the subscription cannot be trusted to have delivered is reconciled, and a
 *   reconciliation that fails is retried with a bounded backoff until it succeeds or the fire is
 *   unfollowed; it never goes dead. A fire is reconciled when it is first followed (its earlier
 *   history is read after it joins the subscription, so no event falls between the two), when the
 *   subscription ends on its own and is opened again (every followed fire, since the new
 *   subscription starts at the feed's tail), when the retention floor overtakes the subscription
 *   (its events are gone, so the fire's reviews are read again from durable state), and when a
 *   reaction to one of its events fails past its retries.
 * - No timer outlives {@link FireReviewFollower.dispose}: the backoff's waits are cleared by it.
 *
 * @module fire-review-follower
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { DurableEventEnvelope } from '@lostgradient/operative';

import type { DurableEventHistory, DurableEventOwnersSubscription } from './durable-event-history';
import { REVIEW_CLOSING_EVENT_KINDS } from './review-closing-events';
import { serializeUnknownError } from './serialization';
import type { DiagnosticSink } from './types';

/** How many events of a followed fire's history a catch-up reads per page. */
const CATCH_UP_PAGE_LIMIT = 500;

/** What the follower needs of the Bureau that owns it. */
export interface FireReviewFollowerDependencies {
  readonly history: Pick<DurableEventHistory, 'page' | 'subscribeEventHistoryOfOwners'>;
  /**
   * Reacts to a review of `runId` that the history says another process closed
   * (`review.approved`, `review.expired`, and the other closing kinds). Rejects when the reaction
   * could not be made, which the follower retries.
   */
  readonly closeReview: (runId: string, reviewId: string, eventKind: string) => Promise<void>;
  /**
   * Reads the reviews this process holds of `runId` again from durable state, and drops or
   * refreshes each one the state says is closed or re-gated. Used when the events cannot be
   * trusted to be all there (a gap) or could not be acted on.
   *
   * A fire is reconciled only when every review it holds matches durable state. It resolves
   * with the time the grace of the youngest review it could not yet verify ends (a review is given
   * a moment to reach durable state), for the follower to read the fire again then, or with
   * `undefined` once every review is verified. It rejects when a review cannot be verified at all
   * (the store cannot be read, or says nothing about the review), which the follower retries with
   * its backoff.
   */
  readonly reread: (runId: string) => Promise<number | undefined>;
  /** The time now, in the clock the times {@link reread} resolves with are in. */
  readonly now: () => number;
  /** The timers the waits between attempts run on, which {@link FireReviewFollower.dispose} clears. */
  readonly timers: Pick<RuntimeServices['timers'], 'setTimeout' | 'clearTimeout'>;
  readonly diagnose: DiagnosticSink;
  /** How many times a reaction is attempted before the fire is read again. At least one. */
  readonly attempts: number;
  /** The wait between a reaction's attempts, and the first wait of a failed reconciliation. */
  readonly retryDelayMilliseconds: number;
  /** The longest wait between a failed reconciliation's attempts, which double up to it. */
  readonly maximumRetryDelayMilliseconds: number;
}

/** The follower a Bureau keeps for the fires it holds reviews of. */
export interface FireReviewFollower {
  /** Follows a fire's history from now on, catching up on what it recorded before. Idempotent. */
  follow(runId: string): void;
  /** Stops following a fire. Idempotent. */
  unfollow(runId: string): void;
  /** The fires followed now. */
  followed(): readonly string[];
  /** Reads the reviews held here of a fire again from durable state, now. */
  reread(runId: string): Promise<void>;
  /** Resolves once the reconciliations started so far have succeeded. For tests and shutdown. */
  settled(): Promise<void>;
  /** Ends the subscription, clears its timers and waits for the work in flight. Idempotent. */
  dispose(): Promise<void>;
}

const runOwner = (runId: string) => ({ kind: 'run', id: runId }) as const;

export function createFireReviewFollower(
  dependencies: FireReviewFollowerDependencies,
): FireReviewFollower {
  const { history, closeReview, reread, diagnose } = dependencies;
  const { setTimeout: scheduleTimeout, clearTimeout: cancelTimeout } = dependencies.timers;
  const followedRuns = new Set<string>();
  /** The followed fires whose history or durable state has yet to be read again, in full. */
  const needsReconciliation = new Set<string>();
  const waits = new Set<{ readonly handle: ReturnType<typeof scheduleTimeout>; wake(): void }>();
  /** The reads a grace asked for, by fire: one wait each, outside `needsReconciliation`. */
  const graceWaits = new Map<string, { readonly handle: ReturnType<typeof scheduleTimeout> }>();
  /** The notifications a reaction that unfollowed its fire is still retrying. */
  const notifications = new Set<Promise<void>>();
  let reconciling: Promise<void> | undefined;
  let subscription: DurableEventOwnersSubscription | undefined;
  let disposed = false;
  /**
   * How many times in a row a subscription has ended on its own, across reconciliations. A
   * subscription that ends after the pass that opened it must not be reopened at once, so the wait
   * before a reopen grows with this count. It starts over only once a subscription has stayed up
   * for the longest wait, or has delivered an event.
   */
  let consecutiveEnds = 0;
  /** Set by an end the reconciliation has yet to wait out. */
  let endedWithoutWait = false;
  /** Ends the stretch of the current subscription that counts as it staying up. */
  let stabilityTimer: { readonly handle: ReturnType<typeof scheduleTimeout> } | undefined;

  /** Waits `milliseconds` on a timer that {@link FireReviewFollower.dispose} clears. */
  function wait(milliseconds: number): Promise<void> {
    if (disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const entry = {
        handle: scheduleTimeout(() => {
          waits.delete(entry);
          resolve();
        }, milliseconds),
        wake: () => {
          waits.delete(entry);
          resolve();
        },
      };
      waits.add(entry);
    });
  }

  /**
   * Arms the one wait that reads a fire again when the youngest review `reread` could not yet
   * verify has had its grace. It is the grace's own wait, not a reconciliation: nothing failed, so
   * the fire is not marked and `settled()` does not wait for it. A later answer replaces it.
   */
  function scheduleGraceReread(runId: string, at: number | undefined): void {
    clearGrace(runId);
    if (at === undefined || disposed || !followedRuns.has(runId)) return;
    const entry = {
      handle: scheduleTimeout(
        () => {
          graceWaits.delete(runId);
          if (disposed || !followedRuns.has(runId)) return;
          rereadWatching(runId).catch((error: unknown) => {
            diagnose({
              level: 'error',
              scope: 'durable-event-history',
              message: `[bureau] Could not read the reviews of schedule fire "${runId}" again once their grace ended, and will try again: ${serializeUnknownError(error)}`,
              cause: error,
            });
            reconcile([runId]);
          });
        },
        Math.max(0, at - dependencies.now()),
      ),
    };
    graceWaits.set(runId, entry);
  }

  function clearGrace(runId: string): void {
    const entry = graceWaits.get(runId);
    if (entry === undefined) return;
    cancelTimeout(entry.handle);
    graceWaits.delete(runId);
  }

  /** Reads a fire's reviews again from durable state, and arms the wait its grace asks for. */
  async function rereadWatching(runId: string): Promise<void> {
    scheduleGraceReread(runId, await reread(runId));
  }

  /**
   * COR-1622 — finishes the notification of a reaction that took the local copy of a review away
   * (and unfollowed its fire) and then failed to tell those following the task. The release acts
   * only on what this process still holds, so running the reaction again only tells them. It is
   * retried with the backoff, with no attempt limit, until it succeeds or the follower is
   * disposed, and each failed attempt is reported. It runs beside the subscription, which goes on
   * to the next event.
   */
  function finishNotification(
    runId: string,
    reviewId: string,
    eventKind: string,
    firstError: unknown,
  ): void {
    const report = (error: unknown): void => {
      diagnose({
        level: 'error',
        scope: 'durable-event-history',
        message: `[bureau] Could not tell those following schedule fire "${runId}" that review "${reviewId}" was closed, and will try again: ${serializeUnknownError(error)}`,
        cause: error,
      });
    };
    report(firstError);
    const work = (async () => {
      for (let failures = 1; !disposed; failures += 1) {
        await wait(backoff(failures));
        if (disposed) return;
        try {
          await closeReview(runId, reviewId, eventKind);
          return;
        } catch (error) {
          report(error);
        }
      }
    })();
    notifications.add(work);
    void work.finally(() => notifications.delete(work));
  }

  /**
   * Reacts to one closing event, retrying a failed reaction and then reading the fire again, so a
   * transient failure never leaves the event unread. Resolves `false` when the reaction and the
   * re-read both failed, which the caller reconciles. A reaction that fails after it has taken
   * the fire's local copy away is not read again, there being nothing left to read: its
   * notification is finished beside the subscription instead.
   */
  async function react(runId: string, reviewId: string, eventKind: string): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= dependencies.attempts; attempt += 1) {
      if (disposed || !followedRuns.has(runId)) return true;
      try {
        await closeReview(runId, reviewId, eventKind);
        return true;
      } catch (error) {
        lastError = error;
        if (!followedRuns.has(runId)) {
          finishNotification(runId, reviewId, eventKind, error);
          return true;
        }
        if (attempt < dependencies.attempts) await wait(dependencies.retryDelayMilliseconds);
      }
    }
    if (disposed || !followedRuns.has(runId)) return true;
    try {
      await rereadWatching(runId);
      return true;
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'durable-event-history',
        message:
          `[bureau] Could not drop review "${reviewId}" of schedule fire "${runId}" after a peer's ` +
          `"${eventKind}", so this process may keep listing it until it is reconciled: ` +
          `${serializeUnknownError(lastError)}; reading it again failed too: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return false;
    }
  }

  /** The reaction to an event the subscription delivers: a failed one is reconciled later. */
  async function handle(event: DurableEventEnvelope): Promise<void> {
    // A subscription that delivers is a working one.
    consecutiveEnds = 0;
    if (event.owner.kind !== 'run' || !REVIEW_CLOSING_EVENT_KINDS.has(event.kind)) return;
    const reviewId = (event.payload as { reviewId?: unknown } | null)?.reviewId;
    if (typeof reviewId !== 'string') return;
    if (!(await react(event.owner.id, reviewId, event.kind))) reconcile([event.owner.id]);
  }

  /**
   * Reads a fire's whole history for the closings it holds, as a fire added after the
   * subscription started needs: an event the subscription passed before the fire joined it is
   * only here. A history the retention floor has passed cannot be read, so the fire's reviews are
   * read again from durable state instead. Rejects when a read or a reaction fails.
   */
  async function catchUp(runId: string): Promise<void> {
    let since: string | undefined;
    for (;;) {
      if (disposed || !followedRuns.has(runId)) return;
      // A record the read could not decode is a hole in what the page says, so the fire's reviews
      // are read from the state the record would have described.
      let skipped = false;
      const page = await history.page(runOwner(runId), {
        limit: CATCH_UP_PAGE_LIMIT,
        ...(since === undefined ? {} : { since }),
        onSkipped: () => {
          skipped = true;
        },
      });
      if (!('events' in page)) {
        await rereadWatching(runId);
        return;
      }
      if (skipped) await rereadWatching(runId);
      for (const event of page.events) {
        const reviewId = (event.payload as { reviewId?: unknown } | null)?.reviewId;
        if (event.owner.kind !== 'run' || !REVIEW_CLOSING_EVENT_KINDS.has(event.kind)) continue;
        if (typeof reviewId !== 'string') continue;
        if (!(await react(runId, reviewId, event.kind))) {
          throw new Error(`The closing of review "${reviewId}" could not be applied`);
        }
      }
      if (!page.hasMore || page.nextCursor === undefined) return;
      since = page.nextCursor;
    }
  }

  /** Whether a fire is marked, or an end has yet to be waited out, and the follower is running. */
  function hasReconciliationToDo(): boolean {
    return !disposed && followedRuns.size > 0 && (needsReconciliation.size > 0 || endedWithoutWait);
  }

  /** The wait after the `failures`-th consecutive failed reconciliation: doubled, and bounded. */
  function backoff(failures: number): number {
    const delay = dependencies.retryDelayMilliseconds * 2 ** Math.min(failures - 1, 20);
    return Math.min(delay, dependencies.maximumRetryDelayMilliseconds);
  }

  /**
   * Reconciles every fire marked, opening the subscription again first if it ended, and retries
   * with a bounded backoff until every one succeeds or is unfollowed. A pass that fails marks
   * nothing it did not mark already: the fires it could not read stay marked.
   */
  async function runReconciliation(): Promise<void> {
    let failures = 0;
    while (hasReconciliationToDo()) {
      // A subscription that ended on its own is reopened after a wait that grows with each end in
      // a row, however long after its last pass it ended.
      if (endedWithoutWait) {
        endedWithoutWait = false;
        await wait(backoff(consecutiveEnds));
        // The end's mark may have been cleared by a read that began before it: a new subscription
        // starts at the tail, so every followed fire is read from its history again.
        for (const runId of followedRuns) needsReconciliation.add(runId);
        continue;
      }
      let failed = false;
      try {
        await open().ready;
        for (const runId of Array.from(needsReconciliation)) {
          if (!followedRuns.has(runId)) {
            needsReconciliation.delete(runId);
            continue;
          }
          try {
            // Marked clean before the read: a mark made while it runs is not erased by it.
            needsReconciliation.delete(runId);
            await catchUp(runId);
          } catch (error) {
            // Only a fire still followed is marked again: one unfollowed meanwhile has nothing
            // left to read, and marking it would open a subscription that follows nothing.
            if (followedRuns.has(runId)) needsReconciliation.add(runId);
            failed = true;
            diagnose({
              level: 'error',
              scope: 'durable-event-history',
              message: `[bureau] Could not reconcile schedule fire "${runId}" with its history, and will try again: ${serializeUnknownError(error)}`,
              cause: error,
            });
          }
        }
      } catch (error) {
        failed = true;
        diagnose({
          level: 'error',
          scope: 'durable-event-history',
          message: `[bureau] Could not open the history subscription of the schedule fires this process holds a review of, and will try again: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      if (!failed) {
        failures = 0;
        continue;
      }
      // A subscription that failed to open has reported its end, which the wait above handles.
      if (endedWithoutWait) continue;
      failures += 1;
      await wait(backoff(failures));
    }
  }

  /** Marks fires for reconciliation and starts it unless one is already running. */
  function reconcile(runIds: Iterable<string>): void {
    for (const runId of runIds) if (followedRuns.has(runId)) needsReconciliation.add(runId);
    if (disposed || reconciling !== undefined || needsReconciliation.size === 0) return;
    reconciling = runReconciliation().finally(() => {
      reconciling = undefined;
      // A mark that landed as the pass ended is not left unread.
      if (needsReconciliation.size > 0) reconcile([]);
    });
  }

  /** The reads a gap makes necessary: a fire that cannot be read is reconciled, not dropped. */
  async function rereadAll(): Promise<void> {
    await Promise.all(
      [...followedRuns].map((runId) =>
        rereadWatching(runId).catch((error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'durable-event-history',
            message: `[bureau] Could not read the reviews of schedule fire "${runId}" again after a gap in its history, and will try again: ${serializeUnknownError(error)}`,
            cause: error,
          });
          reconcile([runId]);
        }),
      ),
    );
  }

  function clearStability(): void {
    if (stabilityTimer === undefined) return;
    cancelTimeout(stabilityTimer.handle);
    stabilityTimer = undefined;
  }

  function open(): DurableEventOwnersSubscription {
    if (subscription !== undefined && !subscription.closed) return subscription;
    const opened = history.subscribeEventHistoryOfOwners(handle, {
      onGap: rereadAll,
      // An event the feed could not decode: what it would have said is read from the state.
      onSkipped: (owner) => {
        const runId = owner.id;
        if (!followedRuns.has(runId)) return;
        rereadWatching(runId).catch((error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'durable-event-history',
            message: `[bureau] Could not read the reviews of schedule fire "${runId}" again after an event of its history could not be decoded, and will try again: ${serializeUnknownError(error)}`,
            cause: error,
          });
          reconcile([runId]);
        });
      },
      onEnded: () => {
        if (subscription !== opened) return;
        clearStability();
        consecutiveEnds += 1;
        endedWithoutWait = true;
        // The new subscription starts at the feed's tail, so what the old one had not read is
        // read from each fire's history.
        reconcile(followedRuns);
      },
    });
    for (const runId of followedRuns) opened.follow(runOwner(runId));
    subscription = opened;
    clearStability();
    const timer = {
      handle: scheduleTimeout(() => {
        if (stabilityTimer === timer) stabilityTimer = undefined;
        if (subscription === opened && !opened.closed) consecutiveEnds = 0;
      }, dependencies.maximumRetryDelayMilliseconds),
    };
    stabilityTimer = timer;
    return opened;
  }

  return {
    follow(runId) {
      if (disposed || followedRuns.has(runId)) return;
      followedRuns.add(runId);
      // Joined before its history is read, so what it recorded before is read there, what it
      // records after is delivered here, and nothing falls between.
      open().follow(runOwner(runId));
      reconcile([runId]);
    },
    unfollow(runId) {
      if (!followedRuns.delete(runId)) return;
      needsReconciliation.delete(runId);
      clearGrace(runId);
      subscription?.unfollow(runOwner(runId));
      if (followedRuns.size === 0) {
        subscription?.unsubscribe();
        subscription = undefined;
        clearStability();
      }
    },
    followed: () => [...followedRuns],
    reread: rereadWatching,
    async settled() {
      for (let running = reconciling; running !== undefined; running = reconciling) await running;
    },
    async dispose() {
      disposed = true;
      followedRuns.clear();
      needsReconciliation.clear();
      subscription?.unsubscribe();
      subscription = undefined;
      clearStability();
      for (const runId of Array.from(graceWaits.keys())) clearGrace(runId);
      for (const entry of Array.from(waits)) {
        cancelTimeout(entry.handle);
        entry.wake();
      }
      await reconciling;
      await Promise.allSettled(notifications);
    },
  };
}

const followerOfBureau = new WeakMap<object, FireReviewFollower>();

/** Remembers a Bureau's follower so a test can read it; nothing in production reads it. */
export function trackFireReviewFollower(bureau: object, follower: FireReviewFollower): void {
  followerOfBureau.set(bureau, follower);
}

/** The follower of a Bureau that {@link trackFireReviewFollower} was given. */
export function fireReviewFollowerOf(bureau: object): FireReviewFollower {
  const follower = followerOfBureau.get(bureau);
  if (follower === undefined) throw new Error('This Bureau has no tracked fire review follower.');
  return follower;
}
