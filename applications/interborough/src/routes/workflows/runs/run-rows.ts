/**
 * The rows of `/runs`: one list of what the agents have done, in the words of a task. Two sources
 * are joined. The Bureau's tasks (`bureau.tasks.list`) are the runs of chats, of goal attempts and
 * workflow steps, and of anything started with `bureau.run()`; the goals (`bureau.goals.list`) add
 * the attempts recorded before attempts were tasks, name the session an attempt ran in, and say
 * which attempt a run is and whether it met the goal's check. Each row says which agent ran, what
 * started it, how it stands, and when. What started a run is the origin the Bureau recorded on its
 * task (COR-1867): a chat, a person, a schedule's fire, the API, an agent, a goal, or a workflow.
 * Only a task recorded before origins were kept has none, and then it is read from the task's own
 * `actor` and `kind`, as it always was. The steps of one workflow instance are one run, not one row
 * each: the instance is the run a person started.
 *
 * The list is status first (Cinder's `StackedListItem`): a status word, the title and the time it
 * started on line one, and on line two what kind of run it is, the agent, and how it went, its parts
 * joined by a comma. Rows are grouped under day bands, newest first, and a row keeps its place while
 * it runs, because the list is ordered by when each run started. The status segments count every run
 * the other filters leave; the listing has no total, so every page is read (`listAllTasks`).
 */
import { humanizeIdentifier, type DataListGroup } from '@lostgradient/cinder';

import { TASK_COPY } from '../../../app/copy/tasks.ts';
import type { ChatContext } from '../../../lib/bureau-client.ts';
import type { Goal } from '../../../lib/bureau-goals.ts';
import {
  isScheduleFire,
  isTerminalState,
  type TaskState,
  type TaskView,
} from '../../../lib/bureau-tasks.ts';
import { calendarDay, clockTime, dateLine, zoneLabel } from '../../../lib/format/clock.ts';
import { chatSessionPath, goalPath } from '../../../lib/identifier-paths.ts';
import { oneLine } from '../../../lib/one-line.ts';
import { reasonClause } from '../../../lib/reason-clause.ts';
import { scheduleDetailPath, workflowDetailPath } from '../../../lib/router.svelte.ts';
import { taskStatusWord, type StatusWord } from '../../../lib/status.ts';
import { isBuiltInWorkflow, workflowTypeName } from '../../../lib/workflow-type-name.ts';
import { workflowTypePath } from '../../../lib/workflow-type-paths.ts';
import type { MissedRuns } from './missed-runs.ts';
import { STARTED_BY_KINDS, type StartedBy } from './started-by.ts';

/** How a person started a run, as the origin records it. */
export type RunPersonSurface = 'web' | 'palette' | 'api';

export type RunOrigin =
  | { readonly kind: 'chat'; readonly title: string; readonly href: string }
  /** A person started it outside a chat, from the surface the origin names. */
  | {
      readonly kind: 'person';
      readonly surface: RunPersonSurface | null;
      /** Who started it, as the Bureau recorded them, when it did: "You" when it is the viewer. */
      readonly principal?: string | null | undefined;
    }
  /**
   * A schedule's fire. The origin names the schedule (`scheduleId`, and `schedulePath` is its page)
   * and whether a person fired it by hand. A task recorded before origins were kept says it only
   * through its `actor`, and then there is no schedule to name. Either way the fire ran in a
   * session, which is linked (`href`) and titled by the text the schedule delivered when the caller
   * lists that session, and empty when it does not (an operator sees every owner's fires and lists
   * only their own sessions). An instance of a workflow file a schedule fired ran in no session, so
   * it has no `href` (COR-2424).
   */
  | {
      readonly kind: 'schedule';
      readonly title: string;
      readonly href: string | null;
      readonly scheduleId: string | null;
      readonly schedulePath: string | null;
      readonly manual: boolean;
    }
  /** The API started it, or something with no context to name: an A2A peer, a recovered run. */
  | { readonly kind: 'api' }
  /** Another run started it, as a child: the parent run, and the tool call that started it. */
  | {
      readonly kind: 'agent';
      readonly agentName: string;
      readonly parentRunId: string;
      readonly href: string;
    }
  /** A workflow file run started by an agent tool call: the agent and its calling run. */
  | {
      readonly kind: 'agent-run';
      readonly agentName: string;
      readonly runId: string;
      readonly href: string;
    }
  /** A goal's attempt: the goal, and the session the attempt ran in while the Bureau still has it. */
  | {
      readonly kind: 'goal';
      /** The goal's identifier. */
      readonly name: string;
      /** What the goal is called (`goalName`): its own name, or its identifier in words. */
      readonly title: string;
      readonly href: string;
      readonly session: { readonly title: string; readonly href: string } | null;
    }
  /** A step of a workflow instance, or the instance its steps stand for. */
  | { readonly kind: 'parent'; readonly parentRunId: string; readonly href: string }
  /** Interborough started it for its own bookkeeping, such as the schedule tick (COR-2009). */
  | { readonly kind: 'system' }
  /**
   * A plugin's trigger started a workflow run (COR-2163): the plugin that contributes the kind, and
   * the workflow file whose trigger it is, which `href` is the page of (COR-2171). An origin that
   * names neither, as none the Bureau writes does, has `null` for both.
   */
  | {
      readonly kind: 'trigger';
      readonly plugin: string | null;
      readonly workflowId: string | null;
      readonly href: string | null;
    }
  /** A task recorded before origins were kept, which nothing else names. */
  | { readonly kind: 'none' };

