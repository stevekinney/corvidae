/**
 * The rows of `/runs`: one list of what the agents have done, in the words of a task. Two sources
 * are joined. The Bureau's tasks (`bureau.tasks.list`) are the runs of chats and of anything started
 * with `bureau.run()`; a goal's attempts are runs too, but the Bureau does not make them tasks, so
 * they come from `bureau.goals.list`. Each row says which agent ran, what started it (a chat the
 * Bureau still has, a goal, or nothing it can name), how it stands, and when.
 *
 * A schedule's fire is not here: the Bureau records no link from a run to the schedule that
 * started it, so a run a schedule started is listed without its origin.
 */
import { TASK_COPY } from '../../../app/copy.ts';
import type { ChatContext } from '../../../lib/bureau-client.ts';
import type { Goal } from '../../../lib/bureau-goals.ts';
import { isTerminalState, type TaskState, type TaskView } from '../../../lib/bureau-tasks.ts';
import { shorten } from '../../../lib/tool-text.ts';

export type RunOrigin =
  | { readonly kind: 'chat'; readonly title: string; readonly href: string }
  | { readonly kind: 'goal'; readonly name: string; readonly href: string }
  | { readonly kind: 'none' };

export type RunRow = {
  readonly id: string;
  readonly agentName: string | null;
  readonly status: TaskState;
  readonly origin: RunOrigin;
  /** One line about how it stands: the question it waits on, its last words, or why it failed. */
  readonly summary: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** How long it took, once it is over. */
  readonly durationMs: number | null;
};

/** What can start a run, for the filter. */
export type StartedBy = 'chat' | 'goal';

/** The words for each way a run can start. */
export const STARTED_BY_LABELS: Readonly<Record<StartedBy, string>> = {
  chat: 'A chat',
  goal: 'A goal',
};

/** The ranges of time the list can be narrowed to, in milliseconds. */
export const SINCE_RANGES = {
  '1h': { label: 'Last hour', milliseconds: 3_600_000 },
  '24h': { label: 'Last 24 hours', milliseconds: 86_400_000 },
  '7d': { label: 'Last 7 days', milliseconds: 604_800_000 },
} as const;

export type SinceRange = keyof typeof SINCE_RANGES;

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

function taskRow(task: TaskView, chats: ReadonlyMap<string, ChatContext>): RunRow {
  const chat = chats.get(task.contextId);
  const startedAt = Date.parse(task.createdAt);
  const updatedAt = Date.parse(task.updatedAt);
  const summary =
    task.status === 'input-required'
      ? waitSummary(task)
      : task.status === 'failed' || task.status === 'canceled'
        ? (task.statusMessage ?? task.finishReason ?? '')
        : shorten(chat?.lastMessagePreview ?? '');
  return {
    id: task.id,
    agentName: task.agentName,
    status: task.status,
    origin:
      chat === undefined
        ? { kind: 'none' }
        : {
            kind: 'chat',
            title: chat.title ?? '',
            href: `/chat/${encodeURIComponent(chat.id)}`,
          },
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

function goalRows(goal: Goal): RunRow[] {
  return goal.attempts.map((attempt) => {
    const startedAt = Date.parse(attempt.startedAt);
    const completedAt = attempt.completedAt === null ? null : Date.parse(attempt.completedAt);
    return {
      id: attempt.runId,
      agentName: goal.agentName,
      status: ATTEMPT_STATUS[attempt.status],
      origin: { kind: 'goal', name: goal.goalRunId, href: '/goals' },
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
  for (const goal of input.goals) for (const row of goalRows(goal)) rows.set(row.id, row);
  // A task is the Bureau's own account of a run, so it wins over a goal's view of the same run.
  for (const task of input.tasks) rows.set(task.id, taskRow(task, chats));
  return [...rows.values()].toSorted((left, right) => right.updatedAt - left.updatedAt);
}

/** The rows a filter keeps. `now` is passed in so a range is the same for every row. */
export function filterRunRows(rows: readonly RunRow[], filter: RunFilter, now: number): RunRow[] {
  const earliest = filter.since === undefined ? undefined : now - SINCE_RANGES[filter.since].milliseconds;
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
  const since = search.get('since');
  return {
    ...(status === undefined ? {} : { status }),
    ...(agent === undefined || agent === '' ? {} : { agent }),
    ...(startedBy === 'chat' || startedBy === 'goal' ? { startedBy } : {}),
    ...(since !== null && since in SINCE_RANGES ? { since: since as SinceRange } : {}),
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
