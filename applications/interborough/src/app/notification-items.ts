/**
 * What the notification bell holds, derived from what the Bureau says is waiting on the person
 * and what has finished: four kinds, each one line that names the chat or the schedule and never a
 * run. The engine's own event feed (a run starting, a signal arriving) is not here; it lives on the
 * Engine view's activity feed.
 *
 * - `approval`: a tool the agent wants to run is waiting for a decision (`bureau.reviews.list`).
 * - `question`: the agent asked the person something (`bureau.reviews.list`).
 * - `failed`: the latest run of a chat, or a schedule's fire, failed (`bureau.tasks.list`).
 * - `answered`: the latest run of a chat finished. It is listed, but nothing is waiting on the
 *   person, so it never counts.
 *
 * A chat is one item: a pending review wins over a failure, a failure over an answer, and the
 * latest run of a chat stands for all its earlier ones. The items are derived, not accumulated, so
 * a decision made anywhere removes the item at the next read.
 */
import type { BureauReview } from '../lib/bureau-reviews.ts';
import type { TaskView } from '../lib/bureau-tasks.ts';
import { chatSessionPath } from '../lib/identifier-paths.ts';
import { CHAT_COPY, NOTIFICATION_COPY } from './copy.ts';

/** How the bell grades an item: `info` never counts toward the badge. */
export type NotificationTier = 'critical' | 'warning' | 'info';

export type NotificationKind = 'approval' | 'question' | 'failed' | 'answered' | 'engine';

/** An item before the store decides whether it was read. */
export interface NotificationEntry {
  /** Stable across reads, so a read item stays read: `review:<id>`, `task:<id>`, or `engine-status`. */
  readonly id: string;
  readonly kind: NotificationKind;
  readonly tier: NotificationTier;
  /** The Lucide icon the row shows, by name. */
  readonly icon: string;
  /** The sentence: who needs the person, or what happened. */
  readonly title: string;
  /** What the sentence is about: the chat's title, or the first line of an error. */
  readonly detail: string;
  /** What reads between title and detail for a screen reader: `' in '`, or `': '`. */
  readonly joiner: string;
  /** The chat the item belongs to, so opening that chat reads it. */
  readonly sessionId?: string;
  /** Deep link path (router-relative). */
  readonly href: string;
  readonly emittedAtMs: number;
}

/** A finished run older than this is history, not news. */
export const RECENT_RUN_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** The longest an error line is shown before it is cut. */
const ERROR_LINE_LIMIT = 120;

export interface NotificationSources {
  /** The Bureau's pending reviews. */
  readonly reviews: readonly BureauReview[];
  /** The Bureau's most recently changed tasks. */
  readonly tasks: readonly TaskView[];
  /** Chat titles by session; a session with no entry is called by the words for an untitled chat. */
  readonly titles: ReadonlyMap<string, string>;
  /** The schedule's name by the id of a task it started, for the tasks it started that failed. */
  readonly scheduleNames: ReadonlyMap<string, string>;
  /** The chat the person has open, whose answers are already in front of them. */
  readonly openSessionId: string | undefined;
  readonly nowMs: number;
}

/** The first non-empty line of an error, cut to a readable length. */
export function firstErrorLine(message: string | null): string | undefined {
  const line = message
    ?.split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '');
  if (line === undefined) return undefined;
  return line.length > ERROR_LINE_LIMIT ? `${line.slice(0, ERROR_LINE_LIMIT - 1)}…` : line;
}

function agentOf(name: string | undefined | null): string {
  return name ?? NOTIFICATION_COPY.unnamedAgent;
}

