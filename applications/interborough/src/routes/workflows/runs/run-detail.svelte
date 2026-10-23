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
   * Bureau does not make one) is shown from the goal that made it. The Engine tab reads the engine,
   * so it is there only for a caller who holds `workflows:read`; everything else is the Bureau's.
   * A Bureau that does not know the run (a missing task, or one removed while the page was open) is a
   * run that was not found, and any other failure to read it is an error that can be retried.
   */
  import { onMount, untrack } from 'svelte';

  import { Badge, Button, EmptyState, ErrorState, Skeleton, Tabs } from '@lostgradient/cinder';
  import { renderMarkdown } from '@lostgradient/markdown';
  import { SearchX } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { RETRY_LABEL, TASK_COPY } from '../../../app/copy.ts';
  import { getContext } from '../../../lib/bureau-client.ts';
  import { listAllGoals } from '../../../lib/bureau-goals.ts';
  import {
    getTask,
    isTerminalState,
    type TaskCleanup,
    type TaskView,
  } from '../../../lib/bureau-tasks.ts';
  import { classifyFault } from '../../../lib/faults.ts';
  import { formatDuration, formatRelativeTime } from '../../../lib/format/index.ts';
  import { chatSessionPath } from '../../../lib/identifier-paths.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
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
  const principal = getPrincipalStore();
  // The Engine tab is the workflow page, and the engine answers only a caller who may read it.
  const engineAllowed = $derived(principal.hasScope('workflows:read'));
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

  // How many elements the task's stream has reported, for the tool calls to read the thread again:
  // a call that starts or ends inside one status is a change the task's own fields do not show.
  let taskEvents = $state(0);

  const follower = new TaskFollower({
    taskId: initialRunId,
    isOver: () => task.data !== undefined && isTerminalState(task.data.status),
    onElement: (element) => {
      taskEvents += 1;
      // An approval gated again keeps its review id, so the waits are read again with the task.
      void queryClient.invalidateQueries({ queryKey: queryKeys.bureauReviews.details() });
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

  // The stream is opened once the Bureau has answered for the task. A run the Bureau does not know
  // (an engine run, or a goal's attempt) has no task to follow, and its subscription answers 404,
  // which the browser logs as a failed request (COR-1643).
  $effect(() => {
    if (task.data !== undefined) follower.start();
  });
  onMount(() => () => follower.dispose());

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

  // Only a run the Bureau does not know may be a goal's attempt. Any other failure to read the task
  // is not a reason to look anywhere else: it is shown as the failure it is.
  const notFound = $derived(task.isError && classifyFault(task.error)?.kind === 'not-found');
  // A run the Bureau does not know is looked for among the goals' attempts; when that look fails,
  // the page cannot say whether the run exists, so it says so and offers to try again.
  const goals = createQuery(
    () => ({
      queryKey: ['goals', 'runs'] as const,
      queryFn: ({ signal }) => listAllGoals({ signal }),
      enabled: notFound,
      retry: false,
    }),
    undefined,
  );
  const failed = $derived((task.isError && !notFound) || (notFound && goals.isError));
  const attempt = $derived.by(() => {
    for (const goal of goals.data ?? []) {
      const found = goal.attempts.find((candidate) => candidate.runId === initialRunId);
      if (found !== undefined) return { goal, attempt: found };
    }
    return undefined;
  });

  // A run only the engine knows (no task, and no goal made it) has nothing on its Summary tab, so it
  // opens on the Engine tab, where the workflow is. Either tab can still be asked for by name.
  const engineOnly = $derived(notFound && attempt === undefined && engineAllowed);
  const view = $derived.by(() => {
    if (!engineAllowed) return 'summary';
    const asked = router.current.search.get('view');
    if (asked === 'engine' || asked === 'summary') return asked;
    return engineOnly ? 'engine' : 'summary';
  });
  let tab = $state(untrack(() => view));
  $effect(() => {
    tab = view;
  });
  function changeTab(next: string): void {
    const search = new URLSearchParams(router.search);
    if (next === 'engine') search.set('view', 'engine');
    else {
      // Summary is the absence of a choice, except where the choice would otherwise be Engine.
      if (engineOnly) search.set('view', 'summary');
      else search.delete('view');
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
  // Nothing knows this run: the Bureau has no task, no goal made it (the goals were read), and the
  // caller may not ask the engine, which is the only other place a run can be.
  const unknownRun = $derived(
    notFound && goals.isSuccess && attempt === undefined && !engineAllowed,
  );
</script>

{#if follower.removed || unknownRun}
  <EmptyState
    title={TASK_COPY.notFound.title}
    description={TASK_COPY.notFound.description}
    headingLevel={1}
  >
    {#snippet icon()}<SearchX size={28} aria-hidden="true" />{/snippet}
  </EmptyState>
{:else if failed}
  <ErrorState
    title={TASK_COPY.loadFailed.title}
    description={TASK_COPY.loadFailed.description}
    headingLevel={1}
    retryLabel={RETRY_LABEL}
    onRetry={() => void (notFound && goals.isError ? goals.refetch() : task.refetch())}
  />
{:else}
  <article class="ib-run" aria-labelledby="ib-run-title">
    {#if task.data}
      {@const current = task.data}
      {@const presentation = taskStatePresentation(current.status)}
      <header class="ib-run__header">
        <div class="ib-run__heading">
          <h1 id="ib-run-title" class="ib-run__title">
            {#if current.agentName === null}{TASK_COPY.unknownAgent}{:else}<code
                class="ib-identifier">{current.agentName}</code
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
        {#if engineAllowed}<Tabs.Trigger value="engine">{TASK_COPY.tabs.engine}</Tabs.Trigger>{/if}
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
              <RunToolCalls task={current} events={taskEvents} />
            </section>
            {#if follower.state === 'unavailable'}
              <p class="ib-run__note" role="status">{TASK_COPY.followUnavailable}</p>
            {:else if follower.state === 'reconnecting'}
              <p class="ib-run__note" role="status">{TASK_COPY.followReconnecting}</p>
            {/if}
          {:else if attempt !== undefined}
            <p class="ib-run__note">
              {engineAllowed ? TASK_COPY.goalAttemptNote : TASK_COPY.goalAttemptNoteBureauOnly}
            </p>
          {:else if notFound && engineAllowed}
            <p class="ib-run__note">{TASK_COPY.engineOnlyNote}</p>
          {/if}
        </div>
      </Tabs.Panel>
      {#if engineAllowed}
        <Tabs.Panel value="engine">
          {#if tab === 'engine'}<WorkflowDetail />{/if}
        </Tabs.Panel>
      {/if}
    </Tabs>
  </article>
{/if}
