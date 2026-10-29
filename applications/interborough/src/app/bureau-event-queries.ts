/**
 * Keeps what the Bureau's views show current when `bureau.events` reports a change (COR-1722). The
 * shell's one shared Bureau source calls it; nothing here opens a connection.
 *
 * A frame names what changed, never the new value (the feed carries identifiers, not text), so each
 * mapping invalidates the entries that read it and lets them ask again:
 *
 * - `review.*` (a review requested, or settled any way): the reviews, the engine's list of them, and
 *   the Bureau's tasks, whose open waits are the reviews (`../lib/review-queries.ts`).
 * - `run.registered`, `run.settled`, `run.removed`, `action`, `task.cleanup-acknowledged`: the
 *   Bureau's tasks (the cleanup of a cancelled run is read from its task). A catalog run
 *   (`bureau.run()`) is announced by `run.settled` alone: its registration, actions and release are
 *   not published (`packages/bureau/src/create-bureau.ts`, COR-1302), so a view of runs reads such a
 *   run when it settles, and polls only while this feed is not live (COR-1730, COR-1725).
 * - `session.created`, `session.saved`, `session.deleted`: the chats (`['contexts']`), whose titles
 *   the notification feed and the runs list read.
 * - `goal.*`: the goals (`['goals']`).
 * - `run.registered`, `run.settled`, `goal.started`: a view whose probe found nothing to list, which
 *   one of these can fill (`../lib/empty-views.ts`).
 * - a gap, dropped frames, or a resync: all of the above. The page was not told something, so no
 *   entry the feed drives can be trusted until it has asked again.
 *
 * `action` is published for every step of a run, so it invalidates one prefix and nothing finer.
 */
import type { QueryClient } from '@tanstack/svelte-query';

import { invalidateEmptyViews } from '../lib/empty-views.ts';
import {
  BUREAU_FRAMES_DROPPED_KIND,
  BUREAU_GAP_KIND,
  BUREAU_RESYNC_KIND,
  type BureauEventFrame,
} from '../lib/live-source/bureau-event-frame.ts';
import { invalidateReviewQueries } from '../lib/review-queries.ts';

const BUREAU_TASKS_KEY_PREFIX = ['bureau-tasks'] as const;
const CONTEXTS_KEY_PREFIX = ['contexts'] as const;
const GOALS_KEY_PREFIX = ['goals'] as const;

const RUN_EVENT_KINDS: ReadonlySet<string> = new Set([
  'run.registered',
  'run.settled',
  'run.removed',
  'action',
  'task.cleanup-acknowledged',
]);

/** The kinds that can put the first item in a view that has nothing to list. */
const FIRST_ITEM_EVENT_KINDS: ReadonlySet<string> = new Set([
  'run.registered',
  'run.settled',
  'goal.started',
]);

const SESSION_EVENT_KINDS: ReadonlySet<string> = new Set([
  'session.created',
  'session.saved',
  'session.deleted',
]);

const RECOVERY_EVENT_KINDS: ReadonlySet<string> = new Set([
  BUREAU_GAP_KIND,
  BUREAU_FRAMES_DROPPED_KIND,
  BUREAU_RESYNC_KIND,
]);

/** Whether a kind is one of the feed's review events (`review.requested`, `review.approved`, and so on). */
export function isBureauReviewEventKind(kind: string): boolean {
  return kind.startsWith('review.');
}

/** Whether a kind is one of the feed's goal events (`goal.started`, `goal.succeeded`, and so on). */
export function isBureauGoalEventKind(kind: string): boolean {
  return kind.startsWith('goal.');
}

/** Invalidates every entry the Bureau feed drives. */
export function invalidateBureauDrivenQueries(queryClient: QueryClient): void {
  void invalidateReviewQueries(queryClient);
  void queryClient.invalidateQueries({ queryKey: BUREAU_TASKS_KEY_PREFIX });
  void queryClient.invalidateQueries({ queryKey: CONTEXTS_KEY_PREFIX });
  void queryClient.invalidateQueries({ queryKey: GOALS_KEY_PREFIX });
  invalidateEmptyViews(queryClient);
}

/**
 * Invalidates the entries one frame makes stale. Returns whether the frame was one the feed drives
 * a view from, so a caller can tell a handled frame from one it should leave alone.
 */
export function invalidateForBureauEvent(
  queryClient: QueryClient,
  frame: Pick<BureauEventFrame, 'kind'>,
): boolean {
  if (RECOVERY_EVENT_KINDS.has(frame.kind)) {
    invalidateBureauDrivenQueries(queryClient);
    return true;
  }
  if (isBureauReviewEventKind(frame.kind)) {
    // The reviews already invalidate the tasks, and the tasks are asked once.
    void invalidateReviewQueries(queryClient);
    return true;
  }
  let handled = false;
  if (RUN_EVENT_KINDS.has(frame.kind)) {
    void queryClient.invalidateQueries({ queryKey: BUREAU_TASKS_KEY_PREFIX });
    handled = true;
  }
  if (FIRST_ITEM_EVENT_KINDS.has(frame.kind)) {
    invalidateEmptyViews(queryClient);
    handled = true;
  }
  if (SESSION_EVENT_KINDS.has(frame.kind)) {
    void queryClient.invalidateQueries({ queryKey: CONTEXTS_KEY_PREFIX });
    handled = true;
  }
  if (isBureauGoalEventKind(frame.kind)) {
    void queryClient.invalidateQueries({ queryKey: GOALS_KEY_PREFIX });
    handled = true;
  }
  return handled;
}

/**
 * Subscribes the Bureau's views to a Bureau event source and returns the unsubscribe. The shell
 * calls it once, with its one shared source, so every view follows the Bureau whichever page is open.
 */
export function subscribeBureauInvalidation(
  source: { subscribe(listener: (frame: BureauEventFrame) => void): () => void },
  queryClient: QueryClient,
): () => void {
  return source.subscribe((frame) => void invalidateForBureauEvent(queryClient, frame));
}
