<script lang="ts">
  /**
   * The tool calls of a run, in the chat's style (`../../chat/tool-calls.svelte`), with the run's
   * decision inline under the call that waits for it. The calls come from the chat thread the run
   * belongs to; a run with no chat (a goal's attempt, a catalog task) has none to show, and a run
   * that waits on a question rather than a tool shows the question below the calls.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { TASK_COPY } from '../../../app/copy.ts';
  import { getThreadMessages } from '../../../lib/bureau-client.ts';
  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import ToolCalls from '../../chat/tool-calls.svelte';
  import { toolCallsOfRun } from './run-tool-calls.ts';
  import RunWait from './run-wait.svelte';

  interface RunToolCallsProps {
    task: TaskView;
  }

  let { task }: RunToolCallsProps = $props();

  const thread = createQuery(
    () => ({
      queryKey: ['bureau-tasks', 'thread', task.contextId, task.status, task.openWaits.length] as const,
      queryFn: ({ signal }) => getThreadMessages(task.contextId, { signal }),
      retry: false,
    }),
    undefined,
  );
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
