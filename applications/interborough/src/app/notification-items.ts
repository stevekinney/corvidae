/**
 * What the notification bell holds, derived from what the Bureau says is waiting on the person
 * and what has finished: four kinds, each one line that names the chat or the schedule and never a
 * run. The engine's own event feed (a run starting, a signal arriving) is not here; it lives on the
 * Engine view's activity feed.
 *
 * - `approval`: a tool the agent wants to run is waiting for a decision (`bureau.reviews.list`).
 * - `question`: the agent asked the person something (`bureau.reviews.list`).
 * - `failed`: a top-level run, or a schedule's fire, failed (`bureau.notifications.list`, COR-1941),
 *   and `budget`: one ended because it exceeded its budget. The Bureau writes both when the run
 *   ends, for the top-level run only, so a run that fans out into children is one item and the
 *   items do not depend on how many tasks a run creates.
 * - `missed`: a schedule did not fire at its time (the host was down or too slow, or the clock
 *   skipped it), the newest miss of each schedule, for a day (`bureau.schedules.missed`).
 * - `notice`: any other notification the Bureau holds for the person, such as one a host wrote.
 * - `answered`: the latest run of a chat finished (`bureau.tasks.list`). It is listed, but nothing is waiting on the
 *   person, so it never counts. Opening the chat reads it, including one that finishes while the
 *   chat is open.
 *
 * Of the reviews waiting in one chat, the one waiting longest stands for them all (an approval
 * before a question when they asked at the same moment), and the latest run of a chat stands for
 * all its earlier answers. A chat that is waiting on the person hides its failures and answers, so
 * it is not listed twice. A failure is one item per notification, which is one per run, so a chat
 * with two failed runs lists both until each is read. The Bureau also writes a
 * `review.waiting` notification for each pending review; the bell does not list it, because the
 * pending review above says the same thing and leaves the list the moment it is decided.
 * A run whose chat the Bureau does not list is not a chat to open, so it is not an item. The items
 * are derived, not accumulated, so a decision made anywhere removes the item at the next read, and
 * a review the Bureau asks again (an approval's next round) is a new item.
 */
import type { BureauNotification } from '../lib/bureau-notifications.ts';
import type { BureauReview } from '../lib/bureau-reviews.ts';
import type { TaskView } from '../lib/bureau-tasks.ts';
import { chatSessionPath } from '../lib/identifier-paths.ts';
import { latestRunByChat } from '../lib/recent-tasks.ts';
import { scheduleDetailPath } from '../lib/router.svelte.ts';
import { CHAT_COPY, NOTIFICATION_COPY } from './copy.ts';
import type { MissedFireSource } from './notification-sources.ts';

/** How the bell grades an item: `info` never counts toward the badge. */
export type NotificationTier = 'critical' | 'warning' | 'info';

export type NotificationKind =
  'approval' | 'question' | 'failed' | 'budget' | 'missed' | 'notice' | 'answered' | 'engine';

/** An item before the store decides whether it was read. */
export interface NotificationEntry {
  /**
   * Stable across reads, so a read item stays read: `review:<id>` (`review:<id>:<round>` for an
   * approval, which the Bureau asks again under the same id when a round supersedes it),
   * `notification:<id>` (the Bureau's own record of it), `task:<id>`, or `engine-status`.
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
  /** The Bureau's identifier of the notification this item is, so reading it can be told to the Bureau. */
  readonly notificationId?: string;
  /** The Bureau already holds the notification as read, from this browser or another. */
  readonly serverRead?: boolean;
}

