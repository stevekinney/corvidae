<script lang="ts">
  /**
   * What leads Home: a Spotlight that says how many reviews wait on you ("2 need you", "Nothing
   * needs you"), and under it the one count Home lists nowhere else, Failed in 24 hours, quiet and
   * unframed (Cinder's `StatisticGroup` in its `plain` variant). Running now has its own list, the
   * reviews waiting are the Spotlight and the list under it, and a schedule that missed runs is a
   * row under Needs attention, so none of them is a count here.
   *
   * The Spotlight is the title of the Needs you list under it, so "Open Reviews ›" (Cinder's `Link`
   * in its `more` form) sits beside it as that section's action, and the list draws no heading of
   * its own: the page says "needs you" once. With nothing waiting the Spotlight stands alone with
   * its link. It reads the same list as Needs you (`waitingReviewsQuery`), so the two cannot
   * disagree. While that read has not answered a placeholder holds the Spotlight's place; when it
   * fails the Spotlight is left out, and the Needs you section takes its heading back and says it
   * could not load.
   *
   * The count reads on its own: one that has not answered shows a placeholder where the number
   * goes; one that cannot be read, or that this caller may not read, shows a dash; a number that was
   * read stays when a later read fails. It is made with the filter Health's count uses
   * (`routes/health/health-counts.ts`), so the number agrees with Health's rows, and a dot stands
   * before its label only when it is above zero.
   */
  import {
    Link,
    Skeleton,
    Spotlight,
    Stack,
    Statistic,
    StatisticGroup,
  } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import { parseWorkflowAggregateResult } from '../health/aggregate-output.ts';
  import { aggregateInputFor, failedRecentlyFilter } from '../health/health-counts.ts';
  import { waitingReviewsQuery } from '../reviews/reviews-data.ts';
  import { openInApplication } from './home-navigation.ts';
  import { needsYouRows } from './home-rows.ts';

  const client: HttpClient = getClient();
  const principalStore = getPrincipalStore();
  const reviews = waitingReviewsQuery();

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

  const waiting = $derived(
    reviews.data === undefined
      ? undefined
      : needsYouRows(reviews.data, { agents: undefined, tools: undefined }).length,
  );

  /**
   * The count's number while its read has not answered is `undefined` (a placeholder holds the
   * place), and `null` when it cannot be read at all. A number that was read stays after a later
   * read fails: old data keeps its place, as it does on every page.
   */
  const failed = $derived.by((): number | undefined | null => {
    if (!canReadRuns) return null;
    if (failedQuery.data !== undefined) return failedQuery.data.total;
    return failedQuery.isError ? null : undefined;
  });
</script>

<!-- The count sits under the Spotlight, never beside it: a statistic group sizes itself from the
     width it is given, so it takes the column's. -->
<Stack gap="var(--cinder-space-4)" data-testid="home-focus">
  {#if waiting !== undefined}
    <!-- The Spotlight is the title of the reviews under it, so the way out to Reviews sits beside
         it, as a section's action sits beside its heading. -->
    <div class="ib-home-focus__lead">
      <Spotlight value={HOME_COPY.needsYou.spotlight(waiting)} data-testid="home-spotlight" />
      <Link
        variant="more"
        href={router.href('/reviews')}
        onclick={(event: MouseEvent) => openInApplication(event, '/reviews')}
        >{HOME_COPY.needsYou.link}</Link
      >
    </div>
  {:else if !reviews.isError}
    <Skeleton width="11rem" height="2.25rem" radius="var(--cinder-radius-md)" />
  {/if}
  <StatisticGroup
    label={HOME_COPY.countsLabel}
    columns={1}
    variant="plain"
    data-testid="home-counts"
  >
    <Statistic
      label={HOME_COPY.counts.failed}
      value={failed ?? HOME_COPY.unavailable}
      loading={failed === undefined}
      attention={failed !== undefined && failed !== null && failed > 0}
    />
  </StatisticGroup>
</Stack>

<style>
  /* The Spotlight and, at the end of its line, the way out to Reviews. On a phone too narrow for both
   * the link drops under the Spotlight at the start, never squeezing it. */
  .ib-home-focus__lead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-1) var(--cinder-space-4);
    min-inline-size: 0;
  }
</style>
