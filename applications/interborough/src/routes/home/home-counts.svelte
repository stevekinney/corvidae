<script lang="ts">
  /**
   * Home's four counts, in one row: Running now, Needs you, Failed in 24 hours and Missed schedule
   * runs (7 days), the labels and windows Health uses. A dot stands before a label only when its
   * count is above zero and bad (reviews waiting, a run that failed, a schedule that missed runs);
   * a running run is not a problem, so Running now never has one.
   *
   * Each count reads on its own, and the row's reads are its own: the Needs attention card and the
   * Needs you card cannot make a count read differently. One that has not answered yet shows a
   * placeholder where the number goes; one that cannot be read, or that this caller may not read,
   * shows a dash; a number that was read stays when a later read fails. None touches the other three. Running now counts the Bureau's runs that are going
   * (`useRunningTasks`, the read the Running now card lists), never one parked on a review; Failed in 24 hours is made with the filter
   * Health's count uses (`routes/health/health-counts.ts`), so the number agrees with its rows.
   */
  import { Statistic, StatisticGroup } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import { parseWorkflowAggregateResult } from '../health/aggregate-output.ts';
  import { aggregateInputFor, failedRecentlyFilter } from '../health/health-counts.ts';
  import { usePendingReviewsCount } from '../reviews/pending-reviews-count.svelte.ts';
  import { missedRunCount } from './home-rows.ts';
  import { useAttentionCountItems, useRunningTasks } from './home-queries.svelte.ts';

  const client: HttpClient = getClient();
  const principalStore = getPrincipalStore();
  const copy = HOME_COPY.counts;

  const canReadRuns = $derived(principalStore.hasScope('workflows:read'));

  // The window is fixed when the page opens: the query asks for one instant.
  const failedFilter = failedRecentlyFilter(Date.now());
  // Running now counts the runs that are going. A run parked on a review is waiting on a person,
  // which Needs you counts, so the engine's own count of runs in the running state would say two
  // runs are running when both wait.
  const runningQuery = useRunningTasks();
  const failedQuery = createQuery(() => ({
    queryKey: queryKeys.workflows.aggregate('status', failedFilter),
    queryFn: async () =>
      parseWorkflowAggregateResult(
        await client.operations['weft.workflows.aggregate'](aggregateInputFor(failedFilter)),
      ),
    enabled: canReadRuns,
  }));
  const waiting = usePendingReviewsCount();
  const attention = useAttentionCountItems();

  /** What one count shows: its number, or the dash where it is not read at all. */
  function shown(value: number | undefined | null): number | string {
    return value ?? HOME_COPY.unavailable;
  }

  /**
   * A count's number while its read has not answered is `undefined` (a placeholder holds the place),
   * and `null` when it cannot be read at all. A number that was read stays after a later read
   * fails: old data keeps its place, as it does on every page.
   */
  function counted(
    value: number | undefined,
    failed: boolean,
    readable = true,
  ): number | undefined | null {
    if (!readable) return null;
    if (value !== undefined) return value;
    return failed ? null : undefined;
  }

  const running = $derived(counted(runningQuery.data?.length, runningQuery.isError));
  const failed = $derived(counted(failedQuery.data?.total, failedQuery.isError, canReadRuns));
  const needsYou = $derived(counted(waiting.count(), waiting.failed()));
  const missed = $derived(
    counted(
      attention.data === undefined ? undefined : missedRunCount(attention.data),
      attention.isError,
    ),
  );

  /** Whether a count is above zero, which is what makes a bad one worth a dot. */
  function above(value: number | undefined | null): boolean {
    return value !== undefined && value !== null && value > 0;
  }
</script>

<StatisticGroup label={HOME_COPY.countsLabel} columns={4} variant="cards" data-testid="home-counts">
  <Statistic label={copy.running} value={shown(running)} loading={running === undefined} />
  <Statistic
    label={copy.needsYou}
    value={shown(needsYou)}
    loading={needsYou === undefined}
    attention={above(needsYou)}
  />
  <Statistic
    label={copy.failed}
    value={shown(failed)}
    loading={failed === undefined}
    attention={above(failed)}
  />
  <Statistic
    label={copy.missed}
    value={shown(missed)}
    loading={missed === undefined}
    attention={above(missed)}
  />
</StatisticGroup>
