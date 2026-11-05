/**
 * How many system problems need attention now, as one number the sidebar's Health dot reads
 * (`bureau.health.attention`). It is `undefined` until the Bureau answers, and stays so for a
 * caller it refuses (a principal without `bureau.diagnostics:read`), so the dot is left out
 * instead of claiming that nothing needs attention.
 *
 * Nothing in the event feeds announces an alert starting to fire or a schedule missing a run, so the
 * count is asked for again on a timer.
 */
import { createQuery } from '@tanstack/svelte-query';

import { getAttentionCount } from '../../lib/bureau-attention.ts';
import { queryKeys } from '../../lib/query.ts';

/** How often the count is read again. */
export const ATTENTION_POLL_MILLISECONDS = 30_000;

/** The number of problems that need attention, and whether it could not be read. */
export interface AttentionCount {
  /** The count, or `undefined` while the Bureau has not answered or refused it. */
  readonly count: () => number | undefined;
}

/** Reads the attention count. Call it while a component initializes, because it starts a query. */
export function useAttentionCount(): AttentionCount {
  const query = createQuery(() => ({
    queryKey: queryKeys.bureauAttention.count(),
    queryFn: ({ signal }: { signal: AbortSignal }) => getAttentionCount({ signal }),
    // poll-reason: fallback
    refetchInterval: ATTENTION_POLL_MILLISECONDS,
    retry: false,
  }));
  return { count: () => (query.isError ? undefined : query.data) };
}
