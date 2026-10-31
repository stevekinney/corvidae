<script lang="ts">
  /**
   * Health (`/health`), the engine's overview. The sidebar's Health item is the way in to it, and
   * its links are the way in to the engine's other pages: Workers, Storage and the audit log.
   * Three bands, each reading on its own: one health line, four counts that open the list they
   * counted, and a window of the latest six things that happened. They sit behind a page-level
   * state machine (default, loading, empty, unreachable); past that gate each band has its own
   * skeleton and its own failure, so one slow read never holds the others.
   *
   * Query option getters track reactive inputs, including the health gate
   * below. Results expose reactive properties directly and their effects
   * are disposed with the component.
   */
  import { ArrowRight, Rocket } from '@lucide/svelte';
  import { Button, EmptyState, ErrorState, Link, PageHeader, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import { NAVIGATION_COPY, VIEW_COPY } from '../../app/copy.ts';
  import HealthCounts from './health-counts.svelte';
  import { parseWorkflowAggregateResult } from './aggregate-output.ts';
  import ActivityFeedBand from './activity-feed-band.svelte';
  import HealthLine from './health-line.svelte';
  import { probeHealth } from './health-probe.ts';

  const client = getClient();
  const principalStore = getPrincipalStore();
  // Health opens for `system:read` or `workflows:read`. Without the second, the runs are not read at
  // all, so Working now shows a dash and the page never waits on or fails over them.
  const canReadRuns = $derived(principalStore.hasScope('workflows:read'));

  // The probe runs once, when the page opens. It is not asked again on a timer: the shell's fleet
  // feed reports whether the engine is answering, and the status pill beside it shows that, so a
  // second clock here would only repeat it.
  const healthQuery = createQuery(() => ({
    queryKey: ['dashboard', 'health'],
    queryFn: () => probeHealth(client),
  }));

  const statusQuery = createQuery(() => ({
    queryKey: queryKeys.workflows.aggregate('status', {}),
    queryFn: async () =>
      parseWorkflowAggregateResult(
        await client.operations['weft.workflows.aggregate']({ groupBy: 'status' }),
      ),
    enabled: healthQuery.isSuccess && canReadRuns,
  }));

  const isGateLoading = $derived(
    healthQuery.isPending || (healthQuery.isSuccess && canReadRuns && statusQuery.isPending),
  );
  const isUnreachable = $derived(healthQuery.isError);
  const isEmpty = $derived(statusQuery.isSuccess && statusQuery.data.total === 0);

  /** The engine's other pages, each opened from here. */
  const SECTIONS = [
    { label: VIEW_COPY.workers.label, path: '/health/workers' },
    { label: VIEW_COPY.storage.label, path: '/health/storage' },
    { label: NAVIGATION_COPY.auditLog, path: '/health/audit' },
  ] as const;

  function openSection(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<div class="weft-dashboard">
  <PageHeader title={VIEW_COPY.health.label} headingLevel={1}>
    {#snippet actions()}
      <nav class="weft-dashboard__sections" aria-label={NAVIGATION_COPY.healthSections}>
        {#each SECTIONS as section (section.path)}
          <Link
            href={router.href(section.path)}
            onclick={(event) => openSection(event, section.path)}>{section.label}</Link
          >
        {/each}
      </nav>
    {/snippet}
  </PageHeader>

  {#if isGateLoading}
    <div
      class="weft-dashboard__gate-skeleton"
      role="status"
      aria-busy="true"
      aria-label="Loading the health overview"
    >
      <Skeleton height="1.5rem" width="16rem" />
      <div class="weft-dashboard__gate-skeleton-grid">
        <Skeleton height="4.5rem" />
        <Skeleton height="4.5rem" />
        <Skeleton height="4.5rem" />
        <Skeleton height="4.5rem" />
      </div>
      <Skeleton height="12rem" />
    </div>
  {:else if isUnreachable}
    <div class="weft-dashboard__full-state">
      <ErrorState
        title="Server unreachable"
        description="The health probe failed to respond."
        retryLabel="Retry probe"
        onRetry={() => void healthQuery.refetch()}
      />
    </div>
  {:else if isEmpty}
    <div class="weft-dashboard__full-state">
      <EmptyState
        kind="first-use"
        title="No runs yet"
        description="Runs from chats, schedules, and workflows show up here once one has started."
      >
        {#snippet icon()}
          <Rocket aria-hidden="true" size={24} />
        {/snippet}
        {#snippet action()}
          {#snippet arrowRight()}
            <ArrowRight aria-hidden="true" size={15} />
          {/snippet}
          <Button
            variant="primary"
            label="Start a run"
            trailingIcon={arrowRight}
            onclick={() => router.navigate('/runs?view=start')}
          />
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <HealthLine />
    <HealthCounts {statusQuery} />
    <ActivityFeedBand />
  {/if}
</div>
