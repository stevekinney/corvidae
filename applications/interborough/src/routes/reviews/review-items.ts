/**
 * What `/reviews` lists: the Bureau's pending reviews and the engine's, merged into one list. The
 * Bureau's are tool approvals and questions of the agents' runs (`bureau.reviews.list`); the
 * engine's are the human reviews of its workflows (`client.listReviews`). Each keeps its own row
 * and its own decision form, so an item says which it is.
 */
import type { CompletedReviewEntry, PendingReviewEntry } from '@lostgradient/weft';

import type { BureauReview } from '../../lib/bureau-reviews.ts';
import { chatSessionPath } from '../../lib/identifier-paths.ts';

export type ReviewItem =
  | {
      readonly source: 'bureau';
      /** Unique across both sources, for selection and keyed rendering. */
      readonly key: string;
      /** When the review was requested, in epoch milliseconds, for ordering. */
      readonly requestedAt: number;
      readonly review: BureauReview;
    }
  | {
      readonly source: 'weft';
      readonly key: string;
      readonly requestedAt: number;
      /** Pending in the list of what is waiting, and completed in the list of what was decided. */
      readonly entry: PendingReviewEntry | CompletedReviewEntry;
    };

/** One list from the two sources, the longest-waiting first. */
export function mergePendingReviews(
  bureau: readonly BureauReview[],
  weft: readonly PendingReviewEntry[],
): ReviewItem[] {
  const items: ReviewItem[] = [
    ...bureau
      .filter((review) => review.status === 'pending')
      .map((review): ReviewItem => ({
        source: 'bureau',
        key: `bureau:${review.id}`,
        requestedAt: review.requestedAt,
        review,
      })),
    ...weft.map(weftReviewItem),
  ];
  return items.sort(
    (left, right) => left.requestedAt - right.requestedAt || left.key.localeCompare(right.key),
  );
}

/** One of the engine's reviews as an item, whichever list it is in. */
export function weftReviewItem(entry: PendingReviewEntry | CompletedReviewEntry): ReviewItem {
  return { source: 'weft', key: `weft:${entry.reviewId}`, requestedAt: entry.createdAt, entry };
}

/** What a Bureau review's link goes to, or `undefined` while it is not yet known. */
export type BureauReviewTarget = {
  readonly kind: 'chat' | 'task' | 'run';
  readonly path: string;
};

/**
 * Where a Bureau review links: the chat when it names a session, otherwise its task when the Bureau
 * answers for the review's run, otherwise the run. `taskExists` is `undefined` until the Bureau has
 * been asked, and a review that needs the answer has no target until then.
 */
export function bureauReviewTarget(
  review: BureauReview,
  taskExists: boolean | undefined,
): BureauReviewTarget | undefined {
  if (review.sessionId !== undefined) {
    return { kind: 'chat', path: chatSessionPath(review.sessionId) };
  }
  if (taskExists === undefined) return undefined;
  const runId = encodeURIComponent(review.runId);
  return taskExists
    ? { kind: 'task', path: `/tasks/${runId}` }
    : { kind: 'run', path: `/runs/${runId}` };
}
