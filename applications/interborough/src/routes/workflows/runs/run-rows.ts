/**
 * The rows of `/runs`: one list of what the agents have done, in the words of a task. Two sources
 * are joined. The Bureau's tasks (`bureau.tasks.list`) are the runs of chats and of anything started
 * with `bureau.run()`; a goal's attempts are runs too, but the Bureau does not make them tasks, so
 * they come from `bureau.goals.list`. Each row says which agent ran, what started it (a chat the
 * Bureau still has, a goal, a schedule's fire, or nothing it can name), how it stands, and when.
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
import { chatSessionPath } from '../../../lib/identifier-paths.ts';

export type RunOrigin =
  | { readonly kind: 'chat'; readonly title: string; readonly href: string }
  /** A goal's attempt: the goal, and the session the attempt ran in while the Bureau still has it. */
  | {
      readonly kind: 'goal';
      readonly name: string;
      readonly href: string;
      readonly session: { readonly title: string; readonly href: string } | null;
    }
  /**
   * A schedule's fire (the task's own `actor`, not the session's origin, which a fire that
   * continues a chat keeps as `chat`): the session it ran in, named by the text the schedule
   * delivered when the caller lists that session, and empty when it does not (an operator sees
   * every owner's fires and lists only their own sessions).
   */
  | { readonly kind: 'schedule'; readonly title: string; readonly href: string }
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

/** What can start a run, for the filter. */
export type StartedBy = 'chat' | 'goal' | 'schedule';

/** The words for each way a run can start. */
export const STARTED_BY_LABELS: Readonly<Record<StartedBy, string>> = {
  chat: 'A chat',
  goal: 'A goal',
  schedule: 'A schedule',
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

function taskOrigin(task: TaskView, chat: ChatContext | undefined): RunOrigin {
  // The task says what started it. A schedule may continue a chat session, which keeps its `chat`
  // origin, so the session cannot be asked.
  // A fire always runs in a session, and its link comes from the task: the caller-owned sessions
  // listed are only a source of the title. `bureau.contexts.get` decides whether it opens.
  if (isScheduleFire(task)) {
    return {
      kind: 'schedule',
      title: chat?.title ?? '',
      href: chatSessionPath(task.contextId),
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
  const chat = chats.get(task.contextId);
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
    origin: taskOrigin(task, chat),
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
        href: '/goals',
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
  // A task is the Bureau's own account of a run, so it wins over a goal's view of the same run.
  for (const task of input.tasks) rows.set(task.id, taskRow(task, chats));
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
  const startedBy = search.get('startedBy');
  const since = SINCE_KEYS.find((range) => range === search.get('since'));
  return {
    ...(status === undefined ? {} : { status }),
    ...(agent === undefined || agent === '' ? {} : { agent }),
    ...(startedBy === 'chat' || startedBy === 'goal' || startedBy === 'schedule'
      ? { startedBy }
      : {}),
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
