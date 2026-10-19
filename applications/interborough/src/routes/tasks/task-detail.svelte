<script lang="ts">
  /**
   * `/tasks/:id`: one task. Its status and its status message are `bureau.tasks.get`'s, and the page
   * reads it again whenever the stream reports a change. Its answer is the stream's
   * (`bureau.tasks.events`), because the management plane's task view carries no artifact, and no
   * message text either, so there is no message history here. The waits it is held on are read from
   * the reviews they name, and a question is answered on this page (`task-wait.svelte`).
   *
   * While a cancellation is being carried out (`cleanup` is `cancel-requested` or `cleanup-pending`)
   * the page reads the task every second until it is neither. The view frame has already settled
   * that the task exists and may be seen, so a fault here is a later one.
   */
  import { onMount, untrack } from 'svelte';

  import { Badge, EmptyState, ErrorState, Skeleton } from '@lostgradient/cinder';
  import { SearchX } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { RETRY_LABEL, TASK_COPY, VIEW_COPY } from '../../app/copy.ts';
  import { getContext } from '../../lib/bureau-client.ts';
  import {
    getTask,
    isTerminalState,
    type TaskCleanup,
    type TaskView,
  } from '../../lib/bureau-tasks.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import TaskCancel from './task-cancel.svelte';
  import { TaskFollower } from './task-follower.svelte.ts';
  import { taskStatePresentation } from './task-presentation.ts';
  import TaskWait from './task-wait.svelte';

  interface TaskDetailProps {
    taskId: string;
  }

  let { taskId }: TaskDetailProps = $props();

  const queryClient = useQueryClient();
  const initialTaskId = untrack(() => taskId);

  /** Whether the Bureau is still carrying a cancellation out. */
  function inProgress(cleanup: TaskCleanup | null | undefined): boolean {
    return cleanup === 'cancel-requested' || cleanup === 'cleanup-pending';
  }

  const task = createQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.detail(initialTaskId),
      queryFn: ({ signal }) => getTask(initialTaskId, { signal }),
      retry: false,
      refetchInterval: (query: { state: { data: { cleanup: TaskCleanup | null } | undefined } }) =>
        inProgress(query.state.data?.cleanup) ? TASK_COPY.cleanupPollMilliseconds : false,
    }),
    undefined,
  );

  const detailKey = queryKeys.bureauTasks.detail(initialTaskId);

  const follower = new TaskFollower({
    taskId: initialTaskId,
    isOver: () => task.data !== undefined && isTerminalState(task.data.status),
    onElement: (element) => {
      if (element.kind === 'task.snapshot') {
        // A snapshot is the whole of a task's stream when the Bureau started it with `bureau.run()`,
        // so each one is applied: the status it carries shows at once, and the task is read again
        // for what a snapshot does not carry (its waits and its cleanup). One that restates what the
        // page read changes nothing.
        const read = queryClient.getQueryData<TaskView>(detailKey);
        if (read !== undefined && read.status !== element.status) {
          queryClient.setQueryData<TaskView>(detailKey, {
            ...read,
            status: element.status,
            finishReason: element.finishReason,
            statusMessage: element.message,
          });
          void queryClient.invalidateQueries({ queryKey: detailKey });
        }
        return;
      }
      // Any other element is a change, or a gap to repair.
      void queryClient.invalidateQueries({ queryKey: detailKey });
    },
  });

  onMount(() => {
    follower.start();
    return () => follower.dispose();
  });

  // A stream the Bureau has ended says nothing more, and a task it started with `bureau.run()` ends
  // its stream after one snapshot while it is still going. Until the task is over, the page reads
  // it every few seconds, and stops once it is over or the page is left.
  $effect(() => {
    if (follower.state !== 'ended') return;
    if (task.data !== undefined && isTerminalState(task.data.status)) return;
    const timer = setInterval(() => void task.refetch(), TASK_COPY.endedPollMilliseconds);
    return () => clearInterval(timer);
  });

  // A task the Bureau started with `bureau.run()` carries its answer only in the snapshot of a
  // subscription made once it is finished. When the page reads it as over after its stream ended
  // while it was going, one more stream collects the answer.
  $effect(() => {
    if (follower.state !== 'ended') return;
    if (task.data === undefined || !isTerminalState(task.data.status)) return;
    if (follower.lastStatus !== undefined && isTerminalState(follower.lastStatus)) return;
    follower.collect();
  });

  // A catalog task's `contextId` is its run handle, and no session has it, so the link to a chat is
  // there only when the Bureau has the session.
  const session = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(task.data?.contextId ?? ''),
      queryFn: ({ signal }) => getContext(task.data?.contextId ?? '', { signal }),
      enabled: task.data !== undefined,
      retry: false,
    }),
    undefined,
  );

  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#if follower.removed}
  <EmptyState
    title={VIEW_COPY.tasks.notFound?.title ?? ''}
    description={VIEW_COPY.tasks.notFound?.description ?? ''}
    headingLevel={1}
  >
    {#snippet icon()}<SearchX size={28} aria-hidden="true" />{/snippet}
  </EmptyState>
{:else if task.data}
  {@const current = task.data}
  {@const presentation = taskStatePresentation(current.status)}
  <article class="weft-task" aria-labelledby="weft-task-title">
    <header class="weft-task__header">
      <h1 id="weft-task-title" class="weft-task__title">
        {TASK_COPY.detailTitle(current.agentName)}
      </h1>
      <p class="weft-task__id"><code title={TASK_COPY.idLabel}>{current.id}</code></p>
    </header>

    <dl class="weft-task__facts">
      <dt>{TASK_COPY.statusFact}</dt>
      <dd><Badge variant={presentation.variant}>{presentation.label}</Badge></dd>
      {#if current.agentName !== null}
        <dt>{TASK_COPY.agentFact}</dt>
        <dd>{current.agentName}</dd>
      {/if}
      {#if session.isSuccess}
        <dt>{TASK_COPY.sessionFact}</dt>
        <dd>
          <a
            href={router.href(`/chat/${encodeURIComponent(current.contextId)}`)}
            onclick={(event) => open(event, `/chat/${encodeURIComponent(current.contextId)}`)}
            >{TASK_COPY.openChat}</a
          >
        </dd>
      {/if}
      {#if current.finishReason !== null}
        <dt>{TASK_COPY.finishReasonFact}</dt>
        <dd>{current.finishReason}</dd>
      {/if}
      {#if current.statusMessage !== null}
        <dt>{TASK_COPY.statusMessageFact}</dt>
        <dd>{current.statusMessage}</dd>
      {/if}
      <dt>{TASK_COPY.createdFact}</dt>
      <dd><time datetime={current.createdAt}>{current.createdAt}</time></dd>
      <dt>{TASK_COPY.updatedFact}</dt>
      <dd><time datetime={current.updatedAt}>{current.updatedAt}</time></dd>
    </dl>

    {#if follower.state === 'unavailable'}
      <p class="weft-task__note" role="status">{TASK_COPY.followUnavailable}</p>
    {:else if follower.state === 'reconnecting'}
      <p class="weft-task__note" role="status">{TASK_COPY.followReconnecting}</p>
    {/if}

    {#if current.openWaits.length > 0}
      <section class="weft-task__section" aria-labelledby="weft-task-waits-title">
        <h2 id="weft-task-waits-title" class="weft-task__heading">{TASK_COPY.waitsHeading}</h2>
        {#each current.openWaits as wait (wait.reviewId)}
          <TaskWait taskId={current.id} {wait} />
        {/each}
      </section>
    {/if}

    {#if follower.artifact !== null}
      <section class="weft-task__section" aria-labelledby="weft-task-answer-title">
        <h2 id="weft-task-answer-title" class="weft-task__heading">{TASK_COPY.answerHeading}</h2>
        <pre class="weft-task__answer">{follower.artifact.text}</pre>
        {#if follower.artifact.truncated}
          <p class="weft-task__note">{TASK_COPY.answerTruncated}</p>
        {/if}
      </section>
    {/if}

    <TaskCancel task={current} />
  </article>
{:else if task.isError}
  <ErrorState
    title={VIEW_COPY.tasks.error.title}
    description={VIEW_COPY.tasks.error.description}
    headingLevel={1}
    retryLabel={RETRY_LABEL}
    onRetry={() => void task.refetch()}
  />
{:else}
  <div class="weft-task" role="status" aria-busy="true" aria-label="Loading the task">
    <Skeleton height="1.5rem" width="40%" />
    <Skeleton height="8rem" />
  </div>
{/if}
