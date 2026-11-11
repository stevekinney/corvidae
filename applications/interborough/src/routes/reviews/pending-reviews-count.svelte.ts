/**
 * What is waiting on the caller, as one number: the length of the list `/reviews` shows, read from
 * the same merged query and de-duplicated by the same function (`waitingItems`), so the navigation's
 * Reviews badge, the Health overview's "Needs you" count and the page's Waiting tab can never
 * disagree.
 */
import { waitingItems } from './review-items.ts';
import { waitingReviewsQuery } from './reviews-data.ts';

/** The number of reviews waiting on the caller, and whether it could not be read at all. */
export interface PendingReviewsCount {
  /** The count, or `undefined` while no source has answered. */
  readonly count: () => number | undefined;
  /** Whether every source that could answer has failed, so the count will not arrive. */
  readonly failed: () => boolean;
}

/**
 * The number of reviews waiting on the caller, as `/reviews` lists them, and whether it could not
 * be read. The count is `undefined` until the list has answered. Call it while a component
 * initializes, because it reads context and starts a query.
 */
export function usePendingReviewsCount(): PendingReviewsCount {
  const waiting = waitingReviewsQuery();
  const count = $derived(
    waiting.data === undefined ? undefined : waitingItems(waiting.data).length,
  );
  return { count: () => count, failed: () => waiting.isError && waiting.data === undefined };
}
