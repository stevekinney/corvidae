<script lang="ts">
  /**
   * Worker versioning panel (COR-164): the run's worker-versioning policy, its
   * exact current binding, the binding history, and a plain-language reason the
   * binding may or may not change. Read-only; there is no control here that
   * moves a run to another build. The one path that can is the restart
   * dialog's token-confirmed override.
   *
   * Reads `workerVersioningPolicy` and `workerBinding` through
   * `readWorkflowWorkerState`, so a record the guard refuses renders as an
   * explicit "unreadable" state with the reason, never as a partial binding. A
   * run with neither field (it predates worker versioning, or its workflow
   * declares no policy) gets its own empty state, in the style of the revision
   * row's "Unpinned (pre-revision record)".
   */
  import { Badge, Callout, DescriptionList, Tooltip } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';
  import { CircleAlert, Info } from '@lucide/svelte';

  import { formatRelativeTime, truncateId } from '../../../lib/format/index.ts';
  import WorkerInheritanceNote from '../../../lib/worker-inheritance-note.svelte';
  import {
    explainWorkerBinding,
    overrideEligibility,
    readWorkflowWorkerState,
  } from '../../../lib/workflow-worker-binding.ts';

  interface WorkerBindingPanelProps {
    readonly workflow: WorkflowState;
  }

  let { workflow }: WorkerBindingPanelProps = $props();

  const reading = $derived(readWorkflowWorkerState(workflow));
  const eligibility = $derived(overrideEligibility(reading, workflow.status));
  // Weft prepends each replaced binding, so the stored history is newest first; the list reads in time order.
  const historyOldestFirst = $derived(
    reading.kind === 'bound' ? reading.record.history.toReversed() : [],
  );

  const policyItems = $derived.by(() => {
    if (reading.kind !== 'bound') return [];
    const { policy } = reading;
    const items = [
      {
        id: 'mode',
        term: 'Policy',
        definition: policy.mode === 'auto-upgrade' ? 'Auto-upgrade' : 'Pinned',
      },
    ];
    if (policy.mode === 'auto-upgrade') {
      items.push(
        {
          id: 'compat-deployment',
          term: 'Requires deployment',
          definition: policy.compatibility.deploymentName,
        },
        { id: 'compat-build', term: 'Requires build', definition: policy.compatibility.buildId },
        {
          id: 'compat-artifact',
          term: 'Requires artifact digest',
          definition: policy.compatibility.artifactDigest,
        },
        {
          id: 'compat-manifest',
          term: 'Requires manifest digest',
          definition: policy.compatibility.manifestDigest,
        },
        {
          id: 'compat-revision',
          term: 'Requires workflow revision',
          definition: policy.compatibility.workflowRevision,
        },
        {
          id: 'compat-activity',
          term: 'Requires activity contract',
          definition: policy.compatibility.activityContractHash,
        },
      );
    }
    return items;
  });

  const bindingItems = $derived.by(() => {
    if (reading.kind !== 'bound') return [];
    const binding = reading.record.current;
    return [
      { id: 'deployment', term: 'Deployment', definition: binding.deploymentName },
      { id: 'build', term: 'Build', definition: binding.buildId },
      { id: 'artifact', term: 'Artifact digest', definition: binding.artifactDigest },
      { id: 'manifest', term: 'Manifest digest', definition: binding.manifestDigest },
      {
        id: 'generation',
        term: 'Routing generation',
        definition: String(binding.routingGeneration),
      },
      { id: 'revision', term: 'Workflow revision', definition: binding.workflowRevision },
      {
        id: 'workflow-contract',
        term: 'Workflow contract',
        definition: binding.workflowContractHash,
      },
      {
        id: 'activity-contracts',
        term: 'Activity contracts',
        definition:
          Object.entries(binding.activityContracts)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([name, hash]) => `${name}: ${hash}`)
            .join('; ') || 'None',
      },
      { id: 'bound', term: 'Bound', definition: formatRelativeTime(binding.boundAt) },
    ];
  });
</script>

<div class="weft-overview-tab__panel weft-worker-binding" data-testid="worker-binding-panel">
  <div class="weft-overview-tab__panel-header">Worker versioning</div>

  {#if reading.kind === 'absent'}
    <p class="weft-worker-binding__empty">
      No worker version is recorded. This run predates worker versioning, or its workflow declares
      no worker versioning policy, so no deployment build is recorded for it.
    </p>
  {:else if reading.kind === 'malformed'}
    <Callout variant="danger" semantic="note" title="Worker version unreadable">
      {#snippet icon()}
        <CircleAlert aria-hidden="true" size={17} />
      {/snippet}
      Weft returned worker versioning data this console cannot read ({reading.reason}), so none of
      it is shown.
    </Callout>
  {:else}
    <div class="weft-worker-binding__badges">
      <Badge variant={reading.policy.mode === 'auto-upgrade' ? 'accent' : 'neutral'}>
        {reading.policy.mode === 'auto-upgrade' ? 'Auto-upgrade' : 'Pinned'}
      </Badge>
      <Tooltip text={reading.record.current.buildId}>
        <Badge variant="neutral" monospace>build {truncateId(reading.record.current.buildId)}</Badge
        >
      </Tooltip>
    </div>
    <p class="weft-worker-binding__why" data-testid="worker-binding-why">
      {explainWorkerBinding(reading)}
    </p>

    <DescriptionList items={policyItems} variant="default" />
    <div class="weft-overview-tab__panel-header weft-worker-binding__subheader">
      Current binding
    </div>
    <DescriptionList items={bindingItems} variant="default" />

    <div class="weft-overview-tab__panel-header weft-worker-binding__subheader">
      Binding history
    </div>
    {#if reading.record.history.length === 0}
      <p class="weft-worker-binding__empty">
        No earlier versions: this run has only ever been bound to the build above.
      </p>
    {:else}
      <ol class="weft-worker-binding__history" aria-label="Earlier worker versions, oldest first">
        {#each historyOldestFirst as entry, index (`${index}-${entry.boundAt}`)}
          <li>
            <span class="weft-worker-binding__history-build">
              build <code title={entry.buildId}>{truncateId(entry.buildId)}</code>
            </span>
            of {entry.deploymentName}, routing generation {entry.routingGeneration}, bound
            {formatRelativeTime(entry.boundAt)}
          </li>
        {/each}
      </ol>
    {/if}

    {#if !eligibility.eligible}
      <p class="weft-worker-binding__override" data-testid="worker-binding-override-note">
        <Info aria-hidden="true" size={13} />
        {eligibility.reason}
      </p>
    {:else}
      <p class="weft-worker-binding__override" data-testid="worker-binding-override-note">
        <Info aria-hidden="true" size={13} />
        This terminal run is auto-upgrade, so Restart can offer a worker override preview (it needs the
        system:admin scope).
      </p>
    {/if}
  {/if}

  <WorkerInheritanceNote surface="activity" />
</div>

<style>
  .weft-worker-binding {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .weft-worker-binding p {
    margin: 0;
  }

  .weft-worker-binding__badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .weft-worker-binding__why,
  .weft-worker-binding__empty {
    font-size: var(--cinder-text-xs);
  }

  .weft-worker-binding__empty {
    color: var(--cinder-text-subtle);
  }

  .weft-worker-binding__subheader {
    margin-block-start: 4px;
  }

  .weft-worker-binding__history {
    margin: 0;
    padding-inline-start: var(--cinder-space-4);
    font-size: var(--cinder-text-xs);
  }

  .weft-worker-binding__override {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    color: var(--cinder-text-subtle);
    font-size: var(--cinder-text-xs);
  }
</style>
