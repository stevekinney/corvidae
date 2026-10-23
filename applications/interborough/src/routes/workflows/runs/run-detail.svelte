<script lang="ts">
  /**
   * `/runs/:id`: one run. It leads with the agent and how the run stands, then what started it, and
   * offers the two things a person does here, Open chat and Cancel run, as buttons of one size. The
   * Summary tab holds the answer (rendered as Markdown), the tool calls, and, when the run needs
   * a person, the decision itself, inline. The Engine tab is the workflow page the engine has
   * always had: payloads, tags, revision, signals, updates, checkpoints, children, restart, and the
   * rest of what only an operator uses.
   *
   * Status comes from the task (`bureau.tasks.get`), which the page reads again whenever the task's
   * stream (`bureau.tasks.events`) reports a change; the answer is the stream's, because the
   * management plane's task view carries none. A run that is not a task (a goal's attempt, which the
   * Bureau does not make one) is shown from the goal that made it, and every run has its Engine tab.
   */
  import { onMount, untrack } from 'svelte';

  import { Badge, Button, Skeleton, Tabs } from '@lostgradient/cinder';
  import { renderMarkdown } from '@lostgradient/markdown';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { TASK_COPY } from '../../../app/copy.ts';
  import { getContext } from '../../../lib/bureau-client.ts';
  import { listGoals } from '../../../lib/bureau-goals.ts';
  import {
    getTask,
    isTerminalState,
    type TaskCleanup,
    type TaskView,
  } from '../../../lib/bureau-tasks.ts';
  import { formatDuration, formatRelativeTime } from '../../../lib/format/index.ts';
  import { chatSessionPath } from '../../../lib/identifier-paths.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import { taskStatePresentation } from '../../../lib/task-status.ts';
  import WorkflowDetail from '../detail/workflow-detail.svelte';
  import RunCancel from './run-cancel.svelte';
  import RunToolCalls from './run-tool-calls.svelte';
  import { TaskFollower } from './task-follower.svelte.ts';

  interface RunDetailProps {
    runId: string;
  }

  let { runId }: RunDetailProps = $props();

  const queryClient = useQueryClient();
  const initialRunId = untrack(() => runId);
  const detailKey = queryKeys.bureauTasks.detail(initialRunId);

  /** Whether the Bureau is still carrying a cancellation out. */
  function inProgress(cleanup: TaskCleanup | null | undefined): boolean {
    return cleanup === 'cancel-requested' || cleanup === 'cleanup-pending';
  }

  const task = createQuery(
    () => ({
      queryKey: detailKey,
      queryFn: ({ signal }) => getTask(initialRunId, { signal }),
      retry: false,
      refetchInterval: (query: { state: { data: { cleanup: TaskCleanup | null } | undefined } }) =>
        inProgress(query.state.data?.cleanup) ? TASK_COPY.cleanupPollMilliseconds : false,
    }),
    undefined,
  );

  const follower = new TaskFollower({
    taskId: initialRunId,
    isOver: () => task.data !== undefined && isTerminalState(task.data.status),
    onElement: (element) => {
      if (element.kind === 'task.snapshot') {
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
      void queryClient.invalidateQueries({ queryKey: detailKey });
    },
  });

  onMount(() => {
    follower.start();
    return () => follower.dispose();
  });

  $effect(() => {
    if (follower.state !== 'ended') return;
    if (task.data !== undefined && isTerminalState(task.data.status)) return;
    const timer = setInterval(() => void task.refetch(), TASK_COPY.endedPollMilliseconds);
    return () => clearInterval(timer);
  });
  $effect(() => {
    if (follower.state !== 'ended') return;
    if (task.data === undefined || !isTerminalState(task.data.status)) return;
    if (follower.lastStatus !== undefined && isTerminalState(follower.lastStatus)) return;
    follower.collect();
  });

  // A catalog task's `contextId` is its run handle, and no chat has it: the link and the title are
  // there only when the Bureau has the chat.
  const chat = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(task.data?.contextId ?? ''),
      queryFn: ({ signal }) => getContext(task.data?.contextId ?? '', { signal }),
      enabled: task.data !== undefined,
      retry: false,
    }),
    undefined,
  );

  // A run that is not a task may be a goal's attempt.
  const goals = createQuery(
    () => ({
      queryKey: ['goals', 'runs'] as const,
      queryFn: ({ signal }) => listGoals({ limit: 100 }, { signal }),
      enabled: task.isError,
      retry: false,
    }),
    undefined,
  );
  const attempt = $derived.by(() => {
    for (const goal of goals.data?.goals ?? []) {
      const found = goal.attempts.find((candidate) => candidate.runId === initialRunId);
      if (found !== undefined) return { goal, attempt: found };
    }
    return undefined;
  });

  const view = $derived(router.current.search.get('view') === 'engine' ? 'engine' : 'summary');
  let tab = $state(untrack(() => view));
  $effect(() => {
    tab = view;
  });
  function changeTab(next: string): void {
    const search = new URLSearchParams(router.search);
    if (next === 'engine') search.set('view', 'engine');
    else {
      search.delete('view');
      search.delete('tab');
    }
    router.navigate(workflowDetailPath(initialRunId, search), { replace: true });
  }

  const chatHref = $derived(
    chat.isSuccess && task.data !== undefined ? chatSessionPath(task.data.contextId) : undefined,
  );

  const answer = $derived(follower.artifact?.text);
  const answerHtml = $derived(answer === undefined ? '' : renderMarkdown(answer).html);
  const startedAt = $derived(task.data === undefined ? undefined : Date.parse(task.data.createdAt));
