<script lang="ts">
  /**
   * What happened in a run, in order, under what the run needs from a person and above how it ran:
   * when it started and what set it going, each tool call with how long after the start it was made,
   * what the run asked a person, and what comes next. The entries are made from the chat thread the
   * run belongs to (`run-happened.ts`); a run with no thread to read (a goal's attempt before its
   * goal has named the session, a catalog task) shows its start and what it waits on.
   *
   * The thread is read again when the run's stream reports something and when the set of waits
   * changes, as the tool calls are (`run-tool-calls.svelte`), so a call that starts or ends inside
   * one status shows up as it happens.
   */
  import { Section } from '@lostgradient/cinder';
  import { createQuery, keepPreviousData } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { getThreadMessages } from '../../../lib/bureau-client.ts';
  import { isTerminalState, type TaskView } from '../../../lib/bureau-tasks.ts';
  import { threadIdForTask } from './run-activity.ts';
  import { happenedOfRun, type HappenedInput } from './run-happened.ts';
  import { durationWords } from './run-rows.ts';

  interface RunHappenedProps {
    task: TaskView;
    /**
     * The thread the run's calls are in, when it is not the task's `contextId` (a goal's attempt).
     * `null` says the run has no thread to read: nothing is requested.
     */
    threadId?: string | null | undefined;
    /** When the run started, in epoch milliseconds. */
    startedAt: number;
    /** How many elements the run's stream has reported; the thread is read again when it grows. */
    events?: number;
  }

  /** How long a burst of stream elements waits before the thread is read once for all of them. */
  const EVENT_REREAD_MILLISECONDS = 300;

  let { task, threadId = undefined, startedAt, events = 0 }: RunHappenedProps = $props();
  // A child of another run has a handle for its `contextId`, not a thread: it has none to read.
  const taskThreadId = $derived(threadIdForTask(task, threadId));
  const threadToRead = $derived(taskThreadId === undefined ? task.contextId : taskThreadId);

  const thread = createQuery(
    () => ({
      queryKey: [
        'bureau-tasks',
        'happened',
        threadToRead,
        task.status,
        task.openWaits.map((wait) => wait.reviewId),
      ] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getThreadMessages(threadToRead ?? '', { signal }),
      enabled: threadToRead !== null && threadToRead !== '',
      // The entries on screen stay while the thread is read again under a new key.
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
    // `refetch` ignores `enabled`: with no thread to read, a reread would ask for an empty thread id.
    if (threadToRead === null || threadToRead === '') return;
    // poll-reason: timer
    const timer = setTimeout(() => void untrack(() => thread.refetch()), EVENT_REREAD_MILLISECONDS);
    return () => clearTimeout(timer);
  });

  /** How the run ended and when, from the same task the header reads, or `undefined` while it goes on. */
  function endedOf(view: TaskView): HappenedInput['ended'] {
    const at = Date.parse(view.updatedAt);
    if (!Number.isFinite(at)) return undefined;
    if (view.status === 'completed') return { outcome: 'done', at };
    if (view.status === 'failed') return { outcome: 'failed', at };
    if (view.status === 'canceled') return { outcome: 'canceled', at };
    return undefined;
  }

  const waiting = $derived(
    task.status !== 'input-required'
      ? null
      : task.openWaits.some((wait) => wait.kind === 'human-wait')
        ? ('answer' as const)
        : task.openWaits.length > 0
          ? ('approval' as const)
          : null,
  );
  const entries = $derived(
    happenedOfRun({
      runId: task.id,
      messages: thread.data ?? [],
      startedAt,
      waiting,
      over: isTerminalState(task.status),
      ended: endedOf(task),
    }),
  );
</script>

<Section title={RUN_DETAIL_COPY.happened.heading} data-section="what-happened">
  <ol class="ib-run-happened" aria-label={RUN_DETAIL_COPY.happened.listLabel}>
    {#each entries as entry (entry.key)}
      <li class="ib-run-happened__entry" data-state={entry.state}>
        <span class="ib-run-happened__title">{entry.title}</span>
        {#if entry.offsetMilliseconds !== undefined}
          <span class="ib-run-happened__offset">+{durationWords(entry.offsetMilliseconds)}</span>
        {/if}
        {#if entry.detail !== undefined}
          <span class="ib-run-happened__detail">{entry.detail}</span>
        {/if}
      </li>
    {/each}
  </ol>
</Section>
