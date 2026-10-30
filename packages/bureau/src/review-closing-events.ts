/**
 * What closes a review (COR-1613), defined once for every reader of it.
 *
 * A review is closed when it is decided, expires, is revoked or is canceled. A re-gate
 * (`superseded`) is not a closing: the approval keeps its id and stays pending at the next round.
 */

import { boundedReviewId } from './review-decision-record';

/** The statuses after which a review is closed. */
export const TERMINAL_REVIEW_STATUSES: ReadonlySet<string> = new Set([
  'approved',
  'denied',
  'rejected',
  'expired',
  'revoked',
  'canceled',
]);

/** The durable event kinds that close a review: `review.<terminal status>`. */
export const REVIEW_CLOSING_EVENT_KINDS: ReadonlySet<string> = new Set(
  [...TERMINAL_REVIEW_STATUSES].map((status) => `review.${status}`),
);

/**
 * The principal on a `review.superseded` that closes an abandoned request (COR-1613): the replay of
 * a schedule fire ending the request of an attempt that died before it committed its step. A
 * re-gate carries the principal that re-gated, so this one marks a request nothing can decide.
 */
export const REPLAY_SUPERSEDING_PRINCIPAL = 'system:replay';

/** The durable event kind that ends a request without closing the review. */
export const REVIEW_SUPERSEDED_EVENT_KIND = 'review.superseded';

/**
 * The deduplication key of the one `canceled` closing of a review round (COR-1621). The audit
 * record and the history event of that closing both carry it, so two instances that observe the
 * same cancel and both find the round open write one record of that round, not two. A re-gated approval
 * keeps its id across rounds and each round it leaves is closed on its own, so the key is scoped
 * to the review id and the round; a human wait has one round, `0`. The key is a persisted storage
 * key, so the review id in it is bounded as the decision record bounds its own (`boundedReviewId`):
 * an id that fits in 128 UTF-8 bytes appears as is, and a longer one, such as a human wait on a long
 * signal name, as a fixed-length digest of it.
 */
export function reviewCanceledDedupeKey(reviewId: string, round: number): string {
  const kind = reviewId.startsWith('approval:') ? 'approval' : 'human-wait';
  return `review.canceled:${boundedReviewId(reviewId, kind)}:${round}`;
}