/** Which attempt of its goal a run is, counted from one, and how many attempts the goal may make. */
export type RunAttempt = {
  /** The attempt's number, counted from one. */
  readonly number: number;
  /** How many attempts the goal may make. */
  readonly of: number;
};

export type RunRow = {
  readonly id: string;
  readonly agentName: string | null;
  readonly status: TaskState;
  readonly origin: RunOrigin;
  /**
   * What the row is called: the chat's title, the schedule's name, the goal's name in words, or
   * "Workflow run" for an instance of a workflow file, whose name no task carries.
   */
  readonly title: string;
  /**
   * One line about how it stands: what it waits on, or why it failed or was canceled. Nothing for a
   * run that is working or finished well: the chat's last message is the person's or another run's
   * words, not this run's.
   */
  readonly summary: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** How long it took, once it is over. */
  readonly durationMs: number | null;
  /** Which attempt of its goal the run is, or `null` for a run no goal made. */
  readonly attempt: RunAttempt | null;
  /**
   * A goal's attempt that finished without meeting the goal's check. It is Done (the run ended
   * well) and reads "Check not met" with a neutral dot, never Failed.
   */
  readonly checkNotMet: boolean;
  /**
   * The workflow the run ran on (COR-2423), when the Bureau says: `agentRun` for a chat's run,
   * `goalRun` for a goal's attempt, `scheduleTick` for the Bureau's own record of what its
   * scheduler did, or a workflow file's identifier for one of its instances. A row built from a
   * workflow's own instance list says none, and the Workflow filter then matches it by nothing.
   */
  readonly workflowType?: string | null;
  /** What the Bureau recorded of the workflow: its schedule, what a tick recorded, how far it got. */
  readonly workflow?: RunWorkflow | null;
  /** The name of the schedule the run belongs to, when it is known, which line two names it by. */
  readonly scheduleName?: string | null;
  /** When a run that asked to be woken is due, in epoch milliseconds, while it is still ahead. */
  readonly dueAt?: number | null;
  /**
   * Whether only the workflow engine holds the run: the schedule tick and an instance of a workflow
   * file, which the Bureau builds from the engine when it lists them and has no task for. Its page
   * is the engine's, so it opens for a caller who may read the engine (`workflows:read`).
   */
  readonly engineRun?: boolean;
};

/** The workflow types a task record is made for; every other type is a run only the engine holds. */
const RECORDED_TASK_WORKFLOWS: readonly string[] = ['agentRun', 'goalRun'];

/**
 * Whether a task view stands for a run only the workflow engine holds (COR-2423): the Bureau builds
 * these from the engine, with no agent and the run's own identifier for its context, so
 * `bureau.tasks.get` answers NotFound for them (COR-2424).
 */
export function isEngineRunTask(
  task: Pick<TaskView, 'id' | 'contextId' | 'agentName' | 'workflow'>,
): boolean {
  const type = task.workflow?.type;
  return (
    type !== undefined &&
    !RECORDED_TASK_WORKFLOWS.includes(type) &&
    task.agentName === null &&
    task.contextId === task.id
  );
}

/** What the Bureau says of the workflow a task ran on. */
export type RunWorkflow = NonNullable<TaskView['workflow']>;

/** The status segments of the filter bar, after All: each holds the runs of one status word. */
export const RUN_STATUS_SEGMENTS = [
  'waiting',
  'signal',
  'running',
  'done',
  'failed',
  'canceled',
] as const;

/** One status segment a filter can narrow to. */
export type RunStatusSegment = (typeof RUN_STATUS_SEGMENTS)[number];

/** Every segment the bar draws, All first. */
export const RUN_SEGMENTS = ['all', ...RUN_STATUS_SEGMENTS] as const;

/** One segment of the bar, All included. */
export type RunSegment = (typeof RUN_SEGMENTS)[number];

// `signal` is no state of a task: it is a run parked at an `await-signal` step, which `runSegmentOfRow` counts.
const SEGMENT_OF_STATE: Readonly<Record<TaskState, RunStatusSegment>> = {
  submitted: 'running',
  working: 'running',
  'input-required': 'waiting',
  completed: 'done',
  failed: 'failed',
  canceled: 'canceled',
};

/**
 * The segment a run is counted under: a task that has not started is Running, and a goal's attempt
 * that missed its check is Done, because the run itself finished.
 */
export function runSegmentOf(status: TaskState): RunStatusSegment {
  return SEGMENT_OF_STATE[status];
}

/**
 * The segment a row is counted under. A run parked at an `await-signal` step needs nobody at the
 * page, so it counts under Waiting and not under Running (COR-2424, row 56g); every other run is
 * counted by its status.
 */
export function runSegmentOfRow(
  row: Pick<RunRow, 'status'> & { readonly workflow?: RunWorkflow | null | undefined },
): RunStatusSegment {
  return awaitingSignalOf(row) === null ? runSegmentOf(row.status) : 'signal';
}

/**
 * The segments the bar draws: every one, but Waiting (a run parked on a signal) only while it
 * holds a run or is the one chosen, since most workspaces never have one.
 */
export function visibleRunSegments(
  counts: Readonly<Record<RunSegment, number>>,
  chosen: RunSegment | undefined,
): readonly RunSegment[] {
  return RUN_SEGMENTS.filter(
    (value) => value !== 'signal' || counts.signal > 0 || chosen === value,
  );
}

