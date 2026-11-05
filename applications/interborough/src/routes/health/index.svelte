<script lang="ts">
  /**
   * Health (`/health`), the Overview tab: what is wrong and what just happened. Four counts, then
   * Needs attention, the system problems that need a person now (the page's status, so no banner
   * sits above it), Recent activity under it, and three metric cards beside them; Advanced at the
   * foot holds the diagnostics (metrics, alerts and checks). The Health frame (`health-frame.svelte`)
   * carries the heading, the storage line, the Live indicator and the tabs. Each band reads on its
   * own, so one that fails shows its own state and the rest stay.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { getClient } from '../../lib/client.ts';
  import { readAttention } from '../../lib/bureau-attention.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { getPrincipalStore, isForbidden } from '../../lib/scopes.svelte.ts';
  import { waitingReviewsQuery } from '../reviews/reviews-data.ts';
  import { aggregateInputFor, failedRecentlyFilter } from './health-counts.ts';
  import { parseWorkflowAggregateResult } from './aggregate-output.ts';
  import AdvancedDiagnostics from './advanced-diagnostics.svelte';
  import { attentionRows } from './attention-rows.ts';
  import HealthCountsRow from './health-counts-row.svelte';
  import HealthFrame from './health-frame.svelte';
  import { HEALTH_COUNTS_COPY as counts } from './health-copy.ts';
  import {
    medianFinish,
    type HealthCount,
    OVERVIEW_WINDOW_MS,
    parseRunPage,
    runningNow,
    startedSummary,
    waitingCaption,
    waitingRuns,
  } from './health-overview-data.ts';
  import MetricCards from './metric-cards.svelte';
  import NeedsAttention from './needs-attention.svelte';
  import RecentActivity from './recent-activity.svelte';
  import { loadRecentActivity } from './recent-activity-data.ts';
  import { useStorageSizes } from './storage-sizes.svelte.ts';

  /** How long a first read is let to finish before anything is drawn for it (the loading rule). */
  const LOADING_DELAY_MILLISECONDS = 300;

  const client = getClient();
  const principalStore = getPrincipalStore();
  const canReadRuns = $derived(principalStore.hasScope('workflows:read'));

  /** The clock the windows are cut from, moved a minute at a time so a query and its window agree. */
  let now = $state(Math.floor(Date.now() / 60_000) * 60_000);
  $effect(() => {
    // poll-reason: clock
    const timer = setInterval(() => {
      now = Math.floor(Date.now() / 60_000) * 60_000;
    }, 60_000);
    return () => clearInterval(timer);
  });

  const attention = createQuery(() => ({
    queryKey: queryKeys.bureauAttention.list(),
    queryFn: ({ signal }) => readAttention({ signal }),
    // poll-reason: timer
    refetchInterval: 30_000,
    retry: false,
  }));
  const attentionForbidden = $derived(attention.isError && isForbidden(attention.error));

  const waiting = waitingReviewsQuery();
  const waitingByRun = $derived(waitingRuns(waiting.data ?? []));

  const runningRuns = createQuery(() => ({
    queryKey: ['health', 'runs', 'running'],
    queryFn: async () =>
      parseRunPage(
        await client.operations['weft.workflows.list']({ status: 'running', limit: 200 }),
      ),
    enabled: canReadRuns,
    // poll-reason: timer
    refetchInterval: 15_000,
    retry: false,
  }));
  const startedRuns = createQuery(() => ({
    queryKey: ['health', 'runs', 'started', now],
    queryFn: async () =>
      parseRunPage(
        await client.operations['weft.workflows.list']({
          createdAt: { gte: now - OVERVIEW_WINDOW_MS },
          limit: 200,
        }),
      ),
    // The window moves a minute at a time and so does the key; the figures stay until the next ones arrive.
    placeholderData: (previous) => previous,
    enabled: canReadRuns,
    // poll-reason: timer
    refetchInterval: 15_000,
    retry: false,
  }));
  const previousRuns = createQuery(() => ({
    queryKey: ['health', 'runs', 'previous', now],
    queryFn: async () =>
      parseRunPage(
        await client.operations['weft.workflows.list']({
          createdAt: { gte: now - 2 * OVERVIEW_WINDOW_MS, lt: now - OVERVIEW_WINDOW_MS },
          limit: 200,
        }),
      ),
    placeholderData: (previous) => previous,
    enabled: canReadRuns,
    // poll-reason: timer
    refetchInterval: 60_000,
    retry: false,
  }));
  const failedFilter = $derived(failedRecentlyFilter(now));
  const failedRuns = createQuery(() => ({
    queryKey: queryKeys.workflows.aggregate('status', failedFilter),
    queryFn: async () =>
      parseWorkflowAggregateResult(
        await client.operations['weft.workflows.aggregate'](aggregateInputFor(failedFilter)),
      ),
    enabled: canReadRuns,
    retry: false,
  }));

  const activity = createQuery(() => ({
    queryKey: [
      'health',
      'activity',
      attention.dataUpdatedAt,
      [...waitingByRun]
        .map(([run, kind]) => `${run}:${kind}`)
        .toSorted()
        .join(','),
    ],
    queryFn: ({ signal }) =>
      loadRecentActivity({
        attention: attention.data?.items ?? [],
        waitingRuns: waitingByRun,
        now: Date.now(),
        signal,
      }),
    enabled: !attention.isPending && !waiting.isPending,
    // poll-reason: timer
    refetchInterval: 30_000,
    retry: false,
  }));

  const sizes = useStorageSizes();

  const rows = $derived(
    attention.data === undefined ? undefined : attentionRows(attention.data.items),
  );
  const storageAlert = $derived(
    attention.data?.items.find((item) => item.kind === 'alert' && item.metric === 'storage.size'),
  );
  const storageBytes = $derived(
    sizes.samples().at(-1)?.bytes ??
      (storageAlert?.kind === 'alert' ? storageAlert.currentValue : undefined),
  );

  const started = $derived.by(() => {
    if (!canReadRuns || startedRuns.isError) return null;
    if (startedRuns.data === undefined) return undefined;
    return startedSummary(startedRuns.data, waitingByRun, previousRuns.data?.length);
  });
  const finish = $derived.by(() => {
    if (!canReadRuns || startedRuns.isError) return null;
    if (startedRuns.data === undefined) return undefined;
    return medianFinish(startedRuns.data, waitingByRun) ?? 'none';
  });

  const missedItems = $derived(
    (attention.data?.items ?? []).flatMap((item) => (item.kind === 'missed-runs' ? [item] : [])),
  );

  const runningCount = $derived<HealthCount>({
    value:
      !canReadRuns || runningRuns.isError
        ? null
        : runningRuns.data === undefined
          ? undefined
          : runningNow(runningRuns.data, waitingByRun),
    caption: counts.running(
      runningRuns.data === undefined ? 0 : runningNow(runningRuns.data, waitingByRun),
    ),
    bad: false,
  });
  const needsYouCount = $derived<HealthCount>({
    value: waiting.isError ? null : waiting.data === undefined ? undefined : waiting.data.length,
    caption: waitingCaption(waiting.data ?? []),
    bad: true,
  });
  const failedCount = $derived<HealthCount>({
    value:
      !canReadRuns || failedRuns.isError
        ? null
        : failedRuns.data === undefined
          ? undefined
          : failedRuns.data.total,
    caption: counts.failed(failedRuns.data?.total ?? 0),
    bad: true,
  });
  const missedCount = $derived<HealthCount>({
    value: attention.isError
      ? null
      : attention.data === undefined
        ? undefined
        : missedItems.reduce((sum, item) => sum + item.count, 0),
    caption:
      missedItems.length === 0
        ? counts.everyRunStarted
        : missedItems.map((item) => item.scheduleName ?? 'A schedule').join(', '),
    bad: true,
  });

  /**
   * Whether the page is still waiting for its first answers (rows 76w and 76x): the list of what
   * needs attention, or any of the four counts. Nothing but the frame is drawn for the first
   * 300 ms, so a read that is quick never flashes a placeholder; after that the page keeps its
   * layout and shows placeholders where figures and rows will be. It is a first-load state only:
   * once everything has answered, a later read never brings the placeholders back.
   */
  const firstReadPending = $derived(
    (attention.data === undefined && !attention.isError) ||
      [runningCount, needsYouCount, failedCount, missedCount].some(
        (count) => count.value === undefined,
      ),
  );
  let settled = $state(false);
  $effect(() => {
    if (!firstReadPending) settled = true;
  });
  const loading = $derived(firstReadPending && !settled);

  let revealed = $state(false);
  $effect(() => {
    // poll-reason: timer
    const timer = setTimeout(() => {
      revealed = true;
    }, LOADING_DELAY_MILLISECONDS);
    return () => clearTimeout(timer);
  });
