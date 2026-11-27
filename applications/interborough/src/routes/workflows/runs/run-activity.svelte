<script lang="ts">
  /**
   * What the run did, in the order it reads best: the agent's tool calls (with a tool approval
   * decided under its call), then, for a run the workflow engine holds, its timeline, and, closed
   * until asked for, its events and its checkpoints. The run's logs are under Details. Each part is gated on the scope its
   * own reads need, and says which one it needs when the caller lacks it, so a caller who can read
   * the timeline but not the events still has the timeline.
   */
  import { Section, Stack } from '@lostgradient/cinder';
  import type { WorkflowReadState as WorkflowState } from '../../../lib/client.ts';

  import { RUN_PAGE_COPY } from '../../../app/copy/runs.ts';
  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import RunEngineHistory from './run-engine-history.svelte';
  import RunTimeline from './run-timeline.svelte';
  import RunToolCalls from './run-tool-calls.svelte';
  import { threadIdForTask } from './run-activity.ts';
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
    documentWorkflow?: boolean | undefined;
    /** Whether a tool approval is decided under its call; off where the page decides it above. */
    decideApprovals?: boolean;
    /**
     * Whether the engine's events and checkpoints are drawn here, under the timeline. Off on the
     * run page, where they have a tab of their own (Events and logs, COR-2424).
     */
    history?: boolean;
  }

  let {
    task,
    threadId,
    taskEvents = 0,
    note,
    engine,
    workflow,
    documentWorkflow = false,
    decideApprovals = true,
    history = true,
  }: RunActivityProps = $props();

  const taskThreadId = $derived(task === undefined ? undefined : threadIdForTask(task, threadId));
</script>

<!-- Without a task to read, the note under the heading says why. Activity sits inside How it ran
     beside Raw payloads, so it is a level-3 section like it, and Tool calls under it level 4
     (COR-2329: at level 2 it read louder than the disclosure that holds it). -->
<Section
  level={3}
  title={RUN_PAGE_COPY.activityHeading}
  {...task === undefined && note !== undefined ? { description: note } : {}}
  data-section="activity"
>
  <Stack gap="var(--cinder-space-3)">
    {#if task !== undefined}
      <Section level={4} title={TASK_COPY.toolCallsHeading}>
        <!-- A goal's attempt reads the thread of its own session, once the goals have named it; its waits show either way. -->
        <RunToolCalls {task} threadId={taskThreadId} events={taskEvents} decide={decideApprovals} />
      </Section>
    {/if}

    {#if engine !== undefined && workflow !== undefined}
      <RunTimeline {engine} {workflow} {documentWorkflow} />
    {/if}

    {#if engine !== undefined && workflow !== undefined && history}
      <RunEngineHistory {engine} {workflow} />
    {/if}
  </Stack>
</Section>
