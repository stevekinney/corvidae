<script lang="ts">
  /**
   * Home's four counts, in one row: Running now, Needs you, Failed in 24 hours and Missed schedule
   * runs (7 days), the labels and windows Health uses. A dot stands before a label only when its
   * count is above zero and bad (reviews waiting, a run that failed, a schedule that missed runs);
   * a running run is not a problem, so Running now never has one.
   *
   * Each count reads on its own: one that cannot be read, or that this caller may not read, shows a
   * dash and leaves the other three alone. Running now counts the Bureau's runs that are going
   * (`countRunningTasks`), never one parked on a review; Failed in 24 hours is made with the filter
   * Health's count uses (`routes/dashboard/health-counts.ts`), so the number agrees with its rows.
   */
  import { Statistic, StatisticGroup } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy.ts';
  import { useBureauEventsLive } from '../../app/live-polling.svelte.ts';
  import { countRunningTasks } from '../../lib/bureau-tasks.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import { parseWorkflowAggregateResult } from '../dashboard/aggregate-output.ts';
  import { aggregateInputFor, failedRecentlyFilter } from '../dashboard/health-counts.ts';
  import { usePendingReviewsCount } from '../reviews/pending-reviews-count.svelte.ts';
  import { missedRunCount } from './home-rows.ts';
  import { useAttentionItems } from './home-queries.svelte.ts';

  /** How often the running count is read again while the Bureau's event feed is not live. */
  const RUNNING_POLL_MILLISECONDS = 5_000;

  const client: HttpClient = getClient();
  const principalStore = getPrincipalStore();
  const copy = HOME_COPY.counts;

  const canReadRuns = $derived(principalStore.hasScope('workflows:read'));

  // The window is fixed when the page opens: the query asks for one instant.
  const failedFilter = failedRecentlyFilter(Date.now());
  // Running now counts the runs that are going. A run parked on a review is waiting on a person,
  // which Needs you counts, so the engine's own count of runs in the running state would say two
  // runs are running when both wait.
  const bureauLive = useBureauEventsLive();
  const runningQuery = createQuery(() => ({
    queryKey: queryKeys.bureauTasks.running(),
    queryFn: ({ signal }: { signal: AbortSignal }) => countRunningTasks({ signal }),
    // poll-reason: fallback
    refetchInterval: bureauLive() ? false : RUNNING_POLL_MILLISECONDS,
    retry: false,
  }));
  const failedQuery = createQuery(() => ({
    queryKey: queryKeys.workflows.aggregate('status', failedFilter),
    queryFn: async () =>
      parseWorkflowAggregateResult(
        await client.operations['weft.workflows.aggregate'](aggregateInputFor(failedFilter)),
      ),
    enabled: canReadRuns,
  }));
  const waiting = usePendingReviewsCount(() => client);
  const attention = useAttentionItems();

  /** What one count shows: its number, or the dash where it is not read (yet, or at all). */
  function shown(value: number | undefined | null): number | string {
    return value ?? HOME_COPY.unavailable;
  }

  const running = $derived(runningQuery.isError ? null : runningQuery.data);
  const failed = $derived(
    !canReadRuns || failedQuery.isError
      ? null
      : failedQuery.data === undefined
        ? undefined
        : failedQuery.data.total,
  );
  const needsYou = $derived(waiting.failed() ? null : waiting.count());
  const missed = $derived(
    attention.isError
      ? null
      : attention.data === undefined
        ? undefined
        : missedRunCount(attention.data),
  );

  /** Whether a count is above zero, which is what makes a bad one worth a dot. */
  function above(value: number | undefined | null): boolean {
    return value !== undefined && value !== null && value > 0;
  }
</script>

<StatisticGroup
  label={HOME_COPY.countsLabel}
  columns={4}
  variant="cards"
  edge="border"
  data-testid="home-counts"
>
  <Statistic label={copy.running} value={shown(running)} />
  <Statistic label={copy.needsYou} value={shown(needsYou)} attention={above(needsYou)} />
  <Statistic label={copy.failed} value={shown(failed)} attention={above(failed)} />
  <Statistic label={copy.missed} value={shown(missed)} attention={above(missed)} />
</StatisticGroup>
