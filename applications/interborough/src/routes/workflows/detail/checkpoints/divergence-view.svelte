<script lang="ts">
  /**
   * Side-by-side divergence view (plan T3.3, §7.3): two aligned
   * `RunStepTimeline` instances (original vs. the forked run), step-aligned,
   * with divergence highlighted via the same app-local DOM composition
   * `timeline-tab.svelte` uses for selection tinting — see
   * `timeline/run-step-timeline-selection.ts`'s module doc for why
   * `RunStepTimeline` needs this at all.
   */
  import { Alert, EmptyState, RunStepTimeline, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import type { HttpClient } from '@lostgradient/weft';

  import { RUN_CHECKPOINTS_COPY } from '../../../../app/copy.ts';
  import { applyRunStepTimelineDivergenceHighlight } from '../timeline/run-step-timeline-selection.ts';
  import { mapTimelineToSteps } from '../timeline/timeline-mapping.ts';
  import { workflowTimelineQueryKey } from '../workflow-timeline-data.ts';
  import {
    alignTimelinesForDivergence,
    divergedForkedStepIds,
    divergedOriginalStepIds,
  } from './divergence.ts';

  interface DivergenceViewProps {
    readonly client: Pick<HttpClient, 'getTimeline'>;
    readonly originalWorkflowId: string;
    readonly forkedWorkflowId: string;
  }

  let { client, originalWorkflowId, forkedWorkflowId }: DivergenceViewProps = $props();

  const originalQuery = createQuery(() => ({
    queryKey: workflowTimelineQueryKey(originalWorkflowId),
    queryFn: () => client.getTimeline(originalWorkflowId),
  }));
  const forkedQuery = createQuery(() => ({
    queryKey: workflowTimelineQueryKey(forkedWorkflowId),
    queryFn: () => client.getTimeline(forkedWorkflowId),
  }));

  const loading = $derived(originalQuery.isPending || forkedQuery.isPending);

  const rows = $derived(
    loading ? [] : alignTimelinesForDivergence(originalQuery.data ?? [], forkedQuery.data ?? []),
  );
  const divergedOriginal = $derived(divergedOriginalStepIds(rows));
  const divergedForked = $derived(divergedForkedStepIds(rows));

  const originalSteps = $derived(mapTimelineToSteps(originalQuery.data ?? []));
  const forkedSteps = $derived(mapTimelineToSteps(forkedQuery.data ?? []));

  let originalContainer = $state<HTMLDivElement | undefined>();
  let forkedContainer = $state<HTMLDivElement | undefined>();

  $effect(() => {
    void originalSteps;
    if (originalContainer)
      applyRunStepTimelineDivergenceHighlight(originalContainer, divergedOriginal);
  });
  $effect(() => {
    void forkedSteps;
    if (forkedContainer) applyRunStepTimelineDivergenceHighlight(forkedContainer, divergedForked);
  });
</script>

<div class="weft-divergence-view">
  {#if loading}
    <Skeleton height="12rem" />
  {:else if rows.length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      title={RUN_CHECKPOINTS_COPY.nothingToCompareTitle}
      description={RUN_CHECKPOINTS_COPY.nothingToCompareDescription}
    />
  {:else}
    <Alert variant="info">{RUN_CHECKPOINTS_COPY.divergenceNote}</Alert>
    <div class="weft-divergence-view__columns">
      <div class="weft-divergence-view__column">
        <div class="weft-divergence-view__column-label">Original</div>
        <div bind:this={originalContainer}>
          <RunStepTimeline steps={originalSteps} label="Original run timeline" />
        </div>
      </div>
      <div class="weft-divergence-view__column">
        <div class="weft-divergence-view__column-label">Forked</div>
        <div bind:this={forkedContainer}>
          <RunStepTimeline steps={forkedSteps} label="Forked run timeline" />
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .weft-divergence-view {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .weft-divergence-view__columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
    align-items: start;
  }

  .weft-divergence-view__column {
    min-width: 0;
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    padding: var(--cinder-density-pad-card);
    overflow-x: auto;
  }

  .weft-divergence-view__column-label {
    font-size: var(--cinder-text-2xs);
    font-weight: 700;
    color: var(--cinder-text-disabled);
    margin-bottom: 8px;
  }

  :global([data-weft-timeline-diverged]) {
    background: var(--cinder-status-warning-background);
    border-radius: var(--cinder-radius-md);
  }
</style>
