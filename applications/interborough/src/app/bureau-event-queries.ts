/**
 * Keeps what the Bureau's views show current when `bureau.events` reports a change (COR-1722). The
 * shell's one shared Bureau source calls it; nothing here opens a connection.
 *
 * A frame names what changed, never the new value (the feed carries identifiers, not text), so each
 * mapping invalidates the entries that read it and lets them ask again:
 *
 * - `review.*` (a review requested, or settled any way): the reviews, the engine's list of them, and
 *   the Bureau's tasks, whose open waits are the reviews (`../lib/review-queries.ts`).
 * - `run.registered`, `run.settled`, `run.removed`, `action`: the Bureau's tasks. A catalog run
 *   (`bureau.run()`) is announced by `run.settled` alone: its registration, actions and release are
 *   not published (`packages/bureau/src/create-bureau.ts`, COR-1302), so a view of runs still polls
 *   (COR-1730, COR-1725).
 * - a gap, dropped frames, or a resync: all of the above. The page was not told something, so no
 *   entry the feed drives can be trusted until it has asked again.
 *
 * `action` is published for every step of a run, so it invalidates one prefix and nothing finer.
 */
import type { QueryClient } from '@tanstack/svelte-query';

import {
  BUREAU_FRAMES_DROPPED_KIND,
  BUREAU_GAP_KIND,
  BUREAU_RESYNC_KIND,
  type BureauEventFrame,
} from '../lib/live-source/bureau-event-frame.ts';
import { invalidateReviewQueries } from '../lib/review-queries.ts';

const BUREAU_TASKS_KEY_PREFIX = ['bureau-tasks'] as const;

const RUN_EVENT_KINDS: ReadonlySet<string> = new Set([
  'run.registered',
  'run.settled',
  'run.removed',
  'action',
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

/** Invalidates every entry the Bureau feed drives. */
export function invalidateBureauDrivenQueries(queryClient: QueryClient): void {
  void invalidateReviewQueries(queryClient);
  void queryClient.invalidateQueries({ queryKey: BUREAU_TASKS_KEY_PREFIX });
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
  if (RUN_EVENT_KINDS.has(frame.kind)) {
    void queryClient.invalidateQueries({ queryKey: BUREAU_TASKS_KEY_PREFIX });
    return true;
  }
  return false;
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
