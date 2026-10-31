<script lang="ts">
  /**
   * What the run did, in the order it reads best: the agent's tool calls (with a tool approval
   * decided under its call), then, for a run the workflow engine holds, its timeline, and, closed
   * until asked for, its events, its checkpoints and its logs. Each part is gated on the scope its
   * own reads need, and says which one it needs when the caller lacks it, so a caller who can read
   * the timeline but not the events still has the timeline.
   */
  import { Collapsible } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';

  import { RUN_PAGE_COPY, TASK_COPY } from '../../../app/copy.ts';
  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
  import CheckpointsTab from '../detail/checkpoints/checkpoints-tab.svelte';
  import EventsTab from '../detail/events-tab.svelte';
  import LogsTab from '../detail/logs-tab.svelte';
  import RunTimeline from './run-timeline.svelte';
  import RunToolCalls from './run-tool-calls.svelte';
  import type { RunEngine } from './run-engine.svelte.ts';

  interface RunActivityProps {
    /** The Bureau's task: the agent's tool calls are its thread. */
    task?: TaskView | undefined;
    /** The thread a goal's attempt ran in; `undefined` reads the task's own. */
    threadId?: string | null | undefined;
    /** How many elements the task's stream has reported, so the calls are read again. */
    taskEvents?: number;
    /** Said where there is no task for the run, to a caller who has nothing else to read. */
    note?: string | undefined;
    /** The engine's side of the run. */
    engine?: RunEngine | undefined;
    /** The run, as the engine holds it. */
    workflow?: WorkflowState | undefined;
  }

  let { task, threadId, taskEvents = 0, note, engine, workflow }: RunActivityProps = $props();

  const principal = getPrincipalStore();
  const canReadEvents = $derived(principal.hasScope('events:read'));

  let eventsOpen = $state(false);
  let checkpointsOpen = $state(false);
  let logsOpen = $state(false);
</script>

<section class="ib-run__section" aria-labelledby="ib-run-activity" data-section="activity">
  <h2 id="ib-run-activity" class="ib-run__heading-2">{RUN_PAGE_COPY.activityHeading}</h2>

  {#if task !== undefined}
    <h3 class="ib-run__heading-3">{TASK_COPY.toolCallsHeading}</h3>
    <!-- A goal's attempt reads the thread of its own session, once the goals have named it; its waits show either way. -->
    <RunToolCalls {task} {threadId} events={taskEvents} />
  {:else if note !== undefined}
    <p class="ib-run__note">{note}</p>
  {/if}

  {#if engine !== undefined && workflow !== undefined}
    <h3 class="ib-run__heading-3">{RUN_PAGE_COPY.timelineHeading}</h3>
    <RunTimeline {engine} {workflow} />

    <div class="ib-run__disclosures">
      <Collapsible bind:open={eventsOpen} trigger={RUN_PAGE_COPY.eventsHeading}>
        {#if canReadEvents}
          <EventsTab client={engine.client} {workflow} />
        {:else}
          <p class="ib-run__note">{RUN_PAGE_COPY.lockedSection('events:read')}</p>
        {/if}
      </Collapsible>
      <Collapsible bind:open={checkpointsOpen} trigger={RUN_PAGE_COPY.checkpointsHeading}>
        <CheckpointsTab
          client={engine.client}
          workflowId={workflow.id}
          workflowType={workflow.type}
          sourceRevision={workflow.revision}
        />
      </Collapsible>
      <Collapsible bind:open={logsOpen} trigger={RUN_PAGE_COPY.logsHeading}>
        <LogsTab />
      </Collapsible>
    </div>
  {/if}
</section>
