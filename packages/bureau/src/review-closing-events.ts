/**
 * What closes a review (COR-1613), defined once for every reader of it.
 *
 * A review is closed when it is decided, expires, is revoked or is canceled. A re-gate
 * (`superseded`) is not a closing: the approval keeps its id and stays pending at the next round.
 */

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

/** The durable event kind that ends a request without closing the review. */
export const REVIEW_SUPERSEDED_EVENT_KIND = 'review.superseded';