</script>

<HealthFrame active="overview" live={!loading}>
  {#if !loading || revealed}
    <div class="ib-health-overview">
      <HealthCountsRow
        running={runningCount}
        needsYou={needsYouCount}
        failed={failedCount}
        missed={missedCount}
        {loading}
      />

      <div class="ib-health-overview__grid">
        <div class="ib-health-overview__attention">
          <NeedsAttention
            {rows}
            failed={attention.isError && !attentionForbidden}
            forbidden={attentionForbidden}
            onRetry={() => void attention.refetch()}
          />
        </div>
        <div class="ib-health-overview__metrics">
          <MetricCards {storageBytes} samples={sizes.samples()} {started} {finish} {loading} />
        </div>
        {#if !loading}
          <div class="ib-health-overview__activity">
            <RecentActivity
              lines={activity.data?.lines}
              total={activity.data?.total}
              failed={activity.isError}
              onRetry={() => void activity.refetch()}
            />
          </div>
        {/if}
      </div>

      {#if !loading}
        <AdvancedDiagnostics attention={attention.data} />
      {/if}
    </div>
  {/if}
</HealthFrame>

<style>
  .ib-health-overview {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-5);
    min-width: 0;
    container-type: inline-size;
  }

  /* Needs attention and Recent activity share the wide column, the metric cards the narrow one
   * beside them. Narrower than 56rem the cards sit under Needs attention and Recent activity
   * follows. */
  .ib-health-overview__grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'attention'
      'metrics'
      'activity';
    gap: var(--cinder-space-5);
    align-items: start;
  }

  @container (min-width: 56rem) {
    .ib-health-overview__grid {
      grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem);
      grid-template-areas:
        'attention metrics'
        'activity metrics';
    }
  }

  .ib-health-overview__attention {
    grid-area: attention;
    min-width: 0;
  }

  .ib-health-overview__metrics {
    grid-area: metrics;
    min-width: 0;
    container-type: inline-size;
  }

  .ib-health-overview__activity {
    grid-area: activity;
    min-width: 0;
  }
</style>
