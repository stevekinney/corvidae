<script lang="ts">
  /**
   * The one count Home lists nowhere else, Failed in 24 hours, quiet and unframed (Cinder's
   * `StatisticGroup` in its `plain` variant). It sits after the Needs you list the Spotlight titles,
   * never between the Spotlight and its list (owner decision 2026-11-16, COR-2489).
   *
   * It follows the rule Health's counts follow (`lib/worth-showing.ts`, owner 2026-11-19): it is
   * shown only when it says something, so at zero, or while it has not answered, nothing is drawn.
   * One that cannot be read shows a dash; a caller who may not read runs gets nothing, since there
   * is nothing for them to act on. A number that was read stays when a later read fails. It is made
   * with the filter Health's count uses (`routes/health/health-counts.ts`), so the number agrees with
   * Health's rows, and a dot stands before its label.
   */
  import { Statistic, StatisticGroup } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import { countIsWorthShowing } from '../../lib/worth-showing.ts';
  import { parseWorkflowAggregateResult } from '../health/aggregate-output.ts';
  import { aggregateInputFor, failedRecentlyFilter } from '../health/health-counts.ts';

  const client: HttpClient = getClient();
  const principalStore = getPrincipalStore();

  const canReadRuns = $derived(principalStore.hasScope('workflows:read'));

  // The window is fixed when the page opens: the query asks for one instant.
  const failedFilter = failedRecentlyFilter(Date.now());
  const failedQuery = createQuery(() => ({
    queryKey: queryKeys.workflows.aggregate('status', failedFilter),
    queryFn: async () =>
      parseWorkflowAggregateResult(
        await client.operations['weft.workflows.aggregate'](aggregateInputFor(failedFilter)),
      ),
    enabled: canReadRuns,
  }));

  /**
   * The count's number: `undefined` while its read has not answered or the caller may not read
   * runs, and `null` when it could not be read. A number that was read stays after a later read
   * fails: old data keeps its place, as it does on every page.
   */
  const failed = $derived.by((): number | undefined | null => {
    if (!canReadRuns) return undefined;
    if (failedQuery.data !== undefined) return failedQuery.data.total;
    return failedQuery.isError ? null : undefined;
  });
</script>

{#if countIsWorthShowing({ value: failed })}
  <StatisticGroup
    label={HOME_COPY.countsLabel}
    columns={1}
    variant="plain"
    data-testid="home-counts"
  >
    <Statistic
      label={HOME_COPY.counts.failed}
      value={failed ?? HOME_COPY.unavailable}
      attention={failed !== null && failed !== undefined}
    />
  </StatisticGroup>
{/if}
