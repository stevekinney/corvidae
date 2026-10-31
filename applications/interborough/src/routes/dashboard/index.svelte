<script lang="ts">
  /**
   * Health (`/health`; plan §9.1; design `Weft UI.dc.html` dashboard screen), the engine's
   * overview. The sidebar's Health item is the way in to it, and its links are the way in to the
   * engine's other pages: Workers, Storage, System and the audit log.
   * Three bands — critical alerts, aggregate cards, recent-activity feed —
   * behind a page-level state machine matching the design's four states
   * (default/loading/empty/unreachable, Appendix B). Bands own their own
   * independent skeletons/errors for anything past this initial gate (this
   * track's brief: "independent per-band skeletons").
   *
   * Query option getters track reactive inputs, including the health gate
   * below. Results expose reactive properties directly and their effects
   * are disposed with the component.
   */
  import { ArrowRight, Rocket, WifiOff } from '@lucide/svelte';
  import { Button, EmptyState, Link, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { getClient } from '../../lib/client.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { NAVIGATION_COPY, VIEW_COPY } from '../../app/copy.ts';
  import AggregateCardsBand from './aggregate-cards-band.svelte';
  import { parseWorkflowAggregateResult } from './aggregate-output.ts';
  import ActivityFeedBand from './activity-feed-band.svelte';
  import CriticalAlertsBand from './critical-alerts-band.svelte';
  import { probeHealth } from './health-probe.ts';

  const client = getClient();

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
    enabled: healthQuery.isSuccess,
  }));

  const isGateLoading = $derived(
    healthQuery.isPending || (healthQuery.isSuccess && statusQuery.isPending),
  );
  const isUnreachable = $derived(healthQuery.isError);
  const isEmpty = $derived(statusQuery.isSuccess && statusQuery.data.total === 0);

  /** The engine's other pages, each opened from here. */
  const SECTIONS = [
    { label: VIEW_COPY.workers.label, path: '/health/workers' },
    { label: VIEW_COPY.storage.label, path: '/health/storage' },
    { label: VIEW_COPY.audit.label, path: '/health/audit' },
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
  <div class="weft-dashboard__header">
    <div>
      <h1 class="weft-dashboard__title">{VIEW_COPY.health.label}</h1>
      {#if healthQuery.dataUpdatedAt > 0}
        <p class="weft-dashboard__subtitle">
          Refreshed {formatRelativeTime(healthQuery.dataUpdatedAt)}
        </p>
      {/if}
    </div>
    <nav class="weft-dashboard__sections" aria-label={NAVIGATION_COPY.healthSections}>
      {#each SECTIONS as section (section.path)}
        <Link href={router.href(section.path)} onclick={(event) => openSection(event, section.path)}
          >{section.label}</Link
        >
      {/each}
    </nav>
  </div>

  {#if isGateLoading}
    <div
      class="weft-dashboard__gate-skeleton"
      role="status"
      aria-busy="true"
      aria-label="Loading the engine overview"
    >
      <div class="weft-dashboard__gate-skeleton-grid">
        <Skeleton height="7.5rem" />
        <Skeleton height="7.5rem" />
        <Skeleton height="8.2rem" />
        <Skeleton height="8.2rem" />
      </div>
      <Skeleton height="12rem" />
    </div>
  {:else if isUnreachable}
    <div class="weft-dashboard__full-state">
      <EmptyState title="Server unreachable" description="The health probe failed to respond.">
        {#snippet icon()}
          <WifiOff aria-hidden="true" size={24} />
        {/snippet}
        {#snippet action()}
          <Button
            variant="secondary"
            label="Retry probe"
            onclick={() => void healthQuery.refetch()}
          />
        {/snippet}
      </EmptyState>
    </div>
  {:else if isEmpty}
    <div class="weft-dashboard__full-state">
      <EmptyState
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
    <CriticalAlertsBand />
    <AggregateCardsBand {statusQuery} />
    <ActivityFeedBand />
  {/if}
</div>
