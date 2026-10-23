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
 *   person, so it never counts. Opening the chat reads it, including one that finishes while the
 *   chat is open.
 *
 * A chat is one item: of the reviews waiting in it, the one waiting longest stands for them all
 * (an approval before a question when they asked at the same moment), a pending review wins over a
 * failure, a failure over an answer, and the latest run of a chat stands for all its earlier ones.
 * A run whose chat the Bureau does not list is not a chat to open, so it is not an item. The items
 * are derived, not accumulated, so a decision made anywhere removes the item at the next read, and
 * a review the Bureau asks again (an approval's next round) is a new item.
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
  /**
   * Stable across reads, so a read item stays read: `review:<id>` (`review:<id>:<round>` for an
   * approval, which the Bureau asks again under the same id when a round supersedes it),
   * `task:<id>`, or `engine-status`.
   */
  readonly id: string;
  readonly kind: NotificationKind;
  readonly tier: NotificationTier;
  /** The Lucide icon the row shows, by name. */
  readonly icon: string;
  /** The sentence: who needs the person, or what happened. */
  readonly title: string;
  /** The parts of the title that are identifiers (an agent's name), which are set in monospace. */
  readonly identifiers: readonly string[];
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

/** What a schedule is called, and whether that is an identifier (an agent's name) rather than prose (its description). */
export interface ScheduleName {
  readonly name: string;
  readonly identifier: boolean;
}

export interface NotificationSources {
  /** The Bureau's pending reviews. */
  readonly reviews: readonly BureauReview[];
  /** The Bureau's most recently changed tasks. */
  readonly tasks: readonly TaskView[];
  /**
   * The chats the Bureau lists, by session, with the title of each (`null` for a chat that has
   * none, which is called by the words for an untitled chat). The listing is the most recently
   * changed chats, which is where a recent run's chat is.
   */
  readonly chats: ReadonlyMap<string, string | null>;
  /** The schedule's name by the id of a task it started, for the tasks it started that failed. */
  readonly scheduleNames: ReadonlyMap<string, ScheduleName>;
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

function chatTitle(
  chats: ReadonlyMap<string, string | null>,
  sessionId: string | undefined,
): string {
  return (sessionId === undefined ? null : chats.get(sessionId)) ?? CHAT_COPY.untitled;
}

function reviewEntry(
  review: BureauReview,
  chats: ReadonlyMap<string, string | null>,
): NotificationEntry {
  const sessionId = review.sessionId;
  const approval = review.kind === 'tool-approval';
  const agent = agentOf(review.agentName);
  return {
    // A superseded approval comes back under the same review id with a higher round, and it is a
    // new question for the person, so the round is part of what was read.
    id:
      review.kind === 'tool-approval'
        ? `review:${review.id}:${review.round}`
        : `review:${review.id}`,
    kind: approval ? 'approval' : 'question',
    tier: 'warning',
    icon: approval ? 'shield-question-mark' : 'message-circle-question-mark',
    title: approval
      ? NOTIFICATION_COPY.needsApproval(agent)
      : NOTIFICATION_COPY.askedQuestion(agent),
    identifiers: review.agentName === undefined ? [] : [review.agentName],
    detail: chatTitle(chats, sessionId),
    joiner: NOTIFICATION_COPY.inJoiner,
    ...(sessionId === undefined ? {} : { sessionId }),
    href: sessionId === undefined ? '/reviews' : chatSessionPath(sessionId),
    emittedAtMs: review.requestedAt,
  };
}

function taskEntry(
  task: TaskView,
  chats: ReadonlyMap<string, string | null>,
  scheduleNames: ReadonlyMap<string, ScheduleName>,
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
      identifiers: task.agentName === null ? [] : [task.agentName],
      detail: chatTitle(chats, task.contextId),
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
      title: NOTIFICATION_COPY.failed(schedule.name),
      identifiers: schedule.identifier ? [schedule.name] : [],
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
    identifiers: task.agentName === null ? [] : [task.agentName],
    detail: chatTitle(chats, task.contextId),
    joiner: NOTIFICATION_COPY.inJoiner,
  };
}

/** Whether a task ended with a result the person wants to hear about. */
function isNews(task: TaskView): boolean {
  return task.status === 'completed' || task.status === 'failed';
}

/**
 * The review that stands for a chat that is waiting on the person: the one waiting longest, and an
 * approval before a question when they asked at the same moment. The id breaks any tie left, so
 * the choice does not move between reads.
 */
function standsForChat(left: BureauReview, right: BureauReview): number {
  return (
    left.requestedAt - right.requestedAt ||
    Number(right.kind === 'tool-approval') - Number(left.kind === 'tool-approval') ||
    left.id.localeCompare(right.id)
  );
}

/** One review per chat: reviews that belong to no chat (a run with no session) each stand alone. */
function onePerChat(pending: readonly BureauReview[]): BureauReview[] {
  const byChat = new Map<string, BureauReview>();
  const alone: BureauReview[] = [];
  for (const review of pending) {
    if (review.sessionId === undefined) {
      alone.push(review);
      continue;
    }
    const standing = byChat.get(review.sessionId);
    if (standing === undefined || standsForChat(review, standing) < 0) {
      byChat.set(review.sessionId, review);
    }
  }
  return [...byChat.values(), ...alone];
}

/**
 * The items for `sources`, newest first within each group: what needs the person (approvals,
 * questions, failures) before what only finished.
 */
export function buildNotificationEntries(sources: NotificationSources): NotificationEntry[] {
  const { reviews, tasks, chats, scheduleNames, nowMs } = sources;
  const pending = reviews.filter((review) => review.status === 'pending');
  const entries: NotificationEntry[] = onePerChat(pending).map((review) =>
    reviewEntry(review, chats),
  );
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
    // A run started without a chat (`bureau.run()` from the catalog) names a context the Bureau
    // does not hold, and there is no chat to open for it.
    if (!chats.has(task.contextId)) continue;
    entries.push(taskEntry(task, chats, scheduleNames));
  }

  const needsPerson = (entry: NotificationEntry) => entry.tier !== 'info';
  return entries.sort(
    (left, right) =>
      Number(needsPerson(right)) - Number(needsPerson(left)) ||
      right.emittedAtMs - left.emittedAtMs,
  );
}
