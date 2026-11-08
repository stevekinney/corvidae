import type { DataListGroup } from '@lostgradient/cinder';

import { CHAT_COPY } from '../../app/copy.ts';
import type { ChatContext } from '../../lib/bureau-client.ts';
import type { BureauReview } from '../../lib/bureau-reviews.ts';
import { calendarDay, dateLine, zoneLabel } from '../../lib/format/clock.ts';

/** The status words of a chat, in the one table every status word comes from (`StatusDot`'s). */
export type ChatStatusWord = 'Waiting on you' | 'Running' | 'Failed' | 'Ended' | 'Done';

/** One chat as a row of the list: everything the row shows, and nothing it does not. */
export type SessionRow = {
  readonly id: string;
  readonly title: string;
  /** The latest message, or the question the chat is waiting on you to answer. */
  readonly snippet: string;
  readonly agentName: string;
  /** Epoch milliseconds of the chat's last change, or `null` when the Bureau's time is unreadable. */
  readonly updatedAt: number | null;
  /**
   * The status word that leads line two: waiting on the person (the Bureau's `awaiting-input`
   * activity), running, failed (idle with a failed latest run), ended by the host, or done.
   */
  readonly status: ChatStatusWord;
};

/** The status word of a chat: waiting on you, running, failed, ended by the host, or done. */
export function chatStatusWord(
  context: Pick<ChatContext, 'id' | 'activity' | 'endReason'>,
  failedChats: ReadonlySet<string>,
): ChatStatusWord {
  if (context.activity === 'awaiting-input') return 'Waiting on you';
  if (context.activity === 'running') return 'Running';
  if (failedChats.has(context.id)) return 'Failed';
  if (context.endReason === 'host-stopped') return 'Ended';
  return 'Done';
}

/**
 * What a pending review asks the person, for the chat list: a question is its prompt. An approval
 * asks nothing here, because the agent has already said what it needs in the chat's own latest
 * message ("I need your approval to refund it."), which line two shows instead of the review's
 * title. A review that says nothing yields `undefined`, so the row falls back to the last message.
 */
function reviewQuestion(review: BureauReview): string | undefined {
  if (review.kind !== 'human-wait') return undefined;
  const prompt = review.prompt?.trim();
  return prompt === undefined || prompt === '' ? undefined : prompt;
}

/**
 * The question each chat is waiting on, by session: only a chat that asked a question has one, an
 * approval is told by the chat's latest message. A chat with several pending questions shows the
 * oldest, which is the one it stopped at. Only a pending review counts.
 */
export function pendingQuestions(reviews: readonly BureauReview[]): ReadonlyMap<string, string> {
  const questions = new Map<string, string>();
  const oldestFirst = reviews
    .filter((review) => review.status === 'pending')
    .toSorted((left, right) => left.requestedAt - right.requestedAt);
  for (const review of oldestFirst) {
    if (review.sessionId === undefined || questions.has(review.sessionId)) continue;
    const question = reviewQuestion(review);
    if (question !== undefined) questions.set(review.sessionId, question);
  }
  return questions;
}

/**
 * The chats a pending review names, in the order the reviews were asked: the chats that wait on the
 * person, which the list must show whichever page of it they are on. A review with no session names
 * none, and a settled review waits on no one.
 */
export function waitingChatIds(reviews: readonly BureauReview[]): readonly string[] {
  const ids = new Set<string>();
  for (const review of reviews.toSorted((left, right) => left.requestedAt - right.requestedAt)) {
    if (review.status === 'pending' && review.sessionId !== undefined) ids.add(review.sessionId);
  }
  return [...ids];
}

/**
 * A session as a row. The snippet is the latest message the Bureau records; while the chat waits on
 * the person's answer it is the question being asked instead, because the last thing said is then
 * the person's own message, which the title already is, and once the host has ended the chat it is
 * why it ended. A chat with nothing to show says how many messages it holds.
 */
export function sessionRow(
  context: ChatContext,
  questions: ReadonlyMap<string, string>,
  failedChats: ReadonlySet<string> = new Set(),
): SessionRow {
  const status = chatStatusWord(context, failedChats);
  const preview = context.lastMessagePreview?.trim();
  const snippet =
    (status === 'Waiting on you' ? questions.get(context.id) : undefined) ??
    // A chat that ended says why, which is the thing to read: its last message is only the
    // person's own.
    (status === 'Ended' ? CHAT_COPY.list.endedBecause : undefined) ??
    (preview === undefined || preview === '' ? undefined : preview) ??
    CHAT_COPY.messageCount(context.messageCount);
  const updated = Date.parse(context.updatedAt);
  return {
    id: context.id,
    title: context.title ?? CHAT_COPY.untitled,
    snippet,
    agentName: context.agentName,
    updatedAt: Number.isNaN(updated) ? null : updated,
    status,
  };
}