function reviewEntry(review: BureauReview, titles: ReadonlyMap<string, string>): NotificationEntry {
  const sessionId = review.sessionId;
  const chat =
    sessionId === undefined ? CHAT_COPY.untitled : (titles.get(sessionId) ?? CHAT_COPY.untitled);
  const approval = review.kind === 'tool-approval';
  return {
    id: `review:${review.id}`,
    kind: approval ? 'approval' : 'question',
    tier: 'warning',
    icon: approval ? 'shield-question-mark' : 'message-circle-question-mark',
    title: approval
      ? NOTIFICATION_COPY.needsApproval(agentOf(review.agentName))
      : NOTIFICATION_COPY.askedQuestion(agentOf(review.agentName)),
    detail: chat,
    joiner: NOTIFICATION_COPY.inJoiner,
    ...(sessionId === undefined ? {} : { sessionId }),
    href: sessionId === undefined ? '/reviews' : chatSessionPath(sessionId),
    emittedAtMs: review.requestedAt,
  };
}

function taskEntry(
  task: TaskView,
  titles: ReadonlyMap<string, string>,
  scheduleNames: ReadonlyMap<string, string>,
): NotificationEntry {
  const updatedAtMs = Date.parse(task.updatedAt);
  const href = chatSessionPath(task.contextId);
  const base = { id: `task:${task.id}`, sessionId: task.contextId, href, emittedAtMs: updatedAtMs };
  if (task.status === 'completed') {
    return {
      ...base,
      kind: 'answered',
      tier: 'info',
      icon: 'message-circle-check',
      title: NOTIFICATION_COPY.answered(agentOf(task.agentName)),
      detail: titles.get(task.contextId) ?? CHAT_COPY.untitled,
      joiner: NOTIFICATION_COPY.inJoiner,
    };
  }
  const error = firstErrorLine(task.statusMessage);
  const schedule = scheduleNames.get(task.id);
  if (schedule !== undefined) {
    return {
      ...base,
      kind: 'failed',
      tier: 'warning',
      icon: 'circle-x',
      title: NOTIFICATION_COPY.failed(schedule),
      detail: error ?? NOTIFICATION_COPY.noErrorText,
      joiner: NOTIFICATION_COPY.errorJoiner,
    };
  }
  return {
    ...base,
    kind: 'failed',
    tier: 'warning',
    icon: 'circle-x',
    title: NOTIFICATION_COPY.failed(agentOf(task.agentName)),
    detail: titles.get(task.contextId) ?? CHAT_COPY.untitled,
    joiner: NOTIFICATION_COPY.inJoiner,
  };
}

/** Whether a task ended with a result the person wants to hear about. */
function isNews(task: TaskView): boolean {
  return task.status === 'completed' || task.status === 'failed';
}

/**
 * The items for `sources`, newest first within each group: what needs the person (approvals,
 * questions, failures) before what only finished.
 */
export function buildNotificationEntries(sources: NotificationSources): NotificationEntry[] {
  const { reviews, tasks, titles, scheduleNames, openSessionId, nowMs } = sources;
  const pending = reviews.filter((review) => review.status === 'pending');
  const entries: NotificationEntry[] = pending.map((review) => reviewEntry(review, titles));
  const waiting = new Set(
    pending.flatMap((review) => (review.sessionId === undefined ? [] : [review.sessionId])),
  );

  // The latest run of each chat stands for it; a chat that is waiting on the person says so once.
  const latest = new Map<string, TaskView>();
  for (const task of tasks) {
    const seen = latest.get(task.contextId);
    if (seen === undefined || Date.parse(task.updatedAt) > Date.parse(seen.updatedAt)) {
      latest.set(task.contextId, task);
    }
  }
  for (const task of latest.values()) {
    if (!isNews(task) || waiting.has(task.contextId)) continue;
    if (nowMs - Date.parse(task.updatedAt) > RECENT_RUN_WINDOW_MS) continue;
    // A finished answer is not news in the chat the person is already looking at.
    if (task.status === 'completed' && task.contextId === openSessionId) continue;
    entries.push(taskEntry(task, titles, scheduleNames));
  }

  const needsPerson = (entry: NotificationEntry) => entry.tier !== 'info';
  return entries.sort(
    (left, right) =>
      Number(needsPerson(right)) - Number(needsPerson(left)) ||
      right.emittedAtMs - left.emittedAtMs,
  );
}
