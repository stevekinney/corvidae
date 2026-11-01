<script lang="ts">
  /**
   * Related runs, in the Details rail: the run that started this one, the runs it started, and the
   * runs started alongside it. Each group shows a few and counts the rest, and Topology opens all
   * of it as a small tree in a drawer. A run with no relatives says so once, in one empty state.
   */
  import { Button, EmptyState, ErrorState, Skeleton } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, RUN_RELATED_COPY } from '../../../app/copy.ts';
  import { createActiveRevisionComparisons } from '../../../lib/active-revision-comparisons.svelte.ts';
  import { faultTreatment } from '../../../lib/faults.ts';
  import RelatedRunLink from './related-run-link.svelte';
  import {
    fetchRelatedRuns,
    hasRelatedRuns,
    relatedRunsQueryKey,
    type RelatedGroup,
    type RelatedRun,
    type RelatedRunSubject,
    type RelatedRunsClient,
  } from './run-related-data.ts';
  import RunTopology from './run-topology.svelte';

  /** How many runs of a group the rail lists before it counts the rest. */
  const RAIL_LIMIT = 5;

  interface RunRelatedProps {
    readonly client: RelatedRunsClient;
    readonly workflow: Pick<WorkflowState, 'id' | 'type' | 'status' | 'createdAt'> &
      RelatedRunSubject;
  }

  let { client, workflow }: RunRelatedProps = $props();

  let topologyOpen = $state(false);

  const related = createQuery(() => ({
    queryKey: relatedRunsQueryKey(workflow.id, workflow.parentWorkflowId),
    queryFn: () => fetchRelatedRuns(client, workflow),
  }));

  // Active-versus-bound badge (COR-15): one read of the catalog per distinct type among the runs shown.
  const revisionComparisons = createActiveRevisionComparisons({
    get client() {
      return client;
    },
    rows: () =>
      [...(related.data?.children.runs ?? []), ...(related.data?.siblings.runs ?? [])].flatMap(
        (run) => (run.type === undefined ? [] : [{ type: run.type, revision: run.revision }]),
      ),
  });

  function comparisonOf(run: RelatedRun) {
    return run.type === undefined ? 'unknown' : revisionComparisons.compare(run.type, run.revision);
  }
</script>

{#snippet group(label: string, runs: RelatedGroup)}
  {#if runs.total > 0}
    <section class="ib-run-related__group" aria-label={label} data-group={label}>
      <h3 class="ib-run-related__label">{label}</h3>
      <ul class="ib-run-related__list">
        {#each runs.runs.slice(0, RAIL_LIMIT) as run (run.id)}
          <li><RelatedRunLink {run} comparison={comparisonOf(run)} /></li>
        {/each}
        {#if runs.total > RAIL_LIMIT}
          <li class="ib-run-related__more">{RUN_RELATED_COPY.more(runs.total - RAIL_LIMIT)}</li>
        {/if}
      </ul>
    </section>
  {/if}
{/snippet}

<section class="ib-run-related" aria-labelledby="ib-run-related" data-section="related">
  <div class="ib-run-related__title">
    <h2 id="ib-run-related" class="ib-run__heading-2">{RUN_RELATED_COPY.heading}</h2>
    {#if related.data !== undefined && hasRelatedRuns(related.data)}
      <Button
        variant="ghost"
        size="sm"
        label={RUN_RELATED_COPY.topology}
        aria-haspopup="dialog"
        onclick={() => (topologyOpen = true)}
      />
    {/if}
  </div>

  {#if related.isPending}
    <Skeleton height="3rem" />
  {:else if related.isError}
    <ErrorState
      variant="flat"
      title={RUN_RELATED_COPY.loadFailedTitle}
      description={faultTreatment(related.error).message}
      headingLevel={3}
      retryLabel={RETRY_LABEL}
      onRetry={() => void related.refetch()}
    />
  {:else if !hasRelatedRuns(related.data)}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title={RUN_RELATED_COPY.noneTitle}
      description={RUN_RELATED_COPY.noneDescription}
    />
  {:else}
    {#if related.data.parent !== undefined}
      <section
        class="ib-run-related__group"
        aria-label={RUN_RELATED_COPY.parent}
        data-group={RUN_RELATED_COPY.parent}
      >
        <h3 class="ib-run-related__label">{RUN_RELATED_COPY.parent}</h3>
        <RelatedRunLink run={related.data.parent} />
      </section>
    {/if}
    {@render group(RUN_RELATED_COPY.children, related.data.children)}
    {@render group(RUN_RELATED_COPY.siblings, related.data.siblings)}
  {/if}
</section>

{#if related.data !== undefined}
  <RunTopology bind:open={topologyOpen} {workflow} related={related.data} />
{/if}

<style>
  .ib-run-related {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-run-related__title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
  }

  .ib-run-related__group {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-run-related__label {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
    color: var(--cinder-text-muted);
  }

  .ib-run-related__list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-run-related__more {
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }
</style>