/**
 * The chats as the list orders them, newest first: by when they last changed, the ones with no
 * readable time last, and rows with the same time in the order the Bureau listed them.
 */
export function chatListRows(rows: readonly SessionRow[]): SessionRow[] {
  return rows.toSorted(
    (left, right) => (right.updatedAt ?? -Infinity) - (left.updatedAt ?? -Infinity),
  );
}

/** Which segment of the list's status control a row falls in; `all` holds every row. */
export type ChatSegment = 'all' | 'waiting' | 'done';

/** The segments in the order the control draws them. */
export const CHAT_SEGMENTS: readonly ChatSegment[] = ['all', 'waiting', 'done'];

/**
 * Whether a row is in a segment: `waiting` holds the chats that wait on the person and `done` the
 * ones that finished. A chat that ended, failed or is running is only in `all`.
 */
export function inSegment(row: Pick<SessionRow, 'status'>, segment: ChatSegment): boolean {
  if (segment === 'waiting') return row.status === 'Waiting on you';
  if (segment === 'done') return row.status === 'Done';
  return true;
}

/** How many of `rows` each segment holds. */
export function segmentCounts(
  rows: readonly Pick<SessionRow, 'status'>[],
): Readonly<Record<ChatSegment, number>> {
  return {
    all: rows.length,
    waiting: rows.filter((row) => inSegment(row, 'waiting')).length,
    done: rows.filter((row) => inSegment(row, 'done')).length,
  };
}

/**
 * The rows a search leaves: those whose title or latest message holds the words typed, whatever
 * their case, or whose agent is named in them. A search of nothing but space leaves every row.
 */
export function matchingRows<Row extends Pick<SessionRow, 'title' | 'snippet'>>(
  rows: readonly Row[],
  search: string,
  agentLabelOf: (row: Row) => string,
): Row[] {
  const needle = search.trim().toLocaleLowerCase();
  if (needle === '') return [...rows];
  return rows.filter((row) =>
    [row.title, row.snippet, agentLabelOf(row)].some((text) =>
      text.toLocaleLowerCase().includes(needle),
    ),
  );
}

/**
 * The day band a row is listed under, as a `DataList` group. The band names its day by the
 * viewer's calendar ("Today", "Yesterday · Sunday, Nov 1", "Thursday, Oct 29") and the zone its
 * times are in at the right ("Central time"). A wide list (a pane dragged out past what its rows
 * need) names today's date too, as the list pattern does. A chat with no readable time is Earlier,
 * where nothing claims it is recent. On a phone (`phone`) the list is a screen of its own and its
 * bands read "Today" and "Yesterday" alone, with "Central time" at the right (design row 06l).
 */
export function chatDayGroup(
  row: Pick<SessionRow, 'updatedAt'>,
  now: number,
  zone: string,
  wide: boolean,
  phone = false,
): DataListGroup {
  const detail = zoneLabel(now, zone);
  if (row.updatedAt === null) return { key: 'earlier', label: CHAT_COPY.list.earlier, detail };
  const days = calendarDay(now, zone) - calendarDay(row.updatedAt, zone);
  if (days <= 0) return { key: 'today', label: todayLabel(now, zone, wide), detail };
  const day = dateLine(row.updatedAt, zone);
  if (days === 1) {
    const label = phone ? CHAT_COPY.list.yesterday : `${CHAT_COPY.list.yesterday} · ${day}`;
    return { key: 'yesterday', label, detail };
  }
  return { key: `day-${String(calendarDay(row.updatedAt, zone))}`, label: day, detail };
}

function todayLabel(now: number, zone: string, wide: boolean): string {
  return wide ? `${CHAT_COPY.list.today} · ${dateLine(now, zone)}` : CHAT_COPY.list.today;
}

/**
 * Which of eight colours an agent's avatar takes. The same name always gives the same colour, so an
 * agent keeps its colour across lists and reloads; the colour carries no meaning. The seed and the
 * multiplier were picked so that the six built-in agents of the sample world, which a new chat
 * draws side by side, each get a colour of their own: Assistant blue, Tool runner green, Request
 * human input orange, Workflow author teal, Echo violet, and Model switcher olive.
 */
export function agentTone(agentName: string): number {
  let total = 302;
  for (const character of agentName) total = (total * 27 + (character.codePointAt(0) ?? 0)) % 8191;
  return total % 8;
}

/**
 * The words an avatar spells for an agent: the first letters of the first two parts of its
 * identifier ("request-human-input" is "RH"). Cinder's avatar splits on whitespace, so the
 * identifier's hyphens become spaces.
 */
export function agentAvatarName(agentName: string): string {
  return agentName.replaceAll(/[-_.]+/g, ' ');
}
