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
  import { ErrorState } from '@lostgradient/cinder';
  import { keepPreviousData, createQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { RETRY_LABEL, TASK_COPY } from '../../../app/copy.ts';
  import { getThreadMessages } from '../../../lib/bureau-client.ts';
  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import ToolCalls from '../../chat/tool-calls.svelte';
  import { toolCallsOfRun } from './run-tool-calls.ts';
  import RunWait from './run-wait.svelte';

  interface RunToolCallsProps {
    task: TaskView;
    /** The thread the run's calls are in, when it is not the task's `contextId` (a goal's attempt). */
    threadId?: string;
    /** How many elements the run's stream has reported; the thread is read again when it grows. */
    events?: number;
  }

  /** How long a burst of stream elements waits before the thread is read once for all of them. */
  const EVENT_REREAD_MILLISECONDS = 300;

  let { task, threadId = undefined, events = 0 }: RunToolCallsProps = $props();
  const threadToRead = $derived(threadId ?? task.contextId);

  const thread = createQuery(
    () => ({
      queryKey: [
        'bureau-tasks',
        'thread',
        threadToRead,
        task.status,
        task.openWaits.map((wait) => wait.reviewId),
      ] as const,
      queryFn: ({ signal }) => getThreadMessages(threadToRead, { signal }),
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
    // poll-reason: timer
    const timer = setTimeout(() => void untrack(() => thread.refetch()), EVENT_REREAD_MILLISECONDS);
    return () => clearTimeout(timer);
  });
  const entries = $derived(toolCallsOfRun(task.id, thread.data ?? []));
  const questions = $derived(task.openWaits.filter((wait) => wait.kind === 'human-wait'));
  // A tool approval is decided under its call. One whose call is not among the entries (the thread
  // is still being read, failed to read, or does not hold the call) has no row to sit under, so it is
  // shown on its own rather than lost, as the chat shows an approval with no call.
  const unmatchedApprovals = $derived(
    task.openWaits.filter(
      (wait) =>
        wait.kind === 'tool-approval' && !entries.some((entry) => entry.callId === wait.callId),
    ),
  );
  const threadFailed = $derived(thread.isError && thread.data === undefined);
</script>

{#if entries.length > 0}
  <ToolCalls id={`run-${task.id}`} {entries}>
    {#snippet decision(entry)}
      {#each task.openWaits.filter((wait) => wait.kind === 'tool-approval' && wait.callId === entry.callId) as wait (wait.reviewId)}
        <RunWait taskId={task.id} {wait} />
      {/each}
    {/snippet}
  </ToolCalls>
{:else if threadFailed}
  <ErrorState
    variant="flat"
    title={TASK_COPY.toolCallsLoadFailed.title}
    description={TASK_COPY.toolCallsLoadFailed.description}
    headingLevel={3}
    retryLabel={RETRY_LABEL}
    onRetry={() => void thread.refetch()}
  />
{:else if questions.length === 0 && unmatchedApprovals.length === 0}
  <p class="ib-run__note">{TASK_COPY.noToolCalls}</p>
{/if}
{#each unmatchedApprovals as wait (wait.reviewId)}
  <RunWait taskId={task.id} {wait} />
{/each}
{#each questions as wait (wait.reviewId)}
  <RunWait taskId={task.id} {wait} />
{/each}
