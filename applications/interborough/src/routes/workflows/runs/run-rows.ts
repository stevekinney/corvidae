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

import { TASK_COPY } from '../../../app/copy.ts';
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
import { scheduleDetailPath, workflowDetailPath } from '../../../lib/router.svelte.ts';
import { taskStatusWord, type StatusWord } from '../../../lib/status.ts';
import type { MissedRuns } from './missed-runs.ts';
import { STARTED_BY_KINDS, type StartedBy } from './started-by.ts';

/** How a person started a run, as the origin records it. */
export type RunPersonSurface = 'web' | 'palette' | 'api';

export type RunOrigin =
  | { readonly kind: 'chat'; readonly title: string; readonly href: string }
  /** A person started it outside a chat, from the surface the origin names. */
  | { readonly kind: 'person'; readonly surface: RunPersonSurface | null }
  /**
   * A schedule's fire. The origin names the schedule (`scheduleId`, and `schedulePath` is its page)
   * and whether a person fired it by hand. A task recorded before origins were kept says it only
   * through its `actor`, and then there is no schedule to name. Either way the fire ran in a
   * session, which is linked (`href`) and titled by the text the schedule delivered when the caller
   * lists that session, and empty when it does not (an operator sees every owner's fires and lists
   * only their own sessions).
   */
  | {
      readonly kind: 'schedule';
      readonly title: string;
      readonly href: string;
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
      readonly name: string;
      readonly href: string;
      readonly session: { readonly title: string; readonly href: string } | null;
    }
  /** A step of a workflow instance, or the instance its steps stand for. */
  | { readonly kind: 'parent'; readonly parentRunId: string; readonly href: string }
  /** Interborough started it for its own bookkeeping, such as the schedule tick (COR-2009). */
  | { readonly kind: 'system' }
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
};

/** The status segments of the filter bar, after All: each holds the runs of one status word. */
export const RUN_STATUS_SEGMENTS = ['waiting', 'running', 'done', 'failed', 'canceled'] as const;

/** One status segment a filter can narrow to. */
export type RunStatusSegment = (typeof RUN_STATUS_SEGMENTS)[number];

/** Every segment the bar draws, All first. */
export const RUN_SEGMENTS = ['all', ...RUN_STATUS_SEGMENTS] as const;

/** One segment of the bar, All included. */
export type RunSegment = (typeof RUN_SEGMENTS)[number];

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

export type RunFilter = {
  readonly status?: RunStatusSegment;
  readonly agent?: string;
  readonly startedBy?: StartedBy;
  /** Words the title, the agent or the summary must hold, whatever their case. */
  readonly search?: string;
};

function waitSummary(task: TaskView): string {
  const wait = task.openWaits[0];
  if (wait === undefined) return '';
  return wait.kind === 'tool-approval' ? TASK_COPY.waiting.approval : TASK_COPY.waiting.answer;
}

