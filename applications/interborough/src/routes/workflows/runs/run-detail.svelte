<script lang="ts">
  import { browserWorkspaceStorage } from '../../../app/workspace-lifetime.ts';

  /**
   * `/runs/:run`: one run, as one page with one header and one status; only How it ran, the
   * disclosure for operators, holds tabs (Steps, Inspector, Raw payloads, Events and logs, and
   * Versioning and Search attributes when the run has something in them, COR-2424). The header says
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

  import { ErrorState, Section, Skeleton } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { usePageLabel } from '../../../app/breadcrumbs.svelte.ts';
  import { RETRY_LABEL } from '../../../app/copy/views.ts';
  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import { answerUndoMilliseconds } from '../../../lib/answer-undo.ts';
  import { useBureauEventsLive } from '../../../app/live-polling.svelte.ts';
  import NotFoundState from '../../../app/not-found-state.svelte';
  import { readScheduleAttention } from '../../../lib/bureau-attention.ts';
  import { getContext, getThreadMessages } from '../../../lib/bureau-client.ts';
  import { listAllGoals } from '../../../lib/bureau-goals.ts';
  import { listBureauSchedules } from '../../../lib/bureau-schedules.ts';
  import {
    getTask,
    isTerminalState,
    type TaskCleanup,
    type TaskView,
  } from '../../../lib/bureau-tasks.ts';
  import {
    classifyFault,
    faultErrorStateAdvice,
    treatmentErrorStateAdvice,
  } from '../../../lib/faults.ts';
  import { chatSessionPath } from '../../../lib/identifier-paths.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { getPrincipalStore, principalQueryScope } from '../../../lib/scopes.svelte.ts';
  import {
    attemptStatusWord,
    taskStatusWord,
    workflowRunStatusWord,
    type StatusWord,
  } from '../../../lib/status.ts';
  import { getWorkflowFileRun } from '../../../lib/workflow-files.ts';
  import {
    builtInWorkflowName,
    isBuiltInWorkflow,
    workflowTypeName,
  } from '../../../lib/workflow-type-name.ts';
  import { agentsOfSteps } from '../../schedules/schedule-row-model.ts';
  import '../detail/workflow-detail.css';
  import { isTerminalStatus } from '../detail/workflow-status.ts';
  import RestartDialog from '../detail/restart-dialog.svelte';
  import RunActivity from './run-activity.svelte';
  import RunAttentionNote from './run-attention-note.svelte';
  import { threadIdForTask } from './run-activity.ts';
  import { RunAgain } from './run-again.svelte.ts';
  import { messageInOfRun } from './run-message-in.ts';
  import RunSendMessage from './run-send-message.svelte';
  import { canSendMessage } from './run-send-message.ts';
  import RunChange from './run-change.svelte';
  import RunDetails from './run-details.svelte';
  import RunEnginePanels from './run-engine-panels.svelte';
  import { RunEngine } from './run-engine.svelte.ts';
  import RunHappened from './run-happened.svelte';
  import RunHeader from './run-header.svelte';
  import RunHooks from './run-hooks.svelte';
  import RunInputOutput from './run-input-output.svelte';
  import LineagePanel from '../detail/lineage-panel.svelte';
  import RunInspector from './run-inspector.svelte';
  import { instanceEntries, progressPhrase, triesOfStep } from './run-instance.ts';
  import {
    fetchWorkflowTimeline,
    workflowTimelineQueryKey,
  } from '../detail/workflow-timeline-data.ts';
  import RunInstanceHappened from './run-instance-happened.svelte';
  import { RunInstance } from './run-instance.svelte.ts';
  import { RunRetry } from './run-retry.svelte.ts';
  import RunHowItRan from './run-how-it-ran.svelte';
  import RunHowItRanTabs from './run-how-it-ran-tabs.svelte';
  import RunEngineHistory from './run-engine-history.svelte';
  import { attributesClientOf, hasVersioning } from './run-engine-attributes.ts';
  import { attributesQueryKey, readAttributes } from '../detail/attributes/attributes-data.ts';
  import {
    getScheduleProvenance,
    scheduleProvenanceQueryKey,
  } from '../detail/workflow-observability.ts';
  import RunPanels from './run-panels.svelte';
  import RunPayloadCards from './run-payload-cards.svelte';
  import { buildRunRows } from './run-rows.ts';
  import {
    howItRanOpensFirst,
    phrasesWithStep,
    runStatusLine,
    startedAgoPhrases,
  } from './run-status-line.ts';
  import RunMessageBlocked from './run-message-blocked.svelte';
  import RunWaiting from './run-waiting.svelte';
  import { TaskFollower } from './task-follower.svelte.ts';

  /** The workflow type of the schedule tick, which the Bureau starts to record what its scheduler did. */
  const SCHEDULE_TICK_WORKFLOW_TYPE = 'scheduleTick';
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
  // The schedule tick is the Bureau's own record of what its scheduler did: a person reads it and
  // changes nothing, so its page offers no suspend, cancel, restart, signal, update or query.
  const readOnlyRun = $derived(workflow?.type === SCHEDULE_TICK_WORKFLOW_TYPE);

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
      // The record may settle before the engine-backed page starts reading its origin.
      notifyOnChangeProps: 'all',
    }),
    undefined,
  );
  const record = $derived(fileRun.data);
  const fileRunAbsent = $derived(
    fileRun.isError && classifyFault(fileRun.error)?.kind === 'not-found',
  );
  // The engine, or the Bureau's record of a workflow file's run, is still being asked for the run.
  const engineAsking = $derived(
    engineAllowed &&
      attempt === undefined &&
      ((engine.workflow === undefined && engine.fault === null) ||
        (engine.notFound && fileRun.isPending)),
  );

  const answer = $derived(follower.artifact?.text);

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

  // An instance of a workflow file: how far it got, the steps of the version it ran and which
  // version that is, read from the Bureau (COR-2424). A run the Bureau has a task for, or a goal's
  // attempt, is not one, and reads nothing here.
  const instance = new RunInstance(() => ({
    runId: initialRunId,
    type:
      task.data !== undefined || attempt !== undefined
        ? undefined
        : (workflow?.type ?? record?.workflow),
    ranVersion: workflow?.versionTuple.workflowVersion ?? record?.workflowVersion,
    updatedAt: summary?.updatedAt,
    allowed: engineAllowed,
  }));
  const progress = $derived(instance.progress);
  const instanceFailed = $derived(summary?.status === 'Failed');
  const stepPhrase = $derived(
    progress === undefined ? undefined : progressPhrase(progress, instanceFailed),
  );
  // A failed run says where it failed right after the word; a run going on says it after how long.
  const stepNote = $derived(instanceFailed ? stepPhrase : undefined);
  // An instance of a workflow file that is going on says "Started 40 s ago, step 2 of 4" in place of
  // the day, the time and "so far" (row 54l); a chat's run keeps its day, time and "so far" (06b).
  const startedAgo = $derived(
    summary === undefined
      ? undefined
      : startedAgoPhrases({
          status: summary.status,
          over: summary.over,
          failed: instanceFailed,
          stepPhrase,
          signals: statusLine?.signals ?? [],
          startedAt: summary.startedAt,
          now: engine.clock.now,
        }),
  );
  const startedAgoLine = $derived(startedAgo !== undefined);
  const statusPhrases = $derived(
    startedAgo ??
      phrasesWithStep(statusLine?.phrases, stepPhrase, {
        failed: instanceFailed,
        over: summary?.over === true,
        waitingForSignal: (statusLine?.signals.length ?? 0) > 0,
      }),
  );
  const instanceEntryList = $derived(
    progress === undefined || progress.at === null || summary === undefined
      ? undefined
      : instanceEntries({
          events: instance.events,
          steps: instance.steps,
          startedAt: summary.startedAt,
          status: instanceFailed ? 'failed' : summary.over ? 'over' : 'running',
        }),
  );

  const attemptThreadId = $derived(
    attempt !== undefined && attempt.attempt.sessionId !== '' ? attempt.attempt.sessionId : null,
  );
  // A goal's attempt offers Open goal and the menu only (row 55f): its session is the goal's to
  // open, so the header has no link to it.
  const chatLink = $derived.by(() => {
    if (goalTask || attempt !== undefined || task.data === undefined) return undefined;
    // A schedule's run offers Open schedule, Run again and the menu (row 55j): the session its
    // fire ran in is the schedule's, not a chat a person opens from here.
    if (runRow?.origin.kind === 'schedule') return undefined;
    return chat.isSuccess
      ? {
          href: chatSessionPath(task.data.contextId),
          label: chat.data.origin === 'chat' ? TASK_COPY.openChat : TASK_COPY.openSession,
        }
      : undefined;
  });
  // The session a goal's attempt or a schedule's fire ran in, which its header does not link (rows
  // 55f, 55j): the Details rail opens it, as the only place a goal's session is reached from, and
  // only while the Bureau still has it.
  const railSession = $derived.by((): string | undefined => {
    if (goalTask || attempt !== undefined) {
      return attemptSession.isSuccess ? chatSessionPath(attemptSession.data.id) : undefined;
    }
    if (task.data !== undefined && runRow?.origin.kind === 'schedule' && chat.isSuccess) {
      return chatSessionPath(task.data.contextId);
    }
    return undefined;
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

  // The goals are looked at only to find a goal's attempt: when they cannot be read and the engine,
  // or the Bureau's record of a workflow file, holds the run, that run is shown, not an error about
  // a read it did not need (COR-2424).
  // A read that fails after the task was read leaves the page as it was, as the run list does while
  // the server does not answer (C3-23): the shell's banner says it once.
  const failed = $derived(
    (task.isError && !notFound && task.data === undefined) ||
      (notFound && goals.isError && summary === undefined && !engineAsking),
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
    summary === undefined && (task.isPending || (notFound && (goals.isPending || engineAsking))),
  );

  // The schedule a run's fire belongs to, when the Bureau recorded it: its name titles the run.
  const originScheduleId = $derived.by((): string | undefined => {
    const recorded = task.data?.origin ?? record?.origin;
    if (recorded !== null && recorded !== undefined && recorded.kind === 'schedule') {
      const id: unknown = Reflect.get(recorded, 'scheduleId');
      return typeof id === 'string' && id !== '' ? id : undefined;
    }
    // An instance a schedule fired is started with the schedule's trigger for its input.
    const input: unknown = workflow?.input;
    if (task.data === undefined && typeof input === 'object' && input !== null) {
      const kind: unknown = Reflect.get(input, 'kind');
      const id: unknown = Reflect.get(input, 'scheduleId');
      if (kind === 'schedule' && typeof id === 'string' && id !== '') return id;
    }
    return undefined;
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
  // The schedule that started the run, as the Bureau lists it: it names the run's Started by and
  // Schedule rows, says when it runs, and says whether this was its last run (COR-2424).
  const startingSchedule = $derived(
    originScheduleId === undefined
      ? undefined
      : schedules.data?.find((schedule) => schedule.id === originScheduleId),
  );

  // How many occurrences the schedule missed and has not fired since, which the Bureau's attention
  // list says; the schedule's own count is a lifetime one. A read that fails leaves it unsaid.
  const attention = createQuery(
    () => ({
      queryKey: ['bureau-attention', 'run-page'] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => readScheduleAttention({ signal }),
      enabled: originScheduleId !== undefined,
      retry: false,
    }),
    undefined,
  );
  const missedSince = $derived(
    originScheduleId === undefined
      ? undefined
      : attention.data?.missedRuns.get(originScheduleId)?.count,
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
  // An instance of a workflow file is called by the file's name, "Release notes", as the breadcrumb
  // and the heading say it (rows 54y, 55d); any other engine run is shown by its type's identifier.
  // A run of a workflow type nothing else names (no file, no built-in name) is still called by its
  // type in words, as the rail says it: "Order processing", never `order-processing` (row S68).
  const typeName = $derived(
    summary === undefined ||
      summary.title === undefined ||
      task.data !== undefined ||
      attempt !== undefined
      ? undefined
      : workflowTypeName(summary.title),
  );
  const displayTitle = $derived(runTitle ?? builtInName ?? instance.name ?? typeName);
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
  // The message that started a chat's run, which Run again puts in a new chat: the same read the
  // Input and output section makes (one key, so one request).
  const taskThread = $derived.by((): string | null => {
    if (task.data === undefined) return null;
    const explicit = threadIdForTask(task.data, goalTask ? attemptThreadId : undefined);
    return explicit === undefined ? task.data.contextId : explicit;
  });
  const messageThread = createQuery(
    () => ({
      queryKey: ['bureau-tasks', 'message-in', taskThread, task.data?.id ?? ''] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getThreadMessages(taskThread ?? '', { signal }),
      enabled: task.data !== undefined && taskThread !== null && taskThread !== '',
      retry: false,
    }),
    undefined,
  );
  // Run again: a chat's run in a new chat, a schedule's run started now, an instance of a workflow
  // somebody built set up again. A goal's attempt has none, because the goal owns rerunning, and
  // the Bureau's other workflows start themselves (COR-2424).
  const runAgain = new RunAgain(() => ({
    over: summary?.over === true,
    goalAttempt: attempt !== undefined || goalTask,
    task: task.data,
    messageIn:
      task.data === undefined || messageThread.data === undefined
        ? undefined
        : messageInOfRun(task.data.id, messageThread.data),
    workflowType: task.data === undefined ? (workflow?.type ?? record?.workflow) : undefined,
    agents: task.data?.agentName != null ? [task.data.agentName] : agentsOfSteps(instance.steps),
  }));
  const runAgainAction = $derived.by(() => {
    const kind = runAgain.kind;
    if (kind === undefined) return undefined;
    return {
      ...(kind.kind === 'open' ? { href: kind.href } : { onRun: () => runAgain.run() }),
      blocked: runAgain.blocked,
      busy: runAgain.busy,
    };
  });

  // Whether the run has search attributes, which is when How it ran has a Search attributes tab
  // (row 54i). The panel in that tab reads the same key, so this is one request.
  const attributesClient = $derived(attributesClientOf(engine.client));
  const attributes = createQuery(
    () => ({
      queryKey: attributesQueryKey(initialRunId),
      queryFn: () => readAttributes(attributesClient!, initialRunId),
      enabled:
        workflow !== undefined &&
        attributesClient !== undefined &&
        principal.hasScope('attributes:read'),
      retry: false,
    }),
    undefined,
  );
  const hasAttributes = $derived(attributes.data?.kind === 'present');
  // A run a schedule launched has the schedule in its lineage, on the Versioning tab with its worker
  // binding and the runs it replaced or was forked from. The lineage panel reads the same key.
  const scheduleProvenance = createQuery(
    () => ({
      queryKey: scheduleProvenanceQueryKey(initialRunId),
      queryFn: () => getScheduleProvenance(engine.client, initialRunId),
      enabled: workflow !== undefined,
      retry: false,
    }),
    undefined,
  );
  // A fork's lineage, its schedule provenance among it, is drawn ahead of the tabs, so the tab is
  // shown for the worker version alone.
  const versioningShown = $derived(
    workflow !== undefined &&
      (hasVersioning(workflow) ||
        (workflow.forkedFrom === undefined &&
          scheduleProvenance.data !== undefined &&
          scheduleProvenance.data !== null)),
  );

  // How many times the failed step was tried, and how long that took: the engine's timeline keeps
  // one entry per try, which the Bureau's history does not (row 55b). The Timeline section reads the
  // same key, so this is one request.
  const failedTimeline = createQuery(
    () => ({
      queryKey: [
        ...workflowTimelineQueryKey(initialRunId),
        principalQueryScope(principal.principal),
      ],
      queryFn: () => fetchWorkflowTimeline(engine.client, initialRunId),
      enabled: instanceFailed && workflow !== undefined && task.data === undefined,
      retry: false,
    }),
    undefined,
  );
  const stepTries = $derived(
    progress?.at === null || progress?.at === undefined || failedTimeline.data === undefined
      ? undefined
      : triesOfStep(failedTimeline.data, progress.at),
  );
  const failureProgress = $derived(
    progress === undefined || stepTries === undefined
      ? progress
      : { ...progress, tries: Math.max(progress.tries, stepTries.tries) },
  );

  // Retry from this step: a failed instance of a workflow file runs again in place from the step it
  // failed at, on the version it ran (COR-2424, rows 54z, 14t, 55b). Any other run has none.
  // Held, like Restart in More, for a caller without `workflows:write`.
  const retryGate = $derived(engine.actionGate);
  const runRetry = new RunRetry(() => ({
    runId: initialRunId,
    failedStep: progress?.at ?? undefined,
    failedInstance:
      instanceFailed &&
      task.data === undefined &&
      attempt === undefined &&
      instance.name !== undefined &&
      !readOnlyRun &&
      // A run whose input or result broke the schema failed outside a step: nothing to retry.
      (record?.finishReason === null || record?.finishReason === undefined),
  }));
  const retryAction = $derived(
    runRetry.step === undefined
      ? undefined
      : { onRetry: () => runRetry.retry(), busy: runRetry.busy, gate: retryGate },
  );
  // Beside the buttons, which version each runs on: the one this run ran, and the current one.
  const besideButtons = $derived.by(() => {
    const standing = instance.version;
    if (retryAction === undefined || standing === undefined || standing.state === 'unknown') {
      return undefined;
    }
    return RUN_DETAIL_COPY.instance.besideButtons(
      standing.ran,
      standing.state === 'older' ? standing.current : null,
    );
  });

  // How it ran is closed for a finished run, at every width, which a person reads for what happened
  // (row 54a), and open for a run still going, which shows its approvals there. The default is
  // settled once, when the run is first known, so a run that finishes while it is watched does not
  // fold up under the person watching it, and a finished run never opens before it is known.
  let howDefault = $state<boolean | undefined>(undefined);
  let howOverride = $state<boolean | undefined>(undefined);
  $effect.pre(() => {
    if (howDefault !== undefined || summary === undefined) return;
    howDefault = howItRanOpensFirst(summary.over);
  });
  const howOpen = $derived(howOverride ?? howDefault ?? false);
  /** The tab open in How it ran: Steps, unless the link under a reply opened Raw payloads. */
  let howTab = $state('steps');
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

<!-- What happened in an instance of a workflow file: its steps, and the failure on the step that
     failed. A failed instance draws it above Input and output, any other after it. -->
{#snippet instanceHappened(entries: NonNullable<typeof instanceEntryList>, startedAt: number)}
  <RunInstanceHappened
    runId={initialRunId}
    {entries}
    {startedAt}
    progress={failureProgress}
    failed={instanceFailed}
    category={workflow?.failureCategory}
    errorStack={workflow?.errorStack}
    failure={instanceFailed ? (workflow?.error ?? record?.error ?? undefined) : undefined}
    triesTook={stepTries?.took}
    retryVersion={retryAction === undefined ? undefined : instance.version?.ran}
    onOpenStep={() => {
      howOverride = true;
      howTab = 'steps';
    }}
  />
{/snippet}

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
      {...faultErrorStateAdvice(
        notFound && goals.isError ? goals.error : task.error,
        () => void (notFound && goals.isError ? goals.refetch() : task.refetch()),
      )}
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
      {...treatmentErrorStateAdvice(engine.fault ?? {}, () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(initialRunId) });
        void fileRun.refetch();
      })}
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
  <article
    class="ib-run"
    data-failed-run={instanceFailed ? '' : undefined}
    aria-label={TASK_COPY.runTitle}
  >
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
        showStamp={!startedAgoLine}
        tookMilliseconds={summary.over && attemptLine?.checking !== true
          ? Math.max(0, summary.updatedAt - summary.startedAt)
          : undefined}
        phrases={statusPhrases}
        {stepNote}
        waitingForSignals={statusLine?.signals}
        cancelRun={(statusLine?.signals.length ?? 0) > 0}
        tookWord={summary.status === 'Canceled' ? 'ran' : 'took'}
        task={task.data}
        cancelInHeader={!(task.data !== undefined && canSendMessage(task.data))}
        chat={chatLink}
        owner={ownerLink}
        runAgain={runAgainAction}
        retry={retryAction}
        {besideButtons}
        note={answerHeld ? TASK_COPY.answerSentStatus(answerUndoSeconds) : undefined}
        engineStatus={readOnlyRun ? undefined : workflow?.status}
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
          <!-- The same Section the loaded What happened is, so nothing moves when it arrives. -->
          <Section title={RUN_DETAIL_COPY.happened.heading} data-section="what-happened">
            <Skeleton
              variant="list"
              rows={3}
              delay={LOADING_DELAY_MILLISECONDS}
              stillLoadingAfter={STILL_LOADING_MILLISECONDS}
              stillLoadingLabel={RUN_DETAIL_COPY.states.stillLoading}
              label={RUN_DETAIL_COPY.states.loadingHappened}
              onCancel={cancelLoading}
            />
          </Section>
        {/if}
        {#if task.data}
          <RunAttentionNote task={task.data} />
          <RunWaiting task={task.data} onAnswerHold={(held) => (answerHeld = held)} />
          <RunMessageBlocked task={task.data} />
        {/if}
        {#if summary !== undefined}
          <!-- A failed instance says why it failed on the step that failed, so What happened leads,
               above Input and output, and on a phone the failure is the first thing under the
               header (COR-2489). -->
          {#if task.data === undefined && instanceEntryList !== undefined && instanceFailed}
            {@render instanceHappened(instanceEntryList, summary.startedAt)}
          {/if}
          <RunInputOutput
            task={task.data}
            threadId={goalTask ? attemptThreadId : undefined}
            startedAt={summary.startedAt}
            {answer}
            answerTruncated={follower.artifact?.truncated === true}
            followState={follower.state}
            {workflow}
            {record}
            showRaw={false}
            failureOnStep={instanceEntryList !== undefined && task.data === undefined}
            failedAt={instanceFailed ? (progress?.at ?? undefined) : undefined}
            onShowRaw={task.data !== undefined && (workflow !== undefined || record !== undefined)
              ? () => {
                  howOverride = true;
                  howTab = 'raw';
                }
              : undefined}
          />
          {#if task.data === undefined && instanceEntryList !== undefined && !instanceFailed}
            {@render instanceHappened(instanceEntryList, summary.startedAt)}
          {/if}
          {#if task.data !== undefined}
            <RunHappened
              task={task.data}
              threadId={goalTask ? attemptThreadId : undefined}
              startedAt={summary.startedAt}
              events={taskEvents}
            />
            <!-- Directly after What happened and before How it ran, at every width, so a settled
                 run's failed hooks are never inside the disclosure that is closed for it. -->
            <RunHooks task={task.data} over={summary.over} events={taskEvents} />
          {/if}
          <!-- COR-2424, row 54i: Steps, Inspector, Raw payloads and Events and logs, then
               Versioning and Search attributes only when the run has something in them. -->
          {#snippet stepsTab()}
            <RunActivity
              task={task.data}
              documentWorkflow={record !== undefined}
              threadId={goalTask ? attemptThreadId : undefined}
              {taskEvents}
              note={activityNote}
              engine={workflow === undefined ? undefined : engine}
              {workflow}
              decideApprovals={false}
              history={false}
            />
            {#if workflow === undefined && engine.fault !== null}
              <!-- The Bureau's side is shown; the engine's could not be read, and that is said. -->
              <ErrorState
                variant="flat"
                title={TASK_COPY.engineReadFailed}
                description={engine.fault.message}
                headingLevel={2}
                retryLabel={RETRY_LABEL}
                {...treatmentErrorStateAdvice(
                  engine.fault,
                  () =>
                    void queryClient.invalidateQueries({
                      queryKey: queryKeys.workflows.detail(initialRunId),
                    }),
                )}
              />
            {/if}
          {/snippet}
          {#snippet inspectorTab()}
            {#if task.data !== undefined}
              <RunInspector
                task={task.data}
                followState={follower.state}
                waitingForSignals={workflow?.waitingForSignals}
                builtIn={isBuiltInWorkflow(task.data.workflow?.type ?? '')}
              />
              <RunPanels taskId={task.data.id} failed={task.data.status === 'failed'} />
            {:else if notFound && workflow !== undefined}
              <!-- A run only the engine holds has no task: its panels are given the engine's run. One
                   placed `when: 'failed'` shows only when the run failed (COR-2543), and each panel
                   only when it has something to say about it, such as the comparison on a fork. -->
              <RunPanels
                workflowId={workflow.id}
                fork={workflow.forkedFrom !== undefined}
                failed={instanceFailed}
              />
            {/if}
            {#if workflow !== undefined && !readOnlyRun}<RunChange {engine} {workflow} />{/if}
          {/snippet}
          {#snippet rawTab()}
            <Section
              level={3}
              title={RUN_DETAIL_COPY.howItRan.rawPayloads}
              data-section="raw-payloads"
            >
              <RunPayloadCards {workflow} {record} />
            </Section>
          {/snippet}
          {#snippet eventsTab()}
            {#if workflow !== undefined}<RunEngineHistory {engine} {workflow} />{/if}
          {/snippet}
          {#snippet versioningTab()}
            {#if workflow !== undefined}
              <RunEnginePanels {engine} {workflow} part="versioning" />
            {/if}
          {/snippet}
          {#snippet attributesTab()}
            {#if workflow !== undefined}
              <RunEnginePanels {engine} {workflow} part="attributes" />
            {/if}
          {/snippet}
          <!-- A fork's lineage, with the comparison with its source a button away, leads the operator
               tabs: where a reader of a fork is looking, never behind the Versioning tab under that
               tab's own empty state. A run that is not a fork keeps its lineage in Versioning. -->
          {#if workflow !== undefined && workflow.forkedFrom !== undefined}
            <LineagePanel client={engine.client} {workflow} />
          {/if}
          <RunHowItRan bind:open={() => howOpen, (open) => (howOverride = open)}>
            <RunHowItRanTabs
              bind:active={howTab}
              steps={stepsTab}
              inspector={task.data !== undefined || (workflow !== undefined && !readOnlyRun)
                ? inspectorTab
                : undefined}
              raw={task.data !== undefined && (workflow !== undefined || record !== undefined)
                ? rawTab
                : undefined}
              events={workflow === undefined ? undefined : eventsTab}
              versioning={versioningShown ? versioningTab : undefined}
              attributes={hasAttributes ? attributesTab : undefined}
            />
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
          over={summary.over}
          versionStanding={instance.version}
          schedule={startingSchedule}
          {missedSince}
          recordOrigin={task.data === undefined ? record?.origin : undefined}
          viewer={principal.principal?.subject}
          session={railSession}
        />
      {/if}
    </div>
    <!-- A chat's run that is going takes a message, docked at the bottom of the page (row 06b). -->
    {#if task.data !== undefined && canSendMessage(task.data)}
      <RunSendMessage contextId={task.data.contextId} runId={initialRunId} task={task.data} />
    {/if}
  </article>

  {#if restartOpen && workflow !== undefined}
    <RestartDialog client={engine.client} {workflow} onClose={() => (restartOpen = false)} />
  {/if}
{/if}
