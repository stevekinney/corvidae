/**
 * What is waiting on the caller, as one number: the Bureau's reviews, and the engine's when the
 * principal may read them. They are the entries `/reviews` reads, so the count and the list change
 * together. The navigation's Reviews badge and the Health overview's "Needs you" count both read it,
 * so the two can never disagree.
 */
import type { HttpClient } from '@lostgradient/weft';
import { createQuery } from '@tanstack/svelte-query';

import { useFleetEventsLive } from '../../app/live-polling.svelte.ts';
import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
import { partitionPendingReviews, pendingEntriesOnly } from './review-domain.ts';
import {
  REVIEW_POLL_MILLISECONDS,
  bureauReviewsQuery,
  weftReviewsQueryOptions,
} from './reviews-data.ts';

/** The number of reviews waiting on the caller, and whether it could not be read at all. */
export interface PendingReviewsCount {
  /** The count, or `undefined` while no source has answered. */
  readonly count: () => number | undefined;
  /** Whether every source that could answer has failed, so the count will not arrive. */
  readonly failed: () => boolean;
}

/**
 * The number of reviews waiting on the caller, from whichever sources have answered, and whether
 * it could not be read. The count is `undefined` while neither source has answered. The engine's reviews are counted as the page files them: one
 * past its deadline is under Timed out, not pending, and the deadline is checked as often as the
 * list is read. `client` is a getter, so the queries follow it. Call it while a component initializes, because it reads context and starts queries.
 */
export function usePendingReviewsCount(client: () => HttpClient): PendingReviewsCount {
  const principalStore = getPrincipalStore();
  const bureauReviews = bureauReviewsQuery();
  const fleetLive = useFleetEventsLive();
  const engineReviews = createQuery(
    () =>
      weftReviewsQueryOptions(
        client(),
        'pending',
        principalStore.hasScope('reviews:read'),
        fleetLive(),
      ),
    undefined,
  );

  let now = $state(Date.now());
  $effect(() => {
    // poll-reason: clock
    const timer = setInterval(() => {
      now = Date.now();
    }, REVIEW_POLL_MILLISECONDS);
    return () => clearInterval(timer);
  });

  const enginePending = $derived(
    partitionPendingReviews(pendingEntriesOnly(engineReviews.data ?? []), now).pending.length,
  );
  const count = $derived(
    bureauReviews.data === undefined && engineReviews.data === undefined
      ? undefined
      : (bureauReviews.data?.length ?? 0) +
          (principalStore.hasScope('reviews:read') ? enginePending : 0),
  );
  const failed = $derived(
    bureauReviews.isError && (!principalStore.hasScope('reviews:read') || engineReviews.isError),
  );
  return { count: () => count, failed: () => failed };
}