/** A field of the recorded origin, when it is a non-empty string. */
function recordedText(origin: object, key: string): string | undefined {
  const value: unknown = Reflect.get(origin, key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const PERSON_SURFACES: readonly RunPersonSurface[] = ['web', 'palette', 'api'];

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
    case 'person': {
      const surface = PERSON_SURFACES.find((one) => one === recordedText(recorded, 'surface'));
      return { kind: 'person', surface: surface ?? null };
    }
    case 'schedule': {
      const scheduleId = recordedText(recorded, 'scheduleId');
      return {
        kind: 'schedule',
        title: chats.get(task.contextId)?.title ?? '',
        href: chatSessionPath(task.contextId),
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
      return { kind: 'goal', name: goalRunId, href: goalPath(goalRunId), session: null };
    }
    case 'parent': {
      const parentRunId = recordedText(recorded, 'parentRunId');
      if (parentRunId === undefined) return undefined;
      return { kind: 'parent', parentRunId, href: workflowDetailPath(parentRunId) };
    }
    case 'system':
      return { kind: 'system' };
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

/** The title of a run a chat, a schedule's fire, or anything else with a session started. */
function taskTitle(
  task: TaskView,
  origin: RunOrigin,
  chats: ReadonlyMap<string, ChatContext>,
  scheduleNames: ReadonlyMap<string, string>,
): string {
  if (origin.kind === 'schedule') {
    const named = origin.scheduleId === null ? undefined : scheduleNames.get(origin.scheduleId);
    return named ?? (origin.title === '' ? TASK_COPY.untitledChat : origin.title);
  }
  if (origin.kind === 'chat') return origin.title === '' ? TASK_COPY.untitledChat : origin.title;
  if (origin.kind === 'parent') return TASK_COPY.list.workflowRunTitle;
  // A goal's attempt is titled by its goal, whether or not the goal itself was read.
  if (origin.kind === 'goal') return goalTitle(origin.name);
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
        href: goalPath(goal.goalRunId),
        session:
          attempt.sessionId === '' ? null : { title, href: chatSessionPath(attempt.sessionId) },
      },
      title: goalTitle(goal.goalRunId),
      summary: attempt.status === 'passed' ? '' : (attempt.finishReason ?? ''),
      startedAt,
      updatedAt: completedAt ?? startedAt,
      durationMs: completedAt === null ? null : Math.max(0, completedAt - startedAt),
      attempt: {
        number: attempt.attemptIndex + 1,
        of: Math.max(goal.bounds.maximumAttempts, attempt.attemptIndex + 1),
      },
      checkNotMet: false,
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
    if (!listed.has(parentRunId)) listed.set(parentRunId, instanceRow(parentRunId, instanceSteps));
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
      (filter.status === undefined || runSegmentOf(row.status) === filter.status) &&
      (filter.agent === undefined || row.agentName === filter.agent) &&
      (filter.startedBy === undefined || row.origin.kind === filter.startedBy) &&
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
    running: 0,
    done: 0,
    failed: 0,
    canceled: 0,
  };
  for (const row of rows) counts[runSegmentOf(row.status)] += 1;
  return counts;
}

/** Reads the filter out of a query string; a value it does not know is no filter. */
export function parseRunFilter(search: URLSearchParams): RunFilter {
  const status = RUN_STATUS_SEGMENTS.find((segment) => segment === search.get('status'));
  const agent = search.get('agent')?.trim();
  const startedBy = STARTED_BY_KINDS.find((kind) => kind === search.get('startedBy'));
  const words = search.get('q')?.trim();
  return {
    ...(status === undefined ? {} : { status }),
    ...(agent === undefined || agent === '' ? {} : { agent }),
    ...(startedBy === undefined ? {} : { startedBy }),
    ...(words === undefined || words === '' ? {} : { search: words }),
  };
}

/** The query string a filter is kept in the address as. */
export function serializeRunFilter(filter: RunFilter): string {
  const params = new URLSearchParams();
  if (filter.status !== undefined) params.set('status', filter.status);
  if (filter.agent !== undefined) params.set('agent', filter.agent);
  if (filter.startedBy !== undefined) params.set('startedBy', filter.startedBy);
  if (filter.search !== undefined) params.set('q', filter.search);
  return params.toString();
}

/** The word a run's status reads as: one of the seven, or "Check not met" for a goal's attempt. */
export type RunStatusWord = StatusWord | 'Check not met';

/** The status word of a row, which Cinder's `StatusDot` gives its one tone. */
export function runStatusWord(row: Pick<RunRow, 'status' | 'checkNotMet'>): RunStatusWord {
  return row.checkNotMet ? 'Check not met' : taskStatusWord(row.status);
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
};

/**
 * Line two of a run's row: the kind of run, the agent, which attempt it was, and how it went, each
 * part joined by a comma. "Chat, Tool runner, waiting 4 min"; "Goal, Tool runner, attempt 2 of 5,
 * canceled at 10:08 AM after 1 min 12 s" (a cancel records no one who canceled it, so it says the
 * time only); "Chat, Assistant, 8 s". A running row's duration and a waiting row's wait follow `now`.
 */
export function runLineTwo(row: RunRow, context: RunLineContext): string {
  const copy = TASK_COPY.list;
  const agent =
    row.origin.kind === 'system'
      ? copy.interboroughStarted
      : row.agentName === null
        ? TASK_COPY.unknownAgent
        : context.agentLabel(row.agentName);
  const parts: string[] = [copy.kinds[row.origin.kind], agent];
  if (row.attempt !== null) parts.push(copy.attempt(row.attempt.number, row.attempt.of));
  const took = durationWords(row.updatedAt - row.startedAt);
  switch (row.status) {
    case 'input-required':
      parts.push(copy.waitingFor(waitedWords(context.now - row.updatedAt)));
      break;
    case 'submitted':
    case 'working':
      parts.push(copy.runningFor(durationWords(context.now - row.startedAt)));
      break;
    case 'canceled':
      parts.push(copy.canceledAt(clockTime(row.updatedAt, context.zone), took));
      break;
    case 'failed':
      if (row.summary !== '') parts.push(row.summary);
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
