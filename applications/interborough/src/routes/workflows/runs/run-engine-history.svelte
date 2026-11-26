<script lang="ts">
  /**
   * The engine's record of a run, closed until asked for: its events and its checkpoints. The events
   * need `events:read`, and say so to a caller without it. Drawn under the timeline in Activity, and
   * on its own in the Events and logs tab of the run page (COR-2424).
   */
  import { Collapsible, EmptyState } from '@lostgradient/cinder';
  import Lock from '@lucide/svelte/icons/lock';
  import type { WorkflowReadState as WorkflowState } from '../../../lib/client.ts';

  import { RUN_PAGE_COPY } from '../../../app/copy/runs.ts';
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
  import CheckpointsTab from '../detail/checkpoints/checkpoints-tab.svelte';
  import EventsTab from '../detail/events-tab.svelte';
  import type { RunEngine } from './run-engine.svelte.ts';

  interface RunEngineHistoryProps {
    engine: RunEngine;
    workflow: WorkflowState;
  }

  let { engine, workflow }: RunEngineHistoryProps = $props();

  const principal = getPrincipalStore();
  const canReadEvents = $derived(principal.hasScope('events:read'));

  let eventsOpen = $state(false);
  let checkpointsOpen = $state(false);
</script>

<div class="ib-run__disclosures" data-section="engine-history">
  <Collapsible bind:open={eventsOpen} variant="flat" trigger={RUN_PAGE_COPY.eventsHeading}>
    {#if canReadEvents}
      <EventsTab client={engine.client} {workflow} />
    {:else}
      <EmptyState
        kind="first-use"
        headingLevel={3}
        title={RUN_PAGE_COPY.eventsLockedTitle}
        description={RUN_PAGE_COPY.lockedSection('events:read')}
      >
        {#snippet icon()}<Lock aria-hidden="true" />{/snippet}
      </EmptyState>
    {/if}
  </Collapsible>
  <Collapsible
    bind:open={checkpointsOpen}
    variant="flat"
    trigger={RUN_PAGE_COPY.checkpointsHeading}
  >
    <CheckpointsTab
      client={engine.client}
      workflowId={workflow.id}
      workflowType={workflow.type}
      sourceRevision={workflow.revision}
    />
  </Collapsible>
</div>