/** A finished run older than this is history, not news. */
export const RECENT_RUN_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** What a schedule is called, and whether that is an identifier (an agent's name) rather than prose (its description). */
export interface ScheduleName {
  readonly name: string;
  readonly identifier: boolean;
}

export interface NotificationSources {
  /** The Bureau's pending reviews. */
  readonly reviews: readonly BureauReview[];
  /** The Bureau's most recently changed tasks, for the answers. */
  readonly tasks: readonly TaskView[];
  /** The caller's notifications, newest first. */
  readonly notifications: readonly BureauNotification[];
  /**
   * The chats the Bureau lists, by session, with the title of each (`null` for a chat that has
   * none, which is called by the words for an untitled chat). The listing is the most recently
   * changed chats, which is where a recent run's chat is.
   */
  readonly chats: ReadonlyMap<string, string | null>;
  /** A schedule's name by its id, for the notifications that name one. */
  readonly scheduleNames: ReadonlyMap<string, ScheduleName>;
  /** The newest fire each schedule that missed one recorded. */
  readonly missedFires?: readonly MissedFireSource[];
  readonly nowMs: number;
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

function answeredEntry(
  task: TaskView,
  chats: ReadonlyMap<string, string | null>,
): NotificationEntry {
  return {
    id: `task:${task.id}`,
    sessionId: task.contextId,
    href: chatSessionPath(task.contextId),
    emittedAtMs: Date.parse(task.updatedAt),
    kind: 'answered',
    tier: 'info',
    icon: 'message-circle-check',
    title: NOTIFICATION_COPY.answered(agentOf(task.agentName)),
    identifiers: task.agentName === null ? [] : [task.agentName],
    detail: chatTitle(chats, task.contextId),
    joiner: NOTIFICATION_COPY.inJoiner,
  };
}

/**
 * The item for one of the caller's notifications, or `undefined` when the bell does not list it: a
 * `review.waiting` (the pending review is the item), or a failure of a run whose chat the Bureau does
 * not list (a run started without a chat names a context there is nothing to open for).
 */
function notificationEntry(
  notification: BureauNotification,
  chats: ReadonlyMap<string, string | null>,
  scheduleNames: ReadonlyMap<string, ScheduleName>,
): NotificationEntry | undefined {
  if (notification.kind === 'review.waiting') return undefined;
  const subject = notification.subject;
  const base = {
    id: `notification:${notification.id}`,
    notificationId: notification.id,
    serverRead: notification.readAt !== null,
    emittedAtMs: Date.parse(notification.createdAt),
    ...(subject?.contextId === undefined ? {} : { sessionId: subject.contextId }),
  };
  if (notification.kind !== 'run.failed' && notification.kind !== 'run.budget-exceeded') {
    const link = notification.link;
    return {
      ...base,
      kind: 'notice',
      tier: 'warning',
      icon: 'triangle-alert',
      title: notification.title,
      identifiers: [],
      detail: notification.body ?? '',
      joiner: NOTIFICATION_COPY.errorJoiner,
      href: link !== null && link.startsWith('/') ? link : '/',
    };
  }
  const contextId = subject?.contextId;
  if (contextId !== undefined && !chats.has(contextId)) return undefined;
  const budget = notification.kind === 'run.budget-exceeded';
  const schedule =
    subject?.scheduleId === undefined ? undefined : scheduleNames.get(subject.scheduleId);
  const common = {
    ...base,
    kind: budget ? 'budget' : 'failed',
    tier: 'warning',
    icon: 'circle-x',
  } as const;
  const href = contextId === undefined ? '/' : chatSessionPath(contextId);
  if (schedule !== undefined) {
    return {
      ...common,
      title: budget
        ? NOTIFICATION_COPY.budgetExceeded(schedule.name)
        : NOTIFICATION_COPY.failed(schedule.name),
      identifiers: schedule.identifier ? [schedule.name] : [],
      detail: notification.body ?? NOTIFICATION_COPY.noErrorText,
      joiner: NOTIFICATION_COPY.errorJoiner,
      href,
    };
  }
  const agent = subject?.agentName;
  return {
    ...common,
    title: budget
      ? NOTIFICATION_COPY.budgetExceeded(agentOf(agent))
      : NOTIFICATION_COPY.failed(agentOf(agent)),
    identifiers: agent === undefined ? [] : [agent],
    detail: chatTitle(chats, contextId),
    joiner: NOTIFICATION_COPY.inJoiner,
    href,
  };
}

/** The item for the newest fire a schedule missed. */
function missedEntry(source: MissedFireSource): NotificationEntry {
  const { scheduleId, name, missed } = source;
  return {
    // The instant the miss is recorded at is part of what was read: the next miss is news again.
    id: `schedule-missed:${scheduleId}:${String(missed.occurrence)}`,
    kind: 'missed',
    tier: 'warning',
    icon: 'calendar-x',
    title: NOTIFICATION_COPY.missedFire(name.name),
    identifiers: name.identifier ? [name.name] : [],
    detail:
      missed.reason === 'dst-gap' ? NOTIFICATION_COPY.missedClockGap : NOTIFICATION_COPY.missedLate,
    joiner: NOTIFICATION_COPY.errorJoiner,
    href: scheduleDetailPath(scheduleId),
    emittedAtMs: missed.recordedAt,
  };
}

/**
 * Whether a task is an answer the person wants to hear about: a completed run that is not one a
 * parent run, a goal or an agent tool call started, because a child's answer is its parent's to
 * report.
 */
function isNews(task: TaskView): boolean {
  return task.status === 'completed' && !SUBORDINATE_ORIGIN_KINDS.has(task.origin?.kind ?? '');
}

/** The origin kinds of a task that something else started and will report on. */
const SUBORDINATE_ORIGIN_KINDS: ReadonlySet<string> = new Set(['agent', 'goal', 'parent']);

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
  const { reviews, tasks, notifications, chats, scheduleNames, nowMs } = sources;
  const missedFires = sources.missedFires ?? [];
  const pending = reviews.filter((review) => review.status === 'pending');
  const entries: NotificationEntry[] = onePerChat(pending).map((review) =>
    reviewEntry(review, chats),
  );
  const waiting = new Set(
    pending.flatMap((review) => (review.sessionId === undefined ? [] : [review.sessionId])),
  );

  // A notification stays until it is read, and a read one for a day, like a finished run.
  for (const notification of notifications) {
    const contextId = notification.subject?.contextId;
    if (contextId !== undefined && waiting.has(contextId)) continue;
    if (
      notification.readAt !== null &&
      nowMs - Date.parse(notification.readAt) > RECENT_RUN_WINDOW_MS
    ) {
      continue;
    }
    const entry = notificationEntry(notification, chats, scheduleNames);
    if (entry !== undefined) entries.push(entry);
  }

  // A schedule that did not fire is news for a day, like a finished run.
  for (const source of missedFires) {
    if (nowMs - source.missed.recordedAt <= RECENT_RUN_WINDOW_MS) entries.push(missedEntry(source));
  }

  // The latest run of each chat stands for it; a chat that is waiting on the person says so once.
  for (const task of latestRunByChat(tasks).values()) {
    if (!isNews(task) || waiting.has(task.contextId)) continue;
    if (nowMs - Date.parse(task.updatedAt) > RECENT_RUN_WINDOW_MS) continue;
    // A run started without a chat (`bureau.run()` from the catalog) names a context the Bureau
    // does not hold, and there is no chat to open for it.
    if (!chats.has(task.contextId)) continue;
    entries.push(answeredEntry(task, chats));
  }

  const needsPerson = (entry: NotificationEntry) => entry.tier !== 'info';
  return entries.sort(
    (left, right) =>
      Number(needsPerson(right)) - Number(needsPerson(left)) ||
      right.emittedAtMs - left.emittedAtMs,
  );
}