</script>

<article class="ib-run" aria-labelledby="ib-run-title">
  {#if task.data}
    {@const current = task.data}
    {@const presentation = taskStatePresentation(current.status)}
    <header class="ib-run__header">
      <div class="ib-run__heading">
        <h1 id="ib-run-title" class="ib-run__title">
          {#if current.agentName === null}{TASK_COPY.unknownAgent}{:else}<code class="ib-identifier"
              >{current.agentName}</code
            >{/if}
        </h1>
        <Badge variant={presentation.variant}>{presentation.label}</Badge>
      </div>
      <div class="ib-run__actions">
        {#if chatHref !== undefined}
          <Button
            variant="secondary"
            size="lg"
            href={router.href(chatHref)}
            label={TASK_COPY.openChat}
            onclick={(event) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey ||
                event.button !== 0
              )
                return;
              event.preventDefault();
              router.navigate(chatHref);
            }}
          />
        {/if}
        <RunCancel task={current} />
      </div>
      <p class="ib-run__origin">
        {#if chat.isSuccess}
          {TASK_COPY.startedFromChat}
          <a
            href={router.href(chatSessionPath(current.contextId))}
            onclick={(event) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey ||
                event.button !== 0
              )
                return;
              event.preventDefault();
              router.navigate(chatSessionPath(current.contextId));
            }}>{chat.data.title ?? TASK_COPY.untitledChat}</a
          >
        {:else}
          {TASK_COPY.startedDirectly}
        {/if}
        {#if startedAt !== undefined}
          · <span title={current.createdAt}>{formatRelativeTime(startedAt, Date.now())}</span>
        {/if}
        {#if isTerminalState(current.status) && startedAt !== undefined}
          · {formatDuration(Math.max(0, Date.parse(current.updatedAt) - startedAt))}
        {/if}
      </p>
    </header>
  {:else if attempt !== undefined}
    {@const presentation = taskStatePresentation(
      attempt.attempt.status === 'passed'
        ? 'completed'
        : attempt.attempt.status === 'failed'
          ? 'failed'
          : attempt.attempt.status === 'aborted'
            ? 'canceled'
            : 'working',
    )}
    <header class="ib-run__header">
      <div class="ib-run__heading">
        <h1 id="ib-run-title" class="ib-run__title">
          <code class="ib-identifier">{attempt.goal.agentName}</code>
        </h1>
        <Badge variant={presentation.variant}>{presentation.label}</Badge>
      </div>
      <p class="ib-run__origin">
        {TASK_COPY.startedFromGoal}
        <a
          href={router.href('/goals')}
          onclick={(event) => {
            event.preventDefault();
            router.navigate('/goals');
          }}>{attempt.goal.goalRunId}</a
        >
        ·
        <span title={attempt.attempt.startedAt}
          >{formatRelativeTime(Date.parse(attempt.attempt.startedAt), Date.now())}</span
        >
      </p>
    </header>
  {:else if task.isPending}
    <Skeleton height="2rem" width="40%" />
  {:else}
    <header class="ib-run__header">
      <div class="ib-run__heading">
        <h1 id="ib-run-title" class="ib-run__title">{TASK_COPY.runTitle}</h1>
      </div>
    </header>
  {/if}

  <Tabs bind:value={tab} onValueChange={changeTab}>
    <Tabs.List label={TASK_COPY.tabsLabel}>
      <Tabs.Trigger value="summary">{TASK_COPY.tabs.summary}</Tabs.Trigger>
      <Tabs.Trigger value="engine">{TASK_COPY.tabs.engine}</Tabs.Trigger>
    </Tabs.List>
    <Tabs.Panel value="summary">
      <div class="ib-run__summary">
        {#if task.data}
          {@const current = task.data}
          <section aria-labelledby="ib-run-answer">
            <h2 id="ib-run-answer" class="ib-run__heading-2">{TASK_COPY.answerHeading}</h2>
            {#if answer !== undefined && answer.trim() !== ''}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              <div class="weft-artifact-markdown ib-run__answer">{@html answerHtml}</div>
              {#if follower.artifact?.truncated}
                <p class="ib-run__note">{TASK_COPY.answerTruncated}</p>
              {/if}
            {:else}
              <p class="ib-run__note">
                {isTerminalState(current.status) ? TASK_COPY.noAnswer : TASK_COPY.noAnswerYet}
              </p>
            {/if}
          </section>
          <section aria-labelledby="ib-run-tools">
            <h2 id="ib-run-tools" class="ib-run__heading-2">{TASK_COPY.toolCallsHeading}</h2>
            <RunToolCalls task={current} />
          </section>
          {#if follower.state === 'unavailable'}
            <p class="ib-run__note" role="status">{TASK_COPY.followUnavailable}</p>
          {:else if follower.state === 'reconnecting'}
            <p class="ib-run__note" role="status">{TASK_COPY.followReconnecting}</p>
          {/if}
        {:else if attempt !== undefined}
          <p class="ib-run__note">{TASK_COPY.goalAttemptNote}</p>
        {:else if task.isError}
          <p class="ib-run__note">{TASK_COPY.engineOnlyNote}</p>
        {/if}
      </div>
    </Tabs.Panel>
    <Tabs.Panel value="engine">
      {#if tab === 'engine'}<WorkflowDetail />{/if}
    </Tabs.Panel>
  </Tabs>
</article>
