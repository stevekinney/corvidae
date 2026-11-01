<script lang="ts">
  /**
   * One related run as a link: what it is, how it stands, and a shortened ID that shows in full on
   * hover. A parent the engine no longer holds is named by its ID alone and links nowhere.
   */
  import { Badge } from '@lostgradient/cinder';

  import { RUN_RELATED_COPY } from '../../../app/copy.ts';
  import { truncateId } from '../../../lib/format/index.ts';
  import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import type { RevisionActiveComparison } from '../../../lib/workflow-revision.ts';
  import { workflowStatusBadge } from '../list/workflow-status-badge.ts';
  import WorkflowStatusIcon from '../list/workflow-status-icon.svelte';
  import RevisionComparisonBadge from '../revision-comparison-badge.svelte';
  import type { RelatedRun } from './run-related-data.ts';

  interface RelatedRunLinkProps {
    readonly run: RelatedRun;
    /** How the run's revision compares with the active one; the badge shows when it is a claim worth making. */
    readonly comparison?: RevisionActiveComparison;
  }

  let { run, comparison = 'unknown' }: RelatedRunLinkProps = $props();

  const badge = $derived(run.status === undefined ? undefined : workflowStatusBadge(run.status));
  const path = $derived(workflowDetailPath(run.id));

  /** Opens the run in place, leaving a modified click to the browser. */
  function open(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<span class="ib-related-run" data-related-run={run.id}>
  {#if run.type === undefined}
    <span class="ib-related-run__type">{RUN_RELATED_COPY.parentGone}</span>
  {:else}
    <a
      class="ib-related-run__type"
      href={router.href(path)}
      aria-label={RUN_RELATED_COPY.openRun(run.type)}
      onclick={open}>{run.type}</a
    >
  {/if}
  {#if badge !== undefined}
    <Badge variant={badge.tone} size="sm">
      <WorkflowStatusIcon icon={badge.icon} />
      {badge.label}
    </Badge>
  {/if}
  <RevisionComparisonBadge {comparison} />
  <code class="ib-related-run__id" title={run.id}>{truncateId(run.id)}</code>
</span>

<style>
  .ib-related-run {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-2);
    min-width: 0;
  }

  .ib-related-run__type {
    min-width: 0;
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .ib-related-run__id {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
    overflow-wrap: anywhere;
  }
</style>
