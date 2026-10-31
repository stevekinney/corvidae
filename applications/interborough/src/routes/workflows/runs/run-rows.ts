/**
 * The rows of `/runs`: one list of what the agents have done, in the words of a task. Two sources
 * are joined. The Bureau's tasks (`bureau.tasks.list`) are the runs of chats, of goal attempts and
 * workflow steps, and of anything started with `bureau.run()`; the goals (`bureau.goals.list`) add
 * the attempts recorded before attempts were tasks, and name the session an attempt ran in. Each
 * row says which agent ran, what started it, how it stands, and when. What started a run is the
 * origin the Bureau recorded on its task (COR-1867): a chat, a person, a schedule's fire, the API,
 * an agent, a goal, or a workflow. Only a task recorded before origins were kept has none, and
 * then it is read from the task's own `actor` and `kind`, as it always was.
 *
 * A run's session is not listed on `/chats` when a goal or a schedule's fire started it (the
 * session's `origin`), so this list is where it is reached: a goal's row and a fire's row each link
 * to the session the run ran in.
 */
import { TASK_COPY } from '../../../app/copy.ts';
import type { ChatContext } from '../../../lib/bureau-client.ts';
import type { Goal } from '../../../lib/bureau-goals.ts';
import {
  isScheduleFire,
  isTerminalState,
  type TaskState,
  type TaskView,
} from '../../../lib/bureau-tasks.ts';
import { chatSessionPath, goalPath } from '../../../lib/identifier-paths.ts';
import { scheduleDetailPath, workflowDetailPath } from '../../../lib/router.svelte.ts';
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
  /** A goal's attempt: the goal, and the session the attempt ran in while the Bureau still has it. */
  | {
      readonly kind: 'goal';
      readonly name: string;
      readonly href: string;
      readonly session: { readonly title: string; readonly href: string } | null;
    }
  /** A step of a workflow instance. */
  | { readonly kind: 'parent'; readonly parentRunId: string; readonly href: string }
  /** A task recorded before origins were kept, which nothing else names. */
  | { readonly kind: 'none' };

export type RunRow = {
  readonly id: string;
  readonly agentName: string | null;
  readonly status: TaskState;
  readonly origin: RunOrigin;
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
};

/** The ranges of time the list can be narrowed to, in milliseconds. */
export const SINCE_RANGES = {
  '1h': { label: 'Last hour', milliseconds: 3_600_000 },
  '24h': { label: 'Last 24 hours', milliseconds: 86_400_000 },
  '7d': { label: 'Last 7 days', milliseconds: 604_800_000 },
} as const;

export type SinceRange = keyof typeof SINCE_RANGES;

const SINCE_KEYS: readonly SinceRange[] = ['1h', '24h', '7d'];

export type RunFilter = {
  readonly status?: TaskState;
  readonly agent?: string;
  readonly startedBy?: StartedBy;
  readonly since?: SinceRange;
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

function taskRow(task: TaskView, chats: ReadonlyMap<string, ChatContext>): RunRow {
  const startedAt = Date.parse(task.createdAt);
  const updatedAt = Date.parse(task.updatedAt);
  const summary =
    task.status === 'input-required'
      ? waitSummary(task)
      : task.status === 'failed' || task.status === 'canceled'
        ? (task.statusMessage ?? task.finishReason ?? '')
        : '';
  return {
    id: task.id,
    agentName: task.agentName,
    status: task.status,
    origin: taskOrigin(task, chats),
    summary,
    startedAt,
    updatedAt,
    durationMs: isTerminalState(task.status) ? Math.max(0, updatedAt - startedAt) : null,
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
      summary: attempt.status === 'passed' ? '' : (attempt.finishReason ?? ''),
      startedAt,
      updatedAt: completedAt ?? startedAt,
      durationMs: completedAt === null ? null : Math.max(0, completedAt - startedAt),
    };
  });
}

/** Every run the two sources hold, the most recently changed first, each run once. */
export function buildRunRows(input: {
  readonly tasks: readonly TaskView[];
  readonly goals: readonly Goal[];
  readonly chats: readonly ChatContext[];
}): RunRow[] {
  const chats = new Map(input.chats.map((chat) => [chat.id, chat] as const));
  const rows = new Map<string, RunRow>();
  for (const goal of input.goals) for (const row of goalRows(goal, chats)) rows.set(row.id, row);
  // A task is the Bureau's own account of a run, so it wins over a goal's view of the same run:
  // its status and times. A goal's attempt is also a task, whose session no caller-listed chat
  // names (Chat lists no goal session), so the goal keeps saying what started it and which session
  // it ran in.
  for (const task of input.tasks) {
    const row = taskRow(task, chats);
    const goalOrigin = rows.get(task.id)?.origin;
    rows.set(task.id, goalOrigin?.kind === 'goal' ? { ...row, origin: goalOrigin } : row);
  }
  return [...rows.values()].toSorted((left, right) => right.updatedAt - left.updatedAt);
}

/** The rows a filter keeps. `now` is passed in so a range is the same for every row. */
export function filterRunRows(rows: readonly RunRow[], filter: RunFilter, now: number): RunRow[] {
  const earliest =
    filter.since === undefined ? undefined : now - SINCE_RANGES[filter.since].milliseconds;
  return rows.filter(
    (row) =>
      (filter.status === undefined ||
        row.status === filter.status ||
        (filter.status === 'working' && row.status === 'submitted')) &&
      (filter.agent === undefined || row.agentName === filter.agent) &&
      (filter.startedBy === undefined || row.origin.kind === filter.startedBy) &&
      (earliest === undefined || row.startedAt >= earliest),
  );
}

const STATUSES: readonly TaskState[] = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
];

/** Reads the filter out of a query string; a value it does not know is no filter. */
export function parseRunFilter(search: URLSearchParams): RunFilter {
  const status = STATUSES.find((state) => state === search.get('status'));
  const agent = search.get('agent')?.trim();
  const startedBy = STARTED_BY_KINDS.find((kind) => kind === search.get('startedBy'));
  const since = SINCE_KEYS.find((range) => range === search.get('since'));
  return {
    ...(status === undefined ? {} : { status }),
    ...(agent === undefined || agent === '' ? {} : { agent }),
    ...(startedBy === undefined ? {} : { startedBy }),
    ...(since === undefined ? {} : { since }),
  };
}

/** The query string a filter is kept in the address as. */
export function serializeRunFilter(filter: RunFilter): string {
  const params = new URLSearchParams();
  if (filter.status !== undefined) params.set('status', filter.status);
  if (filter.agent !== undefined) params.set('agent', filter.agent);
  if (filter.startedBy !== undefined) params.set('startedBy', filter.startedBy);
  if (filter.since !== undefined) params.set('since', filter.since);
  return params.toString();
}
