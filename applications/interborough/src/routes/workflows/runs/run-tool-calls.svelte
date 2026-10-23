<script lang="ts">
  /**
   * The tool calls of a run, in the chat's style (`../../chat/tool-calls.svelte`), with the run's
   * decision inline under the call that waits for it. The calls come from the chat thread the run
   * belongs to; a run with no chat (a goal's attempt, a catalog task) has none to show, and a run
   * that waits on a question rather than a tool shows the question below the calls.
   *
   * The thread is read again whenever the run's stream reports something (`events`), because a call
   * that starts or ends inside one status is a change the task's own fields do not show, and
   * whenever the set of waits changes (the key holds each open wait's review), because a decision
   * made elsewhere writes its result into the thread without changing the count of waits.
   */
  import { keepPreviousData, createQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { TASK_COPY } from '../../../app/copy.ts';
  import { getThreadMessages } from '../../../lib/bureau-client.ts';
  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import ToolCalls from '../../chat/tool-calls.svelte';
  import { toolCallsOfRun } from './run-tool-calls.ts';
  import RunWait from './run-wait.svelte';

  interface RunToolCallsProps {
    task: TaskView;
    /** How many elements the run's stream has reported; the thread is read again when it grows. */
    events?: number;
  }

  /** How long a burst of stream elements waits before the thread is read once for all of them. */
  const EVENT_REREAD_MILLISECONDS = 300;

  let { task, events = 0 }: RunToolCallsProps = $props();

  const thread = createQuery(
    () => ({
      queryKey: [
        'bureau-tasks',
        'thread',
        task.contextId,
        task.status,
        task.openWaits.map((wait) => wait.reviewId),
      ] as const,
      queryFn: ({ signal }) => getThreadMessages(task.contextId, { signal }),
      // The calls on screen stay while the thread is read again under a new key.
      placeholderData: keepPreviousData,
      retry: false,
    }),
    undefined,
  );
  let lastEvents = untrack(() => events);
  $effect(() => {
    const now = events;
    if (now === lastEvents) return;
    lastEvents = now;
    const timer = setTimeout(() => void untrack(() => thread.refetch()), EVENT_REREAD_MILLISECONDS);
    return () => clearTimeout(timer);
  });
  const entries = $derived(toolCallsOfRun(task.id, thread.data ?? []));
  const questions = $derived(task.openWaits.filter((wait) => wait.kind === 'human-wait'));
</script>

{#if entries.length > 0}
  <ToolCalls id={`run-${task.id}`} {entries}>
    {#snippet decision(entry)}
      {#each task.openWaits.filter((wait) => wait.kind === 'tool-approval' && wait.callId === entry.callId) as wait (wait.reviewId)}
        <RunWait taskId={task.id} {wait} />
      {/each}
    {/snippet}
  </ToolCalls>
{:else if questions.length === 0}
  <p class="ib-run__note">{TASK_COPY.noToolCalls}</p>
{/if}
{#each questions as wait (wait.reviewId)}
  <RunWait taskId={task.id} {wait} />
{/each}
