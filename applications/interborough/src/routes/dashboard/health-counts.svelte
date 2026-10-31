<script lang="ts">
  /**
   * The four counts under the health line: Working now, Needs you, Failed in 24h and Schedules. Each
   * is a link, and each opens the list it counted. The two engine-run counts are made with the
   * same filter their link carries (`health-counts.ts`, `engine-runs-link.ts`), so the number and
   * the rows agree. A number is coloured only when it is not zero and it is bad: Needs you is a
   * warning and Failed in 24h is danger. The others are plain, because a running run or a schedule
   * is not a problem.
   *
   * Each count reads on its own, so one that cannot be read shows a dash and leaves the other
   * three alone. A principal without the scope for a count sees the dash too, and the link still
   * opens the page, which says why it is locked.
   */
  import { Skeleton } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import { createQuery, type CreateQueryResult } from '@tanstack/svelte-query';

  import { HEALTH_OVERVIEW_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import { usePendingReviewsCount } from '../reviews/pending-reviews-count.svelte.ts';
  import type { WorkflowAggregateResult } from './aggregate-output.ts';
  import { parseWorkflowAggregateResult } from './aggregate-output.ts';
  import { engineRunsPath } from './engine-runs-link.ts';
  import { aggregateInputFor, failedRecentlyFilter, WORKING_NOW_FILTER } from './health-counts.ts';

  interface HealthCountsProps {
    /** The engine's runs counted by status, which the page also reads to know whether there are any. */
    statusQuery: CreateQueryResult<WorkflowAggregateResult>;
  }

  let { statusQuery }: HealthCountsProps = $props();

  const client: HttpClient = getClient();
  const principalStore = getPrincipalStore();

  // The window is fixed when the page opens: the query and the link share one instant.
  const failedFilter = failedRecentlyFilter(Date.now());
  const failedQuery = createQuery(() => ({
    queryKey: queryKeys.workflows.aggregate('status', failedFilter),
    queryFn: async () =>
      parseWorkflowAggregateResult(
        await client.operations['weft.workflows.aggregate'](aggregateInputFor(failedFilter)),
      ),
    enabled: principalStore.hasScope('workflows:read'),
  }));

  const waiting = usePendingReviewsCount(() => client);

  // The engine counts the active schedules; one row is read because only the total is used.
  const scheduleFilter = { status: 'active', limit: 1 } as const;
  const schedulesQuery = createQuery(() => ({
    queryKey: queryKeys.schedules.list(scheduleFilter),
    queryFn: () => client.listSchedules(scheduleFilter),
    enabled: principalStore.hasScope('schedules:read'),
  }));

  /** A count's number, `undefined` while it loads, and `null` when it cannot be read. */
  const workingNow = $derived(
    !principalStore.hasScope('workflows:read') || statusQuery.isError
      ? null
      : statusQuery.data === undefined
        ? undefined
        : (statusQuery.data.groups.find((group) => group.key === 'running')?.count ?? 0),
  );
  const failedRecently = $derived(
    !principalStore.hasScope('workflows:read') || failedQuery.isError
      ? null
      : failedQuery.data === undefined
        ? undefined
        : failedQuery.data.total,
  );
  const needsYou = $derived(waiting.failed() ? null : waiting.count());
  const activeSchedules = $derived(
    !principalStore.hasScope('schedules:read') || schedulesQuery.isError
      ? null
      : schedulesQuery.data === undefined
        ? undefined
        : schedulesQuery.data.total,
  );

  type Tone = 'neutral' | 'warning' | 'danger';
  interface Count {
    readonly label: string;
    readonly value: number | null | undefined;
    readonly href: string;
    readonly tone: Tone;
  }

  const counts = $derived<readonly Count[]>([
    {
      label: HEALTH_OVERVIEW_COPY.workingNow,
      value: workingNow,
      href: engineRunsPath(WORKING_NOW_FILTER),
      tone: 'neutral',
    },
    {
      label: HEALTH_OVERVIEW_COPY.needsYou,
      value: needsYou,
      href: '/reviews',
      tone: 'warning',
    },
    {
      label: HEALTH_OVERVIEW_COPY.failedIn24Hours,
      value: failedRecently,
      href: engineRunsPath(failedFilter),
      tone: 'danger',
    },
    {
      label: HEALTH_OVERVIEW_COPY.schedules,
      value: activeSchedules,
      href: '/schedules?status=active',
      tone: 'neutral',
    },
  ]);

  /** Opens `path` in place, and leaves a modified click to the browser. */
  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<nav class="weft-health-counts" aria-label={HEALTH_OVERVIEW_COPY.countsLabel}>
  {#each counts as count (count.label)}
    <a
      class="weft-health-count"
      href={router.href(count.href)}
      onclick={(event) => open(event, count.href)}
    >
      <span class="weft-health-count__label">{count.label}</span>
      {#if count.value === undefined}
        <span
          class="weft-health-count__value"
          role="status"
          aria-busy="true"
          aria-label={`Loading ${count.label}`}
        >
          <Skeleton height="1.75rem" width="3rem" />
        </span>
      {:else}
        <span
          class="weft-health-count__value"
          data-tone={count.value !== null && count.value > 0 ? count.tone : 'neutral'}
        >
          {count.value ?? HEALTH_OVERVIEW_COPY.unavailable}
        </span>
      {/if}
    </a>
  {/each}
</nav>
