/**
 * What the notification bell holds, derived from what the Bureau says is waiting on the person
 * and what has finished: each item is a sentence and a second line, `Waiting for your approval,
 * Tool runner` (design row 02w), and never a run. The engine's own event feed (a run starting, a signal arriving) is not here; it lives on the
 * Engine view's activity feed.
 *
 * - `approval`: a tool the agent wants to run is waiting for a decision (`bureau.reviews.list`).
 * - `question`: the agent asked the person something (`bureau.reviews.list`).
 * - `failed`: a top-level run, or a schedule's fire, failed (`bureau.notifications.list`, COR-1941),
 *   and `budget`: one ended because it exceeded its budget. The Bureau writes both when the run
 *   ends, for the top-level run only, so a run that fans out into children is one item and the
 *   items do not depend on how many tasks a run creates.
 * - `missed`: a schedule did not fire at its time (the host was down or too slow, or the clock
 *   skipped it), one item for each schedule that missed any, naming how many and since when, at the
 *   time its newest miss was due, for a day (`bureau.schedules.missed`).
 * - `alert`: a rule of the host's that is firing and that Health shows, such as storage over its
 *   warning level (`bureau.health.attention`). It is a standing condition and not news, so it is
 *   listed read and never counts.
 * - `notice`: any other notification the Bureau holds for the person, such as one a host wrote.
 *
 * A finished chat is not an item (agreed with design row 02w, whose caption names what the bell
 * lists): nothing is waiting on the person, so a run that completed leaves the bell and the chat
 * list shows it.
 *
 * Of the reviews waiting in one chat, the one waiting longest stands for them all (an approval
 * before a question when they asked at the same moment). A chat that is waiting on the person hides
 * its failures, so it is not listed twice. A failure is one item per notification, which is one per run, so a chat
 * with two failed runs lists both until each is read. The Bureau also writes a
 * `review.waiting` notification for each pending review; the bell does not list it, because the
 * pending review above says the same thing and leaves the list the moment it is decided.
 * A run whose chat the Bureau does not list is not a chat to open, so it is not an item. The items
 * are derived, not accumulated, so a decision made anywhere removes the item at the next read, and
 * a review the Bureau asks again (an approval's next round) is a new item.
 */
import { formatTimeOfDay } from '@lostgradient/cinder';

import type { AttentionAlert } from '../lib/bureau-attention.ts';
import type { BureauNotification } from '../lib/bureau-notifications.ts';
import type { BureauReview } from '../lib/bureau-reviews.ts';
import { formatBytes } from '../lib/format/index.ts';
import { chatSessionPath } from '../lib/identifier-paths.ts';
import { scheduleDetailPath } from '../lib/router.svelte.ts';
import { reviewTitle } from '../routes/reviews/review-items.ts';
import { CHAT_COPY, NOTIFICATION_COPY } from './copy.ts';
import type { MissedFireSource } from './notification-sources.ts';

/** How the bell grades an item: `info` never counts toward the badge. */
export type NotificationTier = 'critical' | 'warning' | 'info';

export type NotificationKind =
  'approval' | 'question' | 'failed' | 'budget' | 'missed' | 'notice' | 'alert' | 'engine';

/** An item before the store decides whether it was read. */
export interface NotificationEntry {
  /**
   * Stable across reads, so a read item stays read: `review:<id>` (`review:<id>:<round>` for an
   * approval, which the Bureau asks again under the same id when a round supersedes it),
   * or `notification:<id>` (the Bureau's own record of it).
   */
  readonly id: string;
  readonly kind: NotificationKind;
  readonly tier: NotificationTier;
  /** The Lucide icon the row shows, by name. */
  readonly icon: string;
  /** The sentence: what is being asked of the person, or what happened. */
  readonly title: string;
  /** The second line: what kind of wait it is and who it is for, or what the sentence is about. */
  readonly detail: string;
  /** The title of the chat the item is about, which the palette finds a waiting item by as well. */
  readonly chat?: string;
  /**
   * The condition is standing and not news (a firing alert Health shows), so the item is listed
   * read, whatever the person has read, and never counts.
   */
  readonly standing?: boolean;
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

/** A read notification, or a missed schedule, older than this is history, not news. */
export const RECENT_RUN_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** What a schedule is called, and whether that is an identifier (an agent's name) rather than prose (its description). */
export interface ScheduleName {
  readonly name: string;
  readonly identifier: boolean;
}

/** The name to show for an agent given its identifier, or an agent no name is known for. */
export type AgentDisplayName = (agentName: string) => string;

export interface NotificationSources {
  /** The Bureau's pending reviews. */
  readonly reviews: readonly BureauReview[];
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
  /** The fires each schedule that missed any recorded. */
  readonly missedFires?: readonly MissedFireSource[];
  /** The host's rules that are firing, which Health shows (`bureau.health.attention`). */
  readonly alerts?: readonly AttentionAlert[];
  /** The name each agent goes by on screen (the catalog's display name); its identifier where unknown. */
  readonly agentName?: AgentDisplayName;
  readonly nowMs: number;
}

/** An agent's name on screen: its display name where the catalog has one, else the words for an unnamed agent. */
function agentOf(
  name: string | undefined | null,
  display: AgentDisplayName = (identifier) => identifier,
): string {
  return name === undefined || name === null ? NOTIFICATION_COPY.unnamedAgent : display(name);
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
  display: AgentDisplayName,
): NotificationEntry {
  const sessionId = review.sessionId;
  const approval = review.kind === 'tool-approval';
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
    // What is asked, as the Reviews page words it; the second line says what kind of wait it is and
    // whose it is.
    title: reviewTitle(review),
    detail: NOTIFICATION_COPY.waiting(
      approval ? 'approval' : 'answer',
      agentOf(review.agentName, display),
    ),
    chat: chatTitle(chats, sessionId),
    ...(sessionId === undefined ? {} : { sessionId }),
    href: sessionId === undefined ? '/reviews' : chatSessionPath(sessionId),
    emittedAtMs: review.requestedAt,
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
  display: AgentDisplayName,
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
      detail: notification.body ?? '',
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
    const name = scheduleLabel(schedule, display);
    return {
      ...common,
      title: budget ? NOTIFICATION_COPY.budgetExceeded(name) : NOTIFICATION_COPY.failed(name),
      detail: notification.body ?? NOTIFICATION_COPY.noErrorText,
      href,
    };
  }
  const agent = agentOf(subject?.agentName, display);
  return {
    ...common,
    title: budget ? NOTIFICATION_COPY.budgetExceeded(agent) : NOTIFICATION_COPY.failed(agent),
    detail: chatTitle(chats, contextId),
    href,
  };
}

/** What a schedule is called on screen: its description, or the display name of the agent it runs. */
function scheduleLabel(schedule: ScheduleName, display: AgentDisplayName): string {
  return schedule.identifier ? display(schedule.name) : schedule.name;
}

/** The month and day a miss began on, in the viewer's zone: `Oct 30`. */
function dayOf(milliseconds: number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    new Date(milliseconds),
  );
}