export type RunFilter = {
  readonly status?: RunStatusSegment;
  readonly agent?: string;
  readonly startedBy?: StartedBy;
  /** The workflow type the runs ran on (COR-2423): `agentRun`, `goalRun`, `scheduleTick`, or a workflow file's identifier. */
  readonly workflow?: string;
  /** Words the title, the agent or the summary must hold, whatever their case. */
  readonly search?: string;
};

function waitSummary(task: TaskView): string {
  const wait = task.openWaits[0];
  if (wait === undefined) return '';
  return wait.kind === 'tool-approval' ? TASK_COPY.waiting.approval : TASK_COPY.waiting.answer;
}

/** A field of the recorded origin, when it is a non-empty string. */
/**
 * A trigger's origin (COR-2171): the plugin it names, and the workflow file whose trigger started
 * the run, linked to that file's page.
 */
export function triggerOrigin(
  plugin: string | undefined,
  workflowId: string | undefined,
): Extract<RunOrigin, { kind: 'trigger' }> {
  return {
    kind: 'trigger',
    plugin: plugin ?? null,
    workflowId: workflowId ?? null,
    href: workflowId === undefined ? null : workflowTypePath(workflowId),
  };
}

function recordedText(origin: object, key: string): string | undefined {
  const value: unknown = Reflect.get(origin, key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const PERSON_SURFACES: readonly RunPersonSurface[] = ['web', 'palette', 'api'];

/**
 * A run a person started by hand, from the `person` origin the Bureau recorded: the surface they
 * started it from and who they are, so the page can say "You" for the viewer's own (COR-2424).
 */
export function personOrigin(recorded: object): Extract<RunOrigin, { kind: 'person' }> {
  const surface = PERSON_SURFACES.find((one) => one === recordedText(recorded, 'surface'));
  return {
    kind: 'person',
    surface: surface ?? null,
    principal: recordedText(recorded, 'principal') ?? null,
  };
}

/**
 * What started the task, read from the origin the Bureau recorded with it. An origin of a kind
 * this page does not know, or one missing a field its kind needs, is read as a task with none.
 */
function recordedOrigin(
  task: TaskView,
  chats: ReadonlyMap<string, ChatContext>,
): RunOrigin | undefined {
  const recorded = task.origin;
  if (recorded === null || recorded === undefined) return undefined;
  switch (recorded.kind) {
    case 'chat': {
      // The origin names the session, so a chat another owner started links to it as well; the
      // title is there only when the caller lists that session.
      const contextId = recordedText(recorded, 'contextId') ?? task.contextId;
      return {
        kind: 'chat',
        title: chats.get(contextId)?.title ?? '',
        href: chatSessionPath(contextId),
      };
    }
    case 'person':
      return personOrigin(recorded);
    case 'schedule': {
      const scheduleId = recordedText(recorded, 'scheduleId');
      return {
        kind: 'schedule',
        title: chats.get(task.contextId)?.title ?? '',
        // A run only the engine holds has its own identifier for a context, and no session has it.
        href: isEngineRunTask(task) ? null : chatSessionPath(task.contextId),
        scheduleId: scheduleId ?? null,
        schedulePath: scheduleId === undefined ? null : scheduleDetailPath(scheduleId),
        manual: Reflect.get(recorded, 'manual') === true,
      };
    }
    case 'api':
      return { kind: 'api' };
    case 'agent': {
      const parentRunId = recordedText(recorded, 'parentRunId');
      if (parentRunId === undefined) return undefined;
      return {
        kind: 'agent',
        agentName: recordedText(recorded, 'agentName') ?? '',
        parentRunId,
        href: workflowDetailPath(parentRunId),
      };
    }
    case 'agent-run': {
      const runId = recordedText(recorded, 'runId');
      if (runId === undefined) return undefined;
      return {
        kind: 'agent-run',
        agentName: recordedText(recorded, 'agentId') ?? '',
        runId,
        href: workflowDetailPath(runId),
      };
    }
    case 'goal': {
      const goalRunId = recordedText(recorded, 'goalRunId');
      if (goalRunId === undefined) return undefined;
      return {
        kind: 'goal',
        name: goalRunId,
        title: goalTitle(goalRunId),
        href: goalPath(goalRunId),
        session: null,
      };
    }
    case 'parent': {
      const parentRunId = recordedText(recorded, 'parentRunId');
      if (parentRunId === undefined) return undefined;
      return { kind: 'parent', parentRunId, href: workflowDetailPath(parentRunId) };
    }
    case 'system':
      return { kind: 'system' };
    case 'trigger':
      return triggerOrigin(recordedText(recorded, 'plugin'), recordedText(recorded, 'workflowId'));
    default:
      return undefined;
  }
}

function taskOrigin(task: TaskView, chats: ReadonlyMap<string, ChatContext>): RunOrigin {
  const recorded = recordedOrigin(task, chats);
  if (recorded !== undefined) return recorded;
  // A task recorded before origins were kept says what started it only through its `actor` and its
  // `kind`. A schedule may continue a chat session, which keeps its `chat` origin, so the session
  // cannot be asked, and the fire's link comes from the task: the caller-owned sessions listed are
  // only a source of the title. `bureau.contexts.get` decides whether it opens.
  const chat = chats.get(task.contextId);
  if (isScheduleFire(task)) {
    return {
      kind: 'schedule',
      title: chat?.title ?? '',
      href: chatSessionPath(task.contextId),
      scheduleId: null,
      schedulePath: null,
      manual: false,
    };
  }
  // A caller lists only its own sessions, so a chat another owner started is not among them. The
  // task says whether its record holds a session incarnation (`chat`), and then the link comes from
  // the task, as a fire's does. A `catalog` task's `contextId` is a handle no chat has (or a run in
  // a Bureau with no session store), so it links nothing unless the caller lists a session by that id.
  if (chat !== undefined) {
    return { kind: 'chat', title: chat.title ?? '', href: chatSessionPath(chat.id) };
  }
  if (task.kind === 'chat') {
    return { kind: 'chat', title: '', href: chatSessionPath(task.contextId) };
  }
  return { kind: 'none' };
}

/** The workflow type of the schedule tick, which the Bureau starts to record what its scheduler did. */
const SCHEDULE_TICK_TYPE = 'scheduleTick';

/**
 * Whether a workflow type is one an instance of a workflow file (or a plugin's code workflow) runs
 * on, as opposed to one Interborough registers itself for chats, goals and schedules.
 */
function isInstanceWorkflow(type: string): boolean {
  return !isBuiltInWorkflow(type);
}

/** The title of a run a chat, a schedule's fire, or anything else with a session started. */
function taskTitle(
  task: TaskView,
  origin: RunOrigin,
  chats: ReadonlyMap<string, ChatContext>,
  scheduleNames: ReadonlyMap<string, string>,
): string {
  // The Bureau's own runs are named by what they are: the schedule tick, and an instance of a
  // workflow file by its workflow, whatever started it (rows 09p and 09r).
  const type = task.workflow?.type;
  if (type === SCHEDULE_TICK_TYPE) return TASK_COPY.list.scheduleTickTitle;
  if (type !== undefined && isInstanceWorkflow(type)) return workflowTypeName(type);
  if (origin.kind === 'schedule') {
    const named = origin.scheduleId === null ? undefined : scheduleNames.get(origin.scheduleId);
    return named ?? (origin.title === '' ? TASK_COPY.untitledChat : origin.title);
  }
  if (origin.kind === 'chat') return origin.title === '' ? TASK_COPY.untitledChat : origin.title;
  if (origin.kind === 'parent') return TASK_COPY.list.workflowRunTitle;
  // A goal's attempt is titled by its goal, whether or not the goal itself was read.
  if (origin.kind === 'goal') return origin.title;
  return chats.get(task.contextId)?.title ?? TASK_COPY.runTitle;
}

/** A goal's identifier written as a name: lower-case words joined by hyphens or underscores. */
const GOAL_NAME_SHAPED = /^[a-z][a-z0-9_-]*$/;

/**
 * What a goal is called. A goal has no name of its own, so an identifier written as a name reads as
 * words ("summarize-open-refunds" is "Summarize open refunds"), and any other is shown as it is.
 */
export function goalTitle(goalRunId: string): string {
  return GOAL_NAME_SHAPED.test(goalRunId)
    ? humanizeIdentifier(goalRunId, { casing: 'sentence' })
    : goalRunId;
}

/**
 * What a goal is called wherever a page names it (rows 55f, 55h): the name the goal was given, and
 * its identifier (`goalTitle`) only when it has none. The one helper every place that names a read
 * goal uses, so no page says `16e7…-sample-goal-summarize-open-refunds`.
 */
export function goalName(goal: Pick<Goal, 'goalRunId' | 'identity'>): string {
  const name = goal.identity.name.trim();
  return name === '' ? goalTitle(goal.goalRunId) : name;
}

function taskRow(
  task: TaskView,
  chats: ReadonlyMap<string, ChatContext>,
  scheduleNames: ReadonlyMap<string, string>,
): RunRow {
  const startedAt = Date.parse(task.createdAt);
  const updatedAt = Date.parse(task.updatedAt);
  const summary =
    task.status === 'input-required'
      ? waitSummary(task)
      : task.status === 'failed' || task.status === 'canceled'
        ? (task.statusMessage ?? task.finishReason ?? '')
        : '';
  const origin = taskOrigin(task, chats);
  const workflow = task.workflow ?? null;
  const wake =
    task.wakeAt === undefined || task.wakeAt === null ? Number.NaN : Date.parse(task.wakeAt);
  const scheduleId = workflow?.scheduleId ?? null;
  return {
    id: task.id,
    agentName: task.agentName,
    status: task.status,
    origin,
    title: taskTitle(task, origin, chats, scheduleNames),
    summary,
    startedAt,
    updatedAt,
    durationMs: isTerminalState(task.status) ? Math.max(0, updatedAt - startedAt) : null,
    attempt: null,
    checkNotMet: false,
    workflowType: workflow?.type ?? null,
    workflow,
    scheduleName:
      (scheduleId === null ? undefined : scheduleNames.get(scheduleId)) ??
      workflow?.scheduleName ??
      null,
    dueAt: task.status === 'working' && !Number.isNaN(wake) ? wake : null,
    engineRun: isEngineRunTask(task),
  };
}

const ATTEMPT_STATUS = {
  running: 'working',
  evaluating: 'working',
  passed: 'completed',
  failed: 'failed',
  aborted: 'canceled',
} as const satisfies Record<Goal['attempts'][number]['status'], TaskState>;

function goalRows(goal: Goal, chats: ReadonlyMap<string, ChatContext>): RunRow[] {
  return goal.attempts.map((attempt) => {
    const startedAt = Date.parse(attempt.startedAt);
    const completedAt = attempt.completedAt === null ? null : Date.parse(attempt.completedAt);
    // The link comes from the attempt itself: for a principal with operator reach the goals are
    // every owner's, and the sessions listed are only the caller's. `bureau.contexts.get` decides
    // whether the session opens.
    const title = chats.get(attempt.sessionId)?.title ?? '';
    return {
      id: attempt.runId,
      agentName: goal.agentName,
      status: ATTEMPT_STATUS[attempt.status],
      origin: {
        kind: 'goal',
        name: goal.goalRunId,
        title: goalName(goal),
        href: goalPath(goal.goalRunId),
        session:
          attempt.sessionId === '' ? null : { title, href: chatSessionPath(attempt.sessionId) },
      },
      // The goal's own name, as the goals list says it; the identifier only when it has none.
      title: goalName(goal),
      summary: attempt.status === 'passed' ? '' : (attempt.finishReason ?? ''),
      startedAt,
      updatedAt: completedAt ?? startedAt,
      durationMs: completedAt === null ? null : Math.max(0, completedAt - startedAt),
      attempt: {
        number: attempt.attemptIndex + 1,
        of: Math.max(goal.bounds.maximumAttempts, attempt.attemptIndex + 1),
      },
      checkNotMet: false,
      workflowType: 'goalRun',
    };
  });
}

/**
 * How the steps of one workflow instance stand together, as the instance's status: waiting on a
 * person while one step does, going while one is, then failed or canceled when a step was, and
 * done when every step is.
 */
const INSTANCE_STATUS_ORDER: readonly TaskState[] = [
  'input-required',
  'working',
  'submitted',
  'failed',
  'canceled',
  'completed',
];

/** One instance of a workflow file, from the rows of its steps: the run a person started. */
function instanceRow(parentRunId: string, steps: readonly RunRow[]): RunRow {
  const status =
    INSTANCE_STATUS_ORDER.find((state) => steps.some((step) => step.status === state)) ??
    'completed';
  const startedAt = Math.min(...steps.map((step) => step.startedAt));
  const updatedAt = Math.max(...steps.map((step) => step.updatedAt));
  const telling = steps.find((step) => step.status === status && step.summary !== '');
  return {
    id: parentRunId,
    agentName: steps.find((step) => step.agentName !== null)?.agentName ?? null,
    status,
    origin: { kind: 'parent', parentRunId, href: workflowDetailPath(parentRunId) },
    title: TASK_COPY.list.workflowRunTitle,
    summary: telling?.summary ?? '',
    startedAt,
    updatedAt,
    durationMs: isTerminalState(status) ? Math.max(0, updatedAt - startedAt) : null,
    attempt: null,
    checkNotMet: false,
    // No task is the instance, only its steps are: the engine holds the run a person started.
    engineRun: true,
  };
}

/** Every run the two sources hold, the most recently changed first, each run once. */
export function buildRunRows(input: {
  readonly tasks: readonly TaskView[];
  readonly goals: readonly Goal[];
  readonly chats: readonly ChatContext[];
  /** The names of the schedules, by identifier, which title the runs their fires started. */
  readonly scheduleNames?: ReadonlyMap<string, string>;
}): RunRow[] {
  const chats = new Map(input.chats.map((chat) => [chat.id, chat] as const));
  const scheduleNames = input.scheduleNames ?? new Map<string, string>();
  const rows = new Map<string, RunRow>();
  // The attempts that ended without meeting the goal's check: the run finished, the check did not pass.
  const missedCheck = new Set<string>();
  for (const goal of input.goals) {
    for (const attempt of goal.attempts) {
      if (attempt.status === 'failed') missedCheck.add(attempt.runId);
    }
    for (const row of goalRows(goal, chats)) rows.set(row.id, row);
  }
  // A task is the Bureau's own account of a run, so it wins over a goal's view of the same run:
  // its status and times. A goal's attempt is also a task, whose session no caller-listed chat
  // names (Chat lists no goal session), so the goal keeps saying what started it, which session it
  // ran in, and which attempt it was.
  for (const task of input.tasks) {
    const row = taskRow(task, chats, scheduleNames);
    const goalRow = rows.get(task.id);
    rows.set(
      task.id,
      goalRow?.origin.kind === 'goal'
        ? {
            ...row,
            origin: goalRow.origin,
            title: goalRow.title,
            attempt: goalRow.attempt,
            checkNotMet: missedCheck.has(task.id) && row.status === 'completed',
          }
        : row,
    );
  }
  return [...rows.values()].toSorted((left, right) => right.updatedAt - left.updatedAt);
}

/**
 * The rows as Runs lists them: the steps of each workflow instance folded into one row for the
 * instance, which is the run a person started, and every run the most recently started first. A
 * run's place does not change when it finishes, so a row stays where it is while it is watched.
 */
export function runListRows(rows: readonly RunRow[]): RunRow[] {
  const listed = new Map<string, RunRow>();
  const steps = new Map<string, RunRow[]>();
  for (const row of rows) {
    if (row.origin.kind === 'parent') {
      const parentRunId = row.origin.parentRunId;
      steps.set(parentRunId, [...(steps.get(parentRunId) ?? []), row]);
    } else {
      listed.set(row.id, row);
    }
  }
  for (const [parentRunId, instanceSteps] of steps) {
    const instance = listed.get(parentRunId);
    if (instance === undefined) {
      listed.set(parentRunId, instanceRow(parentRunId, instanceSteps));
    } else if (instance.agentName === null) {
      // The engine's record of an instance names no agent; its steps say which one ran them, which
      // its row says after its schedule (row 53l, "Schedule, Inbox triage, Assistant").
      const agentName = instanceSteps.find((step) => step.agentName !== null)?.agentName ?? null;
      if (agentName !== null) listed.set(parentRunId, { ...instance, agentName });
    }
  }
  return [...listed.values()].toSorted(
    (left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id),
  );
}

/** Whether a row holds the words searched for, in its title, its agent or its summary. */
function matchesSearch(
  row: RunRow,
  search: string,
  agentLabelOf: (agentName: string) => string,
): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (needle === '') return true;
  const agent = row.agentName === null ? '' : `${row.agentName} ${agentLabelOf(row.agentName)}`;
  return [row.title, agent, row.summary].some((text) => text.toLocaleLowerCase().includes(needle));
}

/** The rows a filter keeps. The agent is matched by its identifier, and searched by both names. */
export function filterRunRows(
  rows: readonly RunRow[],
  filter: RunFilter,
  agentLabelOf: (agentName: string) => string = (agentName) => agentName,
): RunRow[] {
  return rows.filter(
    (row) =>
      (filter.status === undefined || runSegmentOfRow(row) === filter.status) &&
      (filter.agent === undefined || row.agentName === filter.agent) &&
      (filter.startedBy === undefined || row.origin.kind === filter.startedBy) &&
      (filter.workflow === undefined || row.workflowType === filter.workflow) &&
      (filter.search === undefined || matchesSearch(row, filter.search, agentLabelOf)),
  );
}

/**
 * How many of `rows` each segment holds. Pass the rows every other filter leaves, so each count
 * says what choosing its segment would show; a filter that matches nothing makes every count 0.
 */
export function runSegmentCounts(rows: readonly RunRow[]): Readonly<Record<RunSegment, number>> {
  const counts: Record<RunSegment, number> = {
    all: rows.length,
    waiting: 0,
    signal: 0,
    running: 0,
    done: 0,
    failed: 0,
    canceled: 0,
  };
  for (const row of rows) counts[runSegmentOfRow(row)] += 1;
  return counts;
}

/** Reads the filter out of a query string; a value it does not know is no filter. */
export function parseRunFilter(search: URLSearchParams): RunFilter {
  const status = RUN_STATUS_SEGMENTS.find((segment) => segment === search.get('status'));
  const agent = search.get('agent')?.trim();
  const startedBy = STARTED_BY_KINDS.find((kind) => kind === search.get('startedBy'));
  const workflow = search.get('workflow')?.trim();
  const words = search.get('q')?.trim();
  return {
    ...(status === undefined ? {} : { status }),
    ...(agent === undefined || agent === '' ? {} : { agent }),
    ...(startedBy === undefined ? {} : { startedBy }),
    ...(workflow === undefined || workflow === '' ? {} : { workflow }),
    ...(words === undefined || words === '' ? {} : { search: words }),
  };
}

/** The query string a filter is kept in the address as. */
export function serializeRunFilter(filter: RunFilter): string {
  const params = new URLSearchParams();
  if (filter.status !== undefined) params.set('status', filter.status);
  if (filter.agent !== undefined) params.set('agent', filter.agent);
  if (filter.startedBy !== undefined) params.set('startedBy', filter.startedBy);
  if (filter.workflow !== undefined) params.set('workflow', filter.workflow);
  if (filter.search !== undefined) params.set('q', filter.search);
  return params.toString();
}

/** The word a run's status reads as: one of the seven, or "Check not met" for a goal's attempt. */
export type RunStatusWord = StatusWord | 'Check not met' | 'Waiting';

/** Whether a run that has not ended is parked at an `await-signal` step, waiting for a signal. */
function awaitingSignalOf(
  row: Pick<RunRow, 'status'> & { readonly workflow?: RunWorkflow | null | undefined },
): string | null {
  const going = row.status === 'working' || row.status === 'submitted';
  return going ? (row.workflow?.awaitingSignal ?? null) : null;
}

/**
 * The status word of a row, which Cinder's `StatusDot` gives its one tone. An instance waiting for
 * a signal is "Waiting" (the hollow ring), and a run that asked to be woken is "Scheduled" until it
 * is (`now`, when it is given, is the clock the due time is read against).
 */
export function runStatusWord(
  row: Pick<RunRow, 'status' | 'checkNotMet'> & Partial<Pick<RunRow, 'workflow' | 'dueAt'>>,
  now?: number,
): RunStatusWord {
  if (row.checkNotMet) return 'Check not met';
  if (awaitingSignalOf({ status: row.status, workflow: row.workflow }) !== null) return 'Waiting';
  if (
    row.status === 'working' &&
    row.dueAt !== undefined &&
    row.dueAt !== null &&
    row.dueAt > (now ?? Date.now())
  ) {
    return 'Scheduled';
  }
  return taskStatusWord(row.status);
}

/** Whether a row is running now: going, and neither waiting for a signal nor asleep until it is due. */
export function isRunRowRunning(row: RunRow, now: number): boolean {
  return (
    (row.status === 'working' || row.status === 'submitted') &&
    runStatusWord(row, now) === 'Running'
  );
}

/** A due time as a sentence reads it: "today at 11:00 AM", "tomorrow at 9:00 AM", "Friday, Oct 30 at 9:00 AM". */
export function dueWords(at: number, now: number, zone: string): string {
  const copy = TASK_COPY.list;
  const days = calendarDay(at, zone) - calendarDay(now, zone);
  const day = days === 0 ? copy.due.today : days === 1 ? copy.due.tomorrow : dateLine(at, zone);
  return copy.dueAtTime(day, clockTime(at, zone));
}

/** How long a run took or has run, in the words of line two: "8 s", "3 min 12 s", "1 h 4 min". */
export function durationWords(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(rest)} s`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(restMinutes)} min`;
}

