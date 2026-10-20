/**
 * The cache entries a review decision, or a task's answer, makes stale: the Bureau's reviews, the
 * engine's, and the Bureau's tasks, whose open waits are the reviews. Every place that decides a
 * review calls this, so the list, the navigation's count, and a task's page all read again at once
 * instead of waiting for their next poll.
 */
import type { QueryClient } from '@tanstack/svelte-query';

const REVIEW_QUERY_PREFIXES = [['bureau-reviews'], ['reviews'], ['bureau-tasks']] as const;

export function invalidateReviewQueries(queryClient: Pick<QueryClient, 'invalidateQueries'>) {
  return Promise.all(
    REVIEW_QUERY_PREFIXES.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}