/**
 * The item for a schedule that missed fires: how many it missed and since when, at the time its
 * newest miss was due, in the viewer's zone ("Daily summary missed its 3:00 AM run", "4 missed
 * since Oct 30, Assistant").
 */
function missedEntry(source: MissedFireSource, display: AgentDisplayName): NotificationEntry {
  const { scheduleId, name, fires, agentName } = source;
  const [newest] = fires;
  const oldest = fires.at(-1) ?? newest;
  const count = fires.reduce((total, fire) => total + fire.count, 0);
  const agent = agentOf(agentName, display);
  const label = scheduleLabel(name, display);
  const summary =
    newest.reason === 'dst-gap' && count === 1
      ? NOTIFICATION_COPY.missedClockGap
      : NOTIFICATION_COPY.missedSince(count, dayOf(oldest.occurrence));
  return {
    // The instant the newest miss is recorded at is part of what was read: the next miss is news again.
    id: `schedule-missed:${scheduleId}:${String(newest.occurrence)}`,
    kind: 'missed',
    tier: 'warning',
    icon: 'calendar-x',
    title: NOTIFICATION_COPY.missedRun(label, formatTimeOfDay(newest.occurrence)),
    detail: `${summary}, ${agent}`,
    href: scheduleDetailPath(scheduleId),
    emittedAtMs: newest.occurrence,
  };
}

/** The item for a rule of the host's that is firing, if the bell words it; the others are Health's alone. */
function alertEntry(alert: AttentionAlert): NotificationEntry | undefined {
  if (alert.metric !== 'storage.size') return undefined;
  return {
    id: `alert:${alert.metric}:${String(alert.at)}`,
    kind: 'alert',
    tier: 'info',
    standing: true,
    icon: 'triangle-alert',
    title: NOTIFICATION_COPY.storageOverWarning,
    detail: NOTIFICATION_COPY.storageUsed(formatBytes(alert.currentValue)),
    href: '/health',
    emittedAtMs: alert.at,
  };
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
 * questions, failures) before what is standing.
 */
export function buildNotificationEntries(sources: NotificationSources): NotificationEntry[] {
  const { reviews, notifications, chats, scheduleNames, nowMs } = sources;
  const display = sources.agentName ?? ((identifier: string) => identifier);
  const missedFires = sources.missedFires ?? [];
  const pending = reviews.filter((review) => review.status === 'pending');
  const entries: NotificationEntry[] = onePerChat(pending).map((review) =>
    reviewEntry(review, chats, display),
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
    const entry = notificationEntry(notification, chats, scheduleNames, display);
    if (entry !== undefined) entries.push(entry);
  }

  // A schedule that did not fire is news for a day after its newest miss was recorded, like a finished run.
  for (const source of missedFires) {
    if (nowMs - source.fires[0].recordedAt <= RECENT_RUN_WINDOW_MS) {
      entries.push(missedEntry(source, display));
    }
  }

  for (const alert of sources.alerts ?? []) {
    const entry = alertEntry(alert);
    if (entry !== undefined) entries.push(entry);
  }

  return entries.sort(
    (left, right) => rank(left) - rank(right) || right.emittedAtMs - left.emittedAtMs,
  );
}

/**
 * Where an item sits in the list (design row 02w): what waits on the person first, then the
 * failures and missed schedules, then what is standing.
 */
function rank(entry: NotificationEntry): number {
  if (entry.kind === 'approval' || entry.kind === 'question') return 0;
  return entry.tier === 'info' ? 2 : 1;
}
