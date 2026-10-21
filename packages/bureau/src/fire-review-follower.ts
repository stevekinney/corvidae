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
 *   loaded, a release that rejects) and then reads the fire's reviews again from durable state, so
 *   a transient failure no longer leaves the peer's closing unread.
 * - A fire added while the subscription runs is caught up from its own history, read after the
 *   fire joins the subscription, so no event falls between the two.
 * - When the retention floor overtakes the subscription, the events it had not read are gone, so
 *   every followed fire's reviews are read again from durable state.
 * - A subscription that ends on its own is opened again, and every followed fire is caught up.
 *
 * @module fire-review-follower
 */

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
   */
  readonly reread: (runId: string) => Promise<void>;
  /** Waits between a reaction's attempts. */
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly diagnose: DiagnosticSink;
  /** How many times a reaction is attempted before the fire is read again. At least one. */
  readonly attempts: number;
  readonly retryDelayMilliseconds: number;
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
  /** Resolves once the catch-ups started so far have finished. For tests and shutdown. */
  settled(): Promise<void>;
  /** Ends the subscription and waits for the reactions in flight. Idempotent. */
  dispose(): Promise<void>;
}

const runOwner = (runId: string) => ({ kind: 'run', id: runId }) as const;

export function createFireReviewFollower(
  dependencies: FireReviewFollowerDependencies,
): FireReviewFollower {
  const { history, closeReview, reread, diagnose } = dependencies;
  const followedRuns = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  let subscription: DurableEventOwnersSubscription | undefined;
  let disposed = false;
  /** Consecutive times the subscription ended before it was ready again. */
  let failedReopens = 0;

  /** Runs `work` to completion without letting a failure escape, and remembers it as in flight. */
  function track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'durable-event-history',
        message: `[bureau] A followed schedule fire could not be reconciled: ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));
  }

  /**
   * Reacts to one closing event, retrying a failed reaction and then reading the fire again, so a
   * transient failure never leaves the event unread. A reaction that still fails is reported with
   * what it leaves stale, and the subscription goes on to the next event.
   */
  async function react(runId: string, reviewId: string, eventKind: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= dependencies.attempts; attempt += 1) {
      if (disposed || !followedRuns.has(runId)) return;
      try {
        await closeReview(runId, reviewId, eventKind);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < dependencies.attempts)
          await dependencies.sleep(dependencies.retryDelayMilliseconds);
      }
    }
    if (disposed || !followedRuns.has(runId)) return;
    try {
      await reread(runId);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'durable-event-history',
        message:
          `[bureau] Could not drop review "${reviewId}" of schedule fire "${runId}" after a peer's ` +
          `"${eventKind}", so this process may keep listing it: ${serializeUnknownError(lastError)}; ` +
          `reading it again failed too: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  async function handle(event: DurableEventEnvelope): Promise<void> {
    if (event.owner.kind !== 'run' || !REVIEW_CLOSING_EVENT_KINDS.has(event.kind)) return;
    const reviewId = (event.payload as { reviewId?: unknown } | null)?.reviewId;
    if (typeof reviewId !== 'string') return;
    await react(event.owner.id, reviewId, event.kind);
  }

  /**
   * Reads a fire's whole history for the closings it holds, as a fire added after the
   * subscription started needs: an event the subscription passed before the fire joined it is
   * only here. A history the retention floor has passed cannot be read, so the fire's reviews are
   * read again from durable state instead.
   */
  async function catchUp(runId: string): Promise<void> {
    let since: string | undefined;
    for (;;) {
      if (disposed || !followedRuns.has(runId)) return;
      const page = await history.page(runOwner(runId), {
        limit: CATCH_UP_PAGE_LIMIT,
        ...(since === undefined ? {} : { since }),
      });
      if (!('events' in page)) {
        await reread(runId);
        return;
      }
      for (const event of page.events) await handle(event);
      if (!page.hasMore || page.nextCursor === undefined) return;
      since = page.nextCursor;
    }
  }

  async function rereadAll(): Promise<void> {
    await Promise.allSettled(
      [...followedRuns].map((runId) =>
        reread(runId).catch((error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'durable-event-history',
            message: `[bureau] Could not read the reviews of schedule fire "${runId}" again after a gap in its history: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }),
      ),
    );
  }

  /** Opens the subscription again after it ended on its own, and catches every fire up. */
  async function reopen(): Promise<void> {
    await dependencies.sleep(dependencies.retryDelayMilliseconds);
    if (disposed || followedRuns.size === 0) return;
    await open().ready;
    failedReopens = 0;
    await Promise.all([...followedRuns].map((runId) => catchUp(runId)));
  }

  function open(): DurableEventOwnersSubscription {
    if (subscription !== undefined && !subscription.closed) return subscription;
    const opened = history.subscribeEventHistoryOfOwners(handle, {
      onGap: rereadAll,
      onEnded: () => {
        if (disposed || followedRuns.size === 0) return;
        // A subscription that keeps ending is not opened in a loop: the next fire to be followed
        // opens one again, and a gap or a reaction that fails reads the fires from durable state.
        failedReopens += 1;
        if (failedReopens > dependencies.attempts) {
          diagnose({
            level: 'error',
            scope: 'durable-event-history',
            message:
              '[bureau] The history subscription of the schedule fires this process holds a review ' +
              'of keeps ending, so it is not opened again until another fire is followed.',
          });
          return;
        }
        track(reopen());
      },
    });
    for (const runId of followedRuns) opened.follow(runOwner(runId));
    subscription = opened;
    return opened;
  }

  return {
    follow(runId) {
      if (disposed || followedRuns.has(runId)) return;
      followedRuns.add(runId);
      const opened = open();
      opened.follow(runOwner(runId));
      // Read the fire's earlier history only after it has joined the subscription, which is
      // positioned at the feed's tail: what it recorded before is read here, what it records
      // after is delivered there, and nothing falls between.
      track(
        opened.ready.then(() => {
          failedReopens = 0;
          return catchUp(runId);
        }),
      );
    },
    unfollow(runId) {
      if (!followedRuns.delete(runId)) return;
      subscription?.unfollow(runOwner(runId));
      if (followedRuns.size === 0) {
        subscription?.unsubscribe();
        subscription = undefined;
      }
    },
    followed: () => [...followedRuns],
    reread,
    async settled() {
      while (inFlight.size > 0) await Promise.allSettled(inFlight);
    },
    async dispose() {
      disposed = true;
      followedRuns.clear();
      subscription?.unsubscribe();
      subscription = undefined;
      await Promise.allSettled(inFlight);
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
