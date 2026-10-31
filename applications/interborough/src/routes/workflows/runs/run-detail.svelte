<script lang="ts">
  /**
   * `/runs/:run`: one run, as one page with one header and one status, and no tabs. The header says
   * what ran and how the run stands, with Open chat and Cancel run beside a More menu for the rest.
   * Below it, in this order: what the run is waiting on a person for (a question is answered right
   * there, with the chat's own question control), what went in and came out, what the run did, and
   * a place to change or ask the run something (a signal, an update, a query) without a dialog. The
   * Details rail, 320 px wide beside the sections and under them on a narrow screen, holds the
   * facts, each label above its value, and begins with what started the run.
   *
   * Status comes from the task (`bureau.tasks.get`), which the page reads again whenever the task's
   * stream (`bureau.tasks.events`) reports a change, and whenever `bureau.events` reports a run or
   * the cleanup of a cancellation (`task.cleanup-acknowledged`), on a timer only while that feed is
   * not live; the answer is the stream's, because the management plane's task view carries none. A
   * run that is not a task (a goal's attempt started before attempts were tasks, COR-1868) is shown
   * from the goal that made it, and a run only the workflow engine holds, from the engine. When more
   * than one holds it, the task's status is the one shown.
   *
   * The sections that read the workflow engine are there for a caller who holds `workflows:read`,
   * and each is gated again on the scope its own reads need; a caller without engine access still
   * has the whole page the Bureau can fill in. A run that no source knows is a run that was not
   * found, and any other failure to read it is an error that can be retried.
   */
  import { onMount, untrack } from 'svelte';

  import { EmptyState, ErrorState, Skeleton } from '@lostgradient/cinder';
  import { renderMarkdown } from '@lostgradient/markdown';
  import { SearchX } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { RETRY_LABEL, TASK_COPY } from '../../../app/copy.ts';
  import { useBureauEventsLive } from '../../../app/live-polling.svelte.ts';
  import { getContext } from '../../../lib/bureau-client.ts';
  import { listAllGoals } from '../../../lib/bureau-goals.ts';
  import {
    getTask,
    isTerminalState,
    type TaskCleanup,
    type TaskView,
  } from '../../../lib/bureau-tasks.ts';
  import { classifyFault } from '../../../lib/faults.ts';
  import { chatSessionPath } from '../../../lib/identifier-paths.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
  import {
    attemptStatusWord,
    taskStatusWord,
    workflowRunStatusWord,
    type StatusWord,
  } from '../../../lib/status.ts';
  import { getWorkflowFileRun } from '../../../lib/workflow-files.ts';
  import '../detail/workflow-detail.css';
  import { isTerminalStatus } from '../detail/workflow-status.ts';
  import RestartDialog from '../detail/restart-dialog.svelte';
  import RunActivity from './run-activity.svelte';
  import RunChange from './run-change.svelte';
  import RunDetails from './run-details.svelte';
  import RunEnginePanels from './run-engine-panels.svelte';
  import { RunEngine } from './run-engine.svelte.ts';
  import RunHeader from './run-header.svelte';
  import RunInputOutput from './run-input-output.svelte';
  import RunWaiting from './run-waiting.svelte';
  import { TaskFollower } from './task-follower.svelte.ts';

  interface RunDetailProps {
    runId: string;
  }

  let { runId }: RunDetailProps = $props();

  const queryClient = useQueryClient();
  const principal = getPrincipalStore();
  // The workflow's own sections are the engine's, and the engine answers only a caller who may read it.
  const engineAllowed = $derived(principal.hasScope('workflows:read'));
  const initialRunId = untrack(() => runId);
  const detailKey = queryKeys.bureauTasks.detail(initialRunId);

  /** Whether the Bureau is still carrying a cancellation out. */
  function inProgress(cleanup: TaskCleanup | null | undefined): boolean {
    return cleanup === 'cancel-requested' || cleanup === 'cleanup-pending';
  }

  const bureauLive = useBureauEventsLive();
  const task = createQuery(() => {
    // Read here, not in the interval below, which TanStack calls on its own and so is not tracked.
    const polling = !bureauLive();
    return {
      queryKey: detailKey,
      queryFn: ({ signal }: { signal: AbortSignal }) => getTask(initialRunId, { signal }),
      retry: false,
      // A cancellation's cleanup moves with `task.cleanup-acknowledged` and the `run.*` events.
      // poll-reason: fallback
      refetchInterval: (query: { state: { data: { cleanup: TaskCleanup | null } | undefined } }) =>
        polling && inProgress(query.state.data?.cleanup)
          ? TASK_COPY.cleanupPollMilliseconds
          : false,
    };
  }, undefined);

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
    // The stream ended before the run did: `run.settled` and `run.removed` read the task again
    // while the Bureau's feed is live, so the timer is for when it is not.
    if (bureauLive()) return;
    // poll-reason: fallback
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
  // A goal's attempt is also a task, and its `contextId` is the run handle too: the session it ran
  // in is the attempt's own, found among the goals below.
  const goalTask = $derived(task.data?.origin?.kind === 'goal');
  const chat = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(task.data?.contextId ?? ''),
      queryFn: ({ signal }) => getContext(task.data?.contextId ?? '', { signal }),
      enabled: task.data !== undefined && !goalTask,
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
      queryKey: queryKeys.goals.runs(),
      queryFn: ({ signal }) => listAllGoals({ signal }),
      enabled: notFound || goalTask,
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

  // The workflow engine is asked for every run a caller who may read it opens. On the default host
  // a task is an engine run too, and so is a goal's attempt, and the timeline, events, checkpoints,
  // logs and actions are the engine's; the engine answering that it does not hold the run only
  // means the page shows no engine sections. A caller who may not read the engine is never asked.
  const engine = new RunEngine(
    () => initialRunId,
    () => engineAllowed,
  );
  const workflow = $derived(engine.workflow ?? undefined);

  // The session a goal's attempt ran in. A goal's session is not listed under Chat, so the attempt's
  // page is where a person reaches it, while the Bureau still has it.
  const attemptSession = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(attempt?.attempt.sessionId ?? ''),
      queryFn: ({ signal }) => getContext(attempt?.attempt.sessionId ?? '', { signal }),
      enabled: attempt !== undefined,
      retry: false,
    }),
    undefined,
  );

  // A run of a workflow file that the engine behind the console does not hold may still be the
  // Bureau's (`bureau.workflows.runs.get`): the end-to-end host's engine is a fixture, and answers
  // the read by the run's identifier with a 404. Asked only once the engine has said it does not
  // have the run, and only for a run no task describes.
  const fileRun = createQuery(
    () => ({
      queryKey: queryKeys.workflows.fileRun(initialRunId),
      queryFn: ({ signal }) => getWorkflowFileRun(initialRunId, { signal }),
      enabled: engineAllowed && engine.notFound && notFound && attempt === undefined,
      retry: false,
    }),
    undefined,
  );
  const record = $derived(fileRun.data);
  const fileRunAbsent = $derived(
    fileRun.isError && classifyFault(fileRun.error)?.kind === 'not-found',
  );

  const answer = $derived(follower.artifact?.text);
  const answerHtml = $derived(answer === undefined ? '' : renderMarkdown(answer).html);

  // What the page knows of the run, from the first source that has it: the task, a goal's attempt,
  // the workflow engine, or the Bureau's record of a workflow file's run.
  const summary = $derived.by(
    ():
      | {
          readonly title: string | undefined;
          readonly status: StatusWord;
          readonly startedAt: number;
          readonly updatedAt: number;
          readonly over: boolean;
        }
      | undefined => {
      if (task.data !== undefined) {
        return {
          title: task.data.agentName ?? undefined,
          status: taskStatusWord(task.data.status),
          startedAt: Date.parse(task.data.createdAt),
          updatedAt: Date.parse(task.data.updatedAt),
          over: isTerminalState(task.data.status),
        };
      }
      if (attempt !== undefined) {
        const startedAt = Date.parse(attempt.attempt.startedAt);
        const completedAt =
          attempt.attempt.completedAt === null
            ? undefined
            : Date.parse(attempt.attempt.completedAt);
        return {
          title: attempt.goal.agentName,
          status: attemptStatusWord(attempt.attempt.status),
          startedAt,
          updatedAt: completedAt ?? startedAt,
          over: completedAt !== undefined,
        };
      }
      if (workflow !== undefined) {
        return {
          title: workflow.type,
          status: workflowRunStatusWord(workflow.status),
          startedAt: workflow.createdAt,
          updatedAt: workflow.updatedAt,
          over: isTerminalStatus(workflow.status),
        };
      }
      if (record !== undefined) {
        return {
          title: record.workflow,
          status: workflowRunStatusWord(record.status),
          startedAt: Date.parse(record.createdAt),
          updatedAt: Date.parse(record.updatedAt),
          over:
            record.status !== 'pending' &&
            record.status !== 'running' &&
            record.status !== 'suspended',
        };
      }
      return undefined;
    },
  );

  const attemptThreadId = $derived(
    attempt !== undefined && attempt.attempt.sessionId !== '' ? attempt.attempt.sessionId : null,
  );
  const chatLink = $derived.by(() => {
    if (goalTask) {
      return attemptSession.isSuccess
        ? { href: chatSessionPath(attemptSession.data.id), label: TASK_COPY.openSession }
        : undefined;
    }
    if (task.data === undefined) {
      return attempt !== undefined && attemptSession.isSuccess
        ? { href: chatSessionPath(attemptSession.data.id), label: TASK_COPY.openSession }
        : undefined;
    }
    return chat.isSuccess
      ? {
          href: chatSessionPath(task.data.contextId),
          label: chat.data.origin === 'chat' ? TASK_COPY.openChat : TASK_COPY.openSession,
        }
      : undefined;
  });

  // A note for the run's Activity when there is no task to read tool calls from.
  const activityNote = $derived(
    task.data !== undefined
      ? undefined
      : attempt !== undefined
        ? engineAllowed && workflow !== undefined
          ? TASK_COPY.goalAttemptNote
          : TASK_COPY.goalAttemptNoteBureauOnly
        : notFound && engineAllowed && workflow !== undefined
          ? TASK_COPY.engineOnlyNote
          : undefined,
  );

  // Nothing knows this run: the Bureau has no task, no goal made it (the goals were read), and the
  // caller either may not ask the engine, or the engine and the Bureau's record of a workflow file
  // both answered that they do not have it.
  const unknownRun = $derived(
    notFound &&
      goals.isSuccess &&
      attempt === undefined &&
      (!engineAllowed || (engine.notFound && fileRunAbsent)),
  );
  // The engine, or the Bureau's record of a workflow file's run, could not be read, and nothing
  // else describes the run.
  const lookupFailed = $derived(
    notFound &&
      attempt === undefined &&
      engineAllowed &&
      summary === undefined &&
      (engine.fault !== null || (engine.notFound && fileRun.isError && !fileRunAbsent)),
  );
  // Still finding out: the task, then the goals, then the engine, then the Bureau's record of a
  // workflow file's run, each asked only when the one before had nothing.
  const loading = $derived(
    summary === undefined &&
      (task.isPending ||
        (notFound &&
          (goals.isPending ||
            (engineAllowed &&
              attempt === undefined &&
              ((engine.workflow === undefined && engine.fault === null) ||
                (engine.notFound && fileRun.isPending)))))),
  );

  let restartOpen = $state(false);