/** How long a run has waited on a person: seconds under a minute, then minutes, then hours. */
export function waitedWords(milliseconds: number): string {
  if (milliseconds < 60_000) return `${String(Math.max(0, Math.floor(milliseconds / 1000)))} s`;
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${String(minutes)} min`;
  return `${String(Math.max(1, Math.floor(milliseconds / 3_600_000)))} h`;
}

/** What line two needs besides the row: the clock, the zone, and the name each agent goes by. */
export type RunLineContext = {
  /** The clock the waits and the running durations are counted to, in epoch milliseconds. */
  readonly now: number;
  /** The IANA zone the times are written in. */
  readonly zone: string;
  /** The name an agent goes by, from its identifier. */
  readonly agentLabel: (agentName: string) => string;
  /**
   * The title of a plugin, from its identifier, or `undefined` when none is loaded (COR-2171): a
   * run a trigger started names its plugin ("GitHub"). Left out, the identifier is said.
   */
  readonly pluginTitle?: (plugin: string) => string | undefined;
  /**
   * When a schedule runs, as a clause in the viewer's time ("every day at 3:00 AM"), by its
   * identifier, or `undefined` when the schedule was not read (row 53l).
   */
  readonly scheduleCadence?: (scheduleId: string) => string | undefined;
  /**
   * The rows are listed on their own workflow's page (the Runs tab), which already names the
   * workflow and its schedule: an instance a schedule fired says the schedule's cadence after its
   * agent rather than the schedule's name ("Schedule, Assistant, every day at 8:00 AM, 41 s", row
   * 63p), and one a person started reads "Workflow, You" (row 63o). A failed one still names its
   * schedule, where and why it failed (row 62n).
   */
  readonly withinWorkflow?: boolean;
};

/**
 * Line two of a run's row: the kind of run, the agent, which attempt it was, and how it went, each
 * part joined by a comma. "Chat, Tool runner, waiting 4 min"; "Goal, Tool runner, attempt 2 of 5,
 * canceled at 10:08 AM after 1 min 12 s" (a cancel records no one who canceled it, so it says the
 * time only); "Chat, Assistant, 8 s". A running row's duration and a waiting row's wait follow `now`.
 */
export function runLineTwo(row: RunRow, context: RunLineContext): string {
  const copy = TASK_COPY.list;
  const workflow = row.workflow ?? null;
  const tick = workflow?.tick ?? null;
  // An instance of a workflow file names the schedule that fired it, when one did, and then the
  // agent its steps ran as: "Schedule, Inbox triage, Assistant" (row 53l).
  const instance =
    workflow !== null && workflow.type !== SCHEDULE_TICK_TYPE && isInstanceWorkflow(workflow.type);
  // A run with no agent names who started it: the trigger's plugin by its title (COR-2171), and by
  // its identifier only when no title is loaded; never "An agent". Interborough's own bookkeeping
  // says "Interborough started" only of a tick it recorded after a restart, which is when that is
  // true (row 53l); any other is said by what it did.
  const agent =
    row.origin.kind === 'system'
      ? tick?.whileStopped === true
        ? copy.interboroughStarted
        : null
      : instance
        ? // A failed instance gives the room to where and why it failed (rows 09r, 52i: "Schedule,
          // Release notes digest, failed at step 2 of 4, …"); any other names its agent (53l).
          row.agentName === null || row.status === 'failed'
          ? null
          : context.agentLabel(row.agentName)
        : row.agentName !== null
          ? context.agentLabel(row.agentName)
          : row.origin.kind === 'trigger' && row.origin.plugin !== null
            ? (context.pluginTitle?.(row.origin.plugin) ?? row.origin.plugin)
            : TASK_COPY.unknownAgent;
  // On its own workflow's page an instance reads by who started it and when its schedule runs,
  // which that page does not already say (rows 63o, 63p); a failed one keeps its schedule's name.
  const onItsPage = context.withinWorkflow === true && instance;
  const byYou = onItsPage && row.origin.kind === 'person';
  // A run of a workflow file that nothing recorded an origin for is still a workflow's, and so is
  // one a person started from its own page.
  const kind =
    (instance && row.origin.kind === 'none') || byYou
      ? copy.kinds.parent
      : copy.kinds[row.origin.kind];
  const parts: string[] = [kind];
  const namesSchedule = !onItsPage || row.status === 'failed';
  if (instance && namesSchedule && row.scheduleName !== null && row.scheduleName !== undefined) {
    parts.push(row.scheduleName);
  }
  if (byYou) parts.push(copy.you);
  else if (agent !== null) parts.push(agent);
  // A schedule's chat run says when its schedule runs, after the agent: "Schedule, Assistant,
  // every day at 3:00 AM, 14 s" (row 53l), and so does an instance on its own workflow's page.
  const scheduleId =
    row.origin.kind === 'schedule' ? (row.origin.scheduleId ?? workflow?.scheduleId ?? null) : null;
  const cadence =
    (!instance || (onItsPage && !namesSchedule)) && scheduleId !== null
      ? context.scheduleCadence?.(scheduleId)
      : undefined;
  if (cadence !== undefined && cadence !== '') parts.push(cadence);
  if (row.attempt !== null) parts.push(copy.attempt(row.attempt.number, row.attempt.of));
  if (tick !== null) {
    parts.push(
      tick.event === 'missed-runs'
        ? copy.tick.missed(tick.missedRuns ?? 0)
        : copy.tick.cameDue(row.scheduleName ?? workflow?.scheduleName ?? null),
    );
  }
  const steps = instance ? workflow?.steps : null;
  const reached = steps?.at ?? null;
  const took = durationWords(row.updatedAt - row.startedAt);
  const awaiting = awaitingSignalOf(row);
  switch (row.status) {
    case 'input-required':
      parts.push(copy.waitingFor(waitedWords(context.now - row.updatedAt)));
      break;
    case 'submitted':
    case 'working':
      // Only a run that is running says its step (10h: "step 2 of 4, running 1 min 12 s"); one
      // waiting for a signal or for its time says what it waits for and nothing of its step. On its
      // own workflow's page, a run parked on a signal says how far it got after what it waits for:
      // "waiting for the signal notes-approved, step 4 of 4" (row 63o).
      if (awaiting !== null) {
        parts.push(copy.waitingForSignal(awaiting));
        if (onItsPage && steps !== null && steps !== undefined && reached !== null) {
          parts.push(copy.stepOf(reached, steps.total));
        }
      } else if (runStatusWord(row, context.now) === 'Scheduled' && row.dueAt != null) {
        parts.push(copy.dueAt(dueWords(row.dueAt, context.now, context.zone)));
      } else {
        if (steps !== null && steps !== undefined && reached !== null) {
          parts.push(copy.stepOf(reached, steps.total));
        }
        parts.push(copy.runningFor(durationWords(context.now - row.startedAt)));
      }
      break;
    case 'canceled':
      parts.push(copy.canceledAt(clockTime(row.updatedAt, context.zone), took));
      break;
    case 'failed':
      if (steps !== null && steps !== undefined && reached !== null) {
        parts.push(copy.failedAtStep(reached, steps.total));
      }
      // What the run said, never the error's own JSON: "GitHub didn’t answer (HTTP 503)".
      if (row.summary !== '') {
        const said = oneLine(row.summary, { keepParenthetical: true });
        if (said !== '') parts.push(reasonClause(said));
      }
      parts.push(took);
      break;
    case 'completed':
      parts.push(took);
      break;
  }
  return parts.join(copy.separator);
}

/**
 * The day band an instant is listed under, as a `DataList` group: "Today, Monday, Nov 2",
 * "Yesterday, Sunday, Nov 1", then the day alone ("Friday, Oct 30"), each naming the zone its times
 * are in at the right ("Central time").
 */
export function runDayGroup(at: number, now: number, zone: string): DataListGroup {
  const copy = TASK_COPY.list;
  const detail = zoneLabel(now, zone);
  const days = calendarDay(now, zone) - calendarDay(at, zone);
  if (days <= 0) {
    return { key: 'today', label: `${copy.today}${copy.separator}${dateLine(now, zone)}`, detail };
  }
  if (days === 1) {
    return {
      key: 'yesterday',
      label: `${copy.yesterday}${copy.separator}${dateLine(at, zone)}`,
      detail,
    };
  }
  return { key: `day-${String(calendarDay(at, zone))}`, label: dateLine(at, zone), detail };
}

/** How many runs one page of the list shows, and how many more Load more adds. */
export const RUN_PAGE_SIZE = 10;

/** One entry of the list: a run, or the runs one schedule missed, collapsed into one row. */
export type RunListEntry =
  | { readonly kind: 'run'; readonly key: string; readonly at: number; readonly row: RunRow }
  | {
      readonly kind: 'missed';
      readonly key: string;
      readonly at: number;
      readonly missed: MissedRuns;
    };

/**
 * What the list draws: the first `shown` runs, newest first, and each schedule's missed runs as one
 * row at the time they were logged, after the runs that started at that time. A missed row older
 * than the last run shown waits for the page that reaches it. Only runs count towards `shown`.
 */
export function runListEntries(
  rows: readonly RunRow[],
  missed: readonly MissedRuns[],
  shown: number,
): RunListEntry[] {
  const page = rows.slice(0, shown);
  const oldest = page.at(-1)?.startedAt;
  const more = rows.length > page.length;
  const entries: RunListEntry[] = [
    ...page.map((row) => ({ kind: 'run' as const, key: `run:${row.id}`, at: row.startedAt, row })),
    ...missed
      .filter((one) => !more || oldest === undefined || one.loggedAt >= oldest)
      .map((one) => ({
        kind: 'missed' as const,
        key: `missed:${one.scheduleId}`,
        at: one.loggedAt,
        missed: one,
      })),
  ];
  return entries.toSorted(
    (left, right) =>
      right.at - left.at || (left.kind === right.kind ? 0 : left.kind === 'run' ? -1 : 1),
  );
}

/** The most characters an agent's name takes in the Agent filter, in its list and in its chip. */
export const FILTER_LABEL_LIMIT = 28;

/**
 * An agent's name as the Agent filter shows it. The filter is a native select, as wide as its longest
 * option, and its applied chip does not wrap, so a 64-character name widened the page past a phone's
 * screen (COR-1862). A name past {@link FILTER_LABEL_LIMIT} keeps its start and its end around an
 * ellipsis, because agents of one family differ at the end. The address still holds the whole name.
 */
export function filterLabelOf(name: string): string {
  const letters = Array.from(name);
  if (letters.length <= FILTER_LABEL_LIMIT) return name;
  const head = Math.ceil((FILTER_LABEL_LIMIT - 1) / 2);
  const tail = FILTER_LABEL_LIMIT - 1 - head;
  return `${letters.slice(0, head).join('')}…${letters.slice(letters.length - tail).join('')}`;
}
