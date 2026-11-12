<script lang="ts">
  import { browserWorkspaceStorage } from '../../../app/workspace-lifetime.ts';

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

  import { ErrorState, Skeleton } from '@lostgradient/cinder';
  import { renderMarkdown } from '@lostgradient/markdown';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { usePageLabel } from '../../../app/breadcrumbs.svelte.ts';
  import { RETRY_LABEL } from '../../../app/copy/views.ts';
  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import { answerUndoMilliseconds } from '../../../lib/answer-undo.ts';
  import { useBureauEventsLive } from '../../../app/live-polling.svelte.ts';
  import NotFoundState from '../../../app/not-found-state.svelte';
  import { getContext } from '../../../lib/bureau-client.ts';
  import { listAllGoals } from '../../../lib/bureau-goals.ts';
  import { listBureauSchedules } from '../../../lib/bureau-schedules.ts';
  import {
    getTask,
    isTerminalState,
    type TaskCleanup,
    type TaskView,
  } from '../../../lib/bureau-tasks.ts';
  import { classifyFault } from '../../../lib/faults.ts';
  import { chatSessionPath } from '../../../lib/identifier-paths.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
  import {
    attemptStatusWord,
    taskStatusWord,
    workflowRunStatusWord,
    type StatusWord,
  } from '../../../lib/status.ts';
  import { getWorkflowFileRun } from '../../../lib/workflow-files.ts';
  import { builtInWorkflowName, isBuiltInWorkflow } from '../../../lib/workflow-type-name.ts';
  import { workflowRunSetupPath } from '../../../lib/workflow-type-paths.ts';
  import '../detail/workflow-detail.css';
  import { isTerminalStatus } from '../detail/workflow-status.ts';
  import RestartDialog from '../detail/restart-dialog.svelte';
  import RunActivity from './run-activity.svelte';
  import RunChange from './run-change.svelte';
  import RunDetails from './run-details.svelte';
  import RunEnginePanels from './run-engine-panels.svelte';
  import { RunEngine } from './run-engine.svelte.ts';
  import RunHappened from './run-happened.svelte';
  import RunHeader from './run-header.svelte';
  import RunInputOutput from './run-input-output.svelte';
  import RunHowItRan from './run-how-it-ran.svelte';
  import RunPanels from './run-panels.svelte';
  import RunPayloadCards from './run-payload-cards.svelte';
  import { buildRunRows } from './run-rows.ts';
  import { runStatusLine } from './run-status-line.ts';
  import RunMessageBlocked from './run-message-blocked.svelte';
  import RunWaiting from './run-waiting.svelte';
  import { TaskFollower } from './task-follower.svelte.ts';

  /** How long the run is let to arrive before its placeholders are drawn: Cinder's loading rule. */
  const LOADING_DELAY_MILLISECONDS = 300;
  /** How long a read runs before the placeholders say it is taking longer than usual. */
  const STILL_LOADING_MILLISECONDS = 10_000;

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
    storage: browserWorkspaceStorage(principal.principal?.workspace, 'sessionStorage'),
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

  // A workflow-file run's durable origin belongs to the Bureau even when the engine also holds the
  // live workflow. Read it for every run with no task or goal, so the page does not lose agent-run
  // provenance merely because Weft still has the instance.
  const fileRun = createQuery(
    () => ({
      queryKey: queryKeys.workflows.fileRun(initialRunId),
      queryFn: ({ signal }) => getWorkflowFileRun(initialRunId, { signal }),
      enabled: engineAllowed && notFound && attempt === undefined,
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

  // The goal attempt the run is, as the status line says it: which attempt, and whether its agent
  // has finished and its result is being checked against the goal's check.
  const attemptLine = $derived(
    attempt === undefined
      ? undefined
      : {
          number: attempt.attempt.attemptIndex + 1,
          of: Math.max(attempt.goal.bounds.maximumAttempts, attempt.attempt.attemptIndex + 1),
          checking: attempt.attempt.status === 'evaluating',
        },
  );
  // The status word and what follows the time in the header: how long a run still going has run,
  // what a person has to do for a waiting one to go on, the signal it waits for, or the attempt.
  const statusLine = $derived(
    summary === undefined
      ? undefined
      : runStatusLine({
          status: summary.status,
          startedAt: summary.startedAt,
          over: summary.over,
          now: engine.clock.now,
          task: task.data,
          waitingForSignals: workflow?.waitingForSignals,
          attempt: attemptLine,
        }),
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

  // A note for the run's Activity, under How it ran, when there is no task to read tool calls from.
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

  // The schedule a run's fire belongs to, when the Bureau recorded it: its name titles the run.
  const originScheduleId = $derived.by((): string | undefined => {
    const recorded = task.data?.origin;
    if (recorded === null || recorded === undefined || recorded.kind !== 'schedule') {
      return undefined;
    }
    const id: unknown = Reflect.get(recorded, 'scheduleId');
    return typeof id === 'string' && id !== '' ? id : undefined;
  });
  const schedules = createQuery(
    () => ({
      queryKey: ['bureau-schedules', 'run-page'] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => listBureauSchedules({ signal }),
      enabled: originScheduleId !== undefined,
      retry: false,
    }),
    undefined,
  );

  // The run as the Runs list reads it: what started it, and what it is called.
  const runRow = $derived.by(() => {
    const read = task.data;
    const session = chat.data ?? attemptSession.data;
    const scheduleNames = new Map<string, string>();
    for (const schedule of schedules.data ?? []) {
      if (schedule.description !== null) scheduleNames.set(schedule.id, schedule.description);
    }
    return buildRunRows({
      tasks: read === undefined ? [] : [read],
      goals: attempt === undefined ? [] : [attempt.goal],
      chats: session === undefined ? [] : [session],
      scheduleNames,
    }).find((row) => row.id === initialRunId);
  });

  // What the run is called, when something names it: the goal, the schedule, or the chat. A run
  // none of them names is shown by what ran (the agent or the workflow), as an identifier.
  const runTitle = $derived.by((): string | undefined => {
    const row = runRow;
    if (row === undefined) return undefined;
    const chatTitle = (chat.data ?? attemptSession.data)?.title ?? '';
    if (row.origin.kind === 'goal') return row.title;
    if (row.origin.kind === 'schedule') {
      const named = row.origin.scheduleId === null ? undefined : row.title;
      return named !== undefined && named !== TASK_COPY.untitledChat
        ? named
        : chatTitle === ''
          ? undefined
          : chatTitle;
    }
    if (row.origin.kind === 'chat') return chatTitle === '' ? undefined : chatTitle;
    return undefined;
  });
  const builtInName = $derived(
    summary === undefined || task.data !== undefined || attempt !== undefined
      ? undefined
      : builtInWorkflowName(summary.title ?? ''),
  );
  const displayTitle = $derived(runTitle ?? builtInName);
  // The label belongs to this run's own address, which is read once so that it never labels the next
  // page while a navigation is under way.
  const crumbPath = untrack(() => router.pathname);
  usePageLabel(() => ({ path: crumbPath, label: displayTitle }));

  // The page the header's second link opens: the goal an attempt belongs to, or the schedule.
  const ownerLink = $derived.by(() => {
    const origin = runRow?.origin;
    if (origin?.kind === 'goal') return { href: origin.href, label: RUN_DETAIL_COPY.openGoal };
    if (origin?.kind === 'schedule' && origin.schedulePath !== null) {
      return { href: origin.schedulePath, label: RUN_DETAIL_COPY.openSchedule };
    }
    return undefined;
  });
  // Run again sets up another run of a workflow somebody built; the Bureau's own workflows (a chat,
  // a goal's attempt, the heartbeat) start themselves, and no page re-runs a chat or a fire.
  const runAgainPath = $derived.by((): string | undefined => {
    if (task.data !== undefined || attempt !== undefined || summary?.over !== true)
      return undefined;
    const type = workflow?.type ?? record?.workflow;
    return type === undefined || isBuiltInWorkflow(type) ? undefined : workflowRunSetupPath(type);
  });

  // How it ran is closed for a finished run of the Bureau's, which a person reads for what happened,
  // and open for any other: a run still going shows its approvals there, and a run only the engine
  // holds has nothing else. The default is settled once, when the run is first known, so a run that
  // finishes while it is watched does not fold up under the person watching it.
  let howDefault = $state<boolean | undefined>(undefined);
  let howOverride = $state<boolean | undefined>(undefined);
  $effect.pre(() => {
    if (howDefault !== undefined || summary === undefined) return;
    howDefault = !(task.data !== undefined && summary.over);
  });
  const howOpen = $derived(howOverride ?? howDefault ?? true);
  let restartOpen = $state(false);
  /** Whether an answer to the run's question is in its Undo window, which the status line says. */
  let answerHeld = $state(false);
  const answerUndoSeconds = $derived(Math.round(answerUndoMilliseconds() / 1000));

  /** Whether Cancel, in the status line a slow read shows, stopped the read of the run. */
  let loadCanceled = $state(false);
  function cancelLoading(): void {
    loadCanceled = true;
    void queryClient.cancelQueries({ queryKey: detailKey });
    void queryClient.cancelQueries({ queryKey: queryKeys.goals.runs() });
  }
  function retryLoading(): void {
    loadCanceled = false;
    void task.refetch();
  }
</script>

<!-- The header the route can draw at once: the run's identifier names it until the run is known. -->
{#snippet unknownHeader()}
  <RunHeader
    runId={initialRunId}
    title={undefined}
    fallbackTitle={RUN_DETAIL_COPY.runHeading(initialRunId)}
    status={undefined}
  />
{/snippet}

{#if follower.removed || unknownRun}
  <NotFoundState
    title={TASK_COPY.notFound.title}
    description={TASK_COPY.notFound.description}
    view="runs"
  />
{:else if failed}
  <article class="ib-run" aria-label={TASK_COPY.runTitle}>
    {@render unknownHeader()}
    <ErrorState
      variant="flat"
      title={TASK_COPY.loadFailed.title}
      description={TASK_COPY.loadFailed.description}
      headingLevel={2}
      retryLabel={RETRY_LABEL}
      onRetry={() => void (notFound && goals.isError ? goals.refetch() : task.refetch())}
    />
  </article>
{:else if lookupFailed}
  <article class="ib-run" aria-label={TASK_COPY.runTitle}>
    {@render unknownHeader()}
    <ErrorState
      variant="flat"
      title={TASK_COPY.loadFailed.title}
      description={engine.fault?.message ?? TASK_COPY.loadFailed.description}
      headingLevel={2}
      retryLabel={RETRY_LABEL}
      onRetry={() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(initialRunId) });
        void fileRun.refetch();
      }}
    />
  </article>
{:else if loadCanceled && summary === undefined}
  <article class="ib-run" aria-label={TASK_COPY.runTitle}>
    {@render unknownHeader()}
    <ErrorState
      bordered
      tone="neutral"
      headingLevel={2}
      title={RUN_DETAIL_COPY.states.loadingCanceled.title}
      description={RUN_DETAIL_COPY.states.loadingCanceled.description}
      retryLabel={RETRY_LABEL}
      onRetry={retryLoading}
    />
  </article>
{:else}
  <article class="ib-run" aria-label={TASK_COPY.runTitle}>
    {#if summary !== undefined}
      <RunHeader
        runId={initialRunId}
        title={displayTitle ??
          summary.title ??
          (task.data === undefined ? undefined : TASK_COPY.unknownAgent)}
        titleIsIdentifier={displayTitle === undefined}
        fallbackTitle={TASK_COPY.runTitle}
        status={statusLine?.word ?? summary.status}
        startedAt={summary.startedAt}
        tookMilliseconds={summary.over && attemptLine?.checking !== true
          ? Math.max(0, summary.updatedAt - summary.startedAt)
          : undefined}
        phrases={statusLine?.phrases}
        waitingForSignals={statusLine?.signals}
        cancelRun={(statusLine?.signals.length ?? 0) > 0}
        tookWord={summary.status === 'Canceled' ? 'ran' : 'took'}
        task={task.data}
        chat={chatLink}
        owner={ownerLink}
        runAgain={runAgainPath}
        note={answerHeld ? TASK_COPY.answerSentStatus(answerUndoSeconds) : undefined}
        engineStatus={workflow?.status}
        pendingAction={engine.pendingAction}
        actionGate={engine.actionGate}
        onAction={(action) => engine.act(action)}
        onRestart={() => (restartOpen = true)}
      />
    {:else}
      {@render unknownHeader()}
    {/if}

    <div class="ib-run__layout">
      <div class="ib-run__main">
        {#if summary === undefined && loading}
          <section
            class="ib-run__section"
            aria-labelledby="ib-run-happened"
            data-section="what-happened"
          >
            <h2 id="ib-run-happened" class="ib-run__heading-2">
              {RUN_DETAIL_COPY.happened.heading}
            </h2>
            <Skeleton
              variant="list"
              rows={3}
              delay={LOADING_DELAY_MILLISECONDS}
              stillLoadingAfter={STILL_LOADING_MILLISECONDS}
              stillLoadingLabel={RUN_DETAIL_COPY.states.stillLoading}
              label={RUN_DETAIL_COPY.states.loadingHappened}
              onCancel={cancelLoading}
            />
          </section>
        {/if}
        {#if task.data}
          <RunWaiting task={task.data} onAnswerHold={(held) => (answerHeld = held)} />
          <RunMessageBlocked task={task.data} />
        {/if}
        {#if summary !== undefined}
          <RunInputOutput
            task={task.data}
            threadId={goalTask ? attemptThreadId : undefined}
            startedAt={summary.startedAt}
            answerHtml={answer === undefined ? undefined : answerHtml}
            answerTruncated={follower.artifact?.truncated === true}
            followState={follower.state}
            {workflow}
            {record}
            showRaw={false}
            onShowRaw={task.data !== undefined && (workflow !== undefined || record !== undefined)
              ? () => (howOverride = true)
              : undefined}
          />
          {#if task.data !== undefined}
            <RunHappened
              task={task.data}
              threadId={goalTask ? attemptThreadId : undefined}
              startedAt={summary.startedAt}
              events={taskEvents}
            />
          {/if}
          <RunHowItRan bind:open={() => howOpen, (open) => (howOverride = open)}>
            {#if task.data !== undefined && (workflow !== undefined || record !== undefined)}
              <section
                class="ib-run__section"
                aria-labelledby="ib-run-raw"
                data-section="raw-payloads"
              >
                <h3 id="ib-run-raw" class="ib-run__heading-3">
                  {RUN_DETAIL_COPY.howItRan.rawPayloads}
                </h3>
                <RunPayloadCards {workflow} {record} />
              </section>
            {/if}
            <RunActivity
              task={task.data}
              threadId={goalTask ? attemptThreadId : undefined}
              {taskEvents}
              note={activityNote}
              engine={workflow === undefined ? undefined : engine}
              {workflow}
              decideApprovals={false}
            />
            {#if task.data !== undefined}
              <RunPanels taskId={task.data.id} />
            {/if}
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
          </RunHowItRan>
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
          workflowOrigin={record?.origin?.kind === 'agent-run' ? record.origin : null}
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