</script>

{#if follower.removed || unknownRun}
  <EmptyState
    kind="first-use"
    title={TASK_COPY.notFound.title}
    description={TASK_COPY.notFound.description}
    headingLevel={1}
  >
    {#snippet icon()}<SearchX size={28} aria-hidden="true" />{/snippet}
  </EmptyState>
{:else if failed}
  <ErrorState
    variant="flat"
    title={TASK_COPY.loadFailed.title}
    description={TASK_COPY.loadFailed.description}
    headingLevel={1}
    retryLabel={RETRY_LABEL}
    onRetry={() => void (notFound && goals.isError ? goals.refetch() : task.refetch())}
  />
{:else if lookupFailed}
  <ErrorState
    variant="flat"
    title={TASK_COPY.loadFailed.title}
    description={engine.fault?.message ?? TASK_COPY.loadFailed.description}
    headingLevel={1}
    retryLabel={RETRY_LABEL}
    onRetry={() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(initialRunId) });
      void fileRun.refetch();
    }}
  />
{:else}
  <article class="ib-run" aria-label={TASK_COPY.runTitle}>
    {#if summary !== undefined}
      <RunHeader
        runId={initialRunId}
        title={summary.title ?? (task.data === undefined ? undefined : TASK_COPY.unknownAgent)}
        fallbackTitle={TASK_COPY.runTitle}
        status={summary.status}
        startedAt={summary.startedAt}
        tookMilliseconds={summary.over
          ? Math.max(0, summary.updatedAt - summary.startedAt)
          : undefined}
        task={task.data}
        chat={chatLink}
        engineStatus={workflow?.status}
        pendingAction={engine.pendingAction}
        actionGate={engine.actionGate}
        onAction={(action) => engine.act(action)}
        onRestart={() => (restartOpen = true)}
      />
    {:else if loading}
      <Skeleton height="2rem" width="40%" />
    {:else}
      <RunHeader
        runId={initialRunId}
        title={undefined}
        fallbackTitle={TASK_COPY.runTitle}
        status={undefined}
      />
    {/if}

    <div class="ib-run__layout">
      <div class="ib-run__main">
        {#if task.data}
          <RunWaiting task={task.data} />
        {/if}
        {#if summary !== undefined}
          <RunInputOutput
            task={task.data}
            answerHtml={answer === undefined ? undefined : answerHtml}
            answerTruncated={follower.artifact?.truncated === true}
            followState={follower.state}
            {workflow}
            record={workflow === undefined ? record : undefined}
          />
          <RunActivity
            task={task.data}
            threadId={goalTask ? attemptThreadId : undefined}
            {taskEvents}
            note={activityNote}
            engine={workflow === undefined ? undefined : engine}
            {workflow}
          />
          {#if workflow !== undefined}
            <RunChange {engine} {workflow} />
            <RunEnginePanels {engine} {workflow} />
          {:else if engine.fault !== null}
            <!-- The Bureau's side is shown; the engine's could not be read, and that is said. -->
            <ErrorState
              variant="flat"
              title={TASK_COPY.engineReadFailed}
              description={engine.fault.message}
              headingLevel={2}
              retryLabel={RETRY_LABEL}
              onRetry={() =>
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.workflows.detail(initialRunId),
                })}
            />
          {/if}
        {/if}
      </div>
      {#if summary !== undefined}
        <RunDetails
          runId={initialRunId}
          task={task.data}
          goal={attempt?.goal}
          chat={chat.data}
          engine={workflow === undefined ? undefined : engine}
          {workflow}
          recordWorkflow={record?.workflow}
          startedAt={summary.startedAt}
          updatedAt={summary.updatedAt}
          over={summary.over}
        />
      {/if}
    </div>
  </article>

  {#if restartOpen && workflow !== undefined}
    <RestartDialog client={engine.client} {workflow} onClose={() => (restartOpen = false)} />
  {/if}
{/if}
