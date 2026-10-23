import { CHAT_COPY } from '../../app/copy.ts';
import type { ChatContext } from '../../lib/bureau-client.ts';
import type { BureauReview } from '../../lib/bureau-reviews.ts';
import { approvalQuestion, declaredSummary } from '../../lib/tool-text.ts';

/** The groups the chat list is cut into, in the order a person reads them. */
export type SessionGroupKey = 'needs-you' | 'today' | 'yesterday' | 'earlier';

/** One chat as a row of the list: everything the row shows, and nothing it does not. */
export type SessionRow = {
  readonly id: string;
  readonly title: string;
  /** The latest message, or the question the chat is waiting on you to answer. */
  readonly snippet: string;
  readonly agentName: string;
  /** Epoch milliseconds of the chat's last change, or `null` when the Bureau's time is unreadable. */
  readonly updatedAt: number | null;
  /** Whether the chat's run waits on the person: the Bureau's `awaiting-input` activity. */
  readonly needsYou: boolean;
  /** Whether the chat is idle and its latest run failed (`chatsWithFailedRun`). */
  readonly failed: boolean;
};

export type SessionGroup = {
  readonly key: SessionGroupKey;
  readonly label: string;
  readonly rows: readonly SessionRow[];
};

/**
 * What a pending review asks the person, in the words the chat itself uses: an approval is the
 * question its tool's own sentence or its arguments make (`approvalQuestion`), a question is its
 * prompt. A review that says nothing yields `undefined`, so the row falls back to the last message.
 */
function reviewQuestion(review: BureauReview): string | undefined {
  if (review.kind === 'human-wait') {
    const prompt = review.prompt?.trim();
    return prompt === undefined || prompt === '' ? undefined : prompt;
  }
  const { approval } = review;
  return approvalQuestion({
    toolName: approval.toolName,
    arguments: approval.arguments,
    summary: declaredSummary(
      approval.action.type === 'approval' ? approval.action.message : undefined,
      approval.reason,
    ),
  });
}

/**
 * The question each chat is waiting on, by session. A chat with several pending reviews shows the
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
 * the person it is the question being asked instead, because the last thing said is then the
 * person's own message, which the title already is. A chat with nothing to show says how many
 * messages it holds.
 */
export function sessionRow(
  context: ChatContext,
  questions: ReadonlyMap<string, string>,
  failedChats: ReadonlySet<string> = new Set(),
): SessionRow {
  const needsYou = context.activity === 'awaiting-input';
  const preview = context.lastMessagePreview?.trim();
  const snippet =
    (needsYou ? questions.get(context.id) : undefined) ??
    (preview === undefined || preview === '' ? undefined : preview) ??
    CHAT_COPY.messageCount(context.messageCount);
  const updated = Date.parse(context.updatedAt);
  return {
    id: context.id,
    title: context.title ?? CHAT_COPY.untitled,
    snippet,
    agentName: context.agentName,
    updatedAt: Number.isNaN(updated) ? null : updated,
    needsYou,
    failed: context.activity === 'idle' && failedChats.has(context.id),
  };
}

function startOfDay(timestamp: number): number {
  const day = new Date(timestamp);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

/**
 * Which day-group a change at `updatedAt` belongs to, by the reader's calendar day: "Today" is
 * since local midnight and "Yesterday" the day before. A change in the future (a clock that is ahead) is
 * today's, and one with no readable time is Earlier, where nothing claims it is recent.
 */
export function dayGroupOf(
  updatedAt: number | null,
  now: number,
): Exclude<SessionGroupKey, 'needs-you'> {
  if (updatedAt === null) return 'earlier';
  const today = startOfDay(now);
  if (updatedAt >= today) return 'today';
  const yesterday = startOfDay(today - 1);
  return updatedAt >= yesterday ? 'yesterday' : 'earlier';
}

/**
 * The rows cut into the groups of the list: "Needs you" first, whatever its age, then Today,
 * Yesterday and Earlier. Each group is newest first, and a group with no row is left out. Rows with
 * the same time keep the order the Bureau listed them in.
 */
export function groupSessions(rows: readonly SessionRow[], now: number): readonly SessionGroup[] {
  const buckets: Record<SessionGroupKey, SessionRow[]> = {
    'needs-you': [],
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const row of rows) {
    buckets[row.needsYou ? 'needs-you' : dayGroupOf(row.updatedAt, now)].push(row);
  }
  const order: readonly SessionGroupKey[] = ['needs-you', 'today', 'yesterday', 'earlier'];
  return order
    .map((key) => ({
      key,
      label: CHAT_COPY.groups[key],
      rows: buckets[key].toSorted((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)),
    }))
    .filter((group) => group.rows.length > 0);
}

/**
 * Which of eight colours an agent's avatar takes. The same name always gives the same colour, so an
 * agent keeps its colour across lists and reloads; the sum of the name's code units spreads the
 * names a host has well enough, and carries no meaning.
 */
export function agentTone(agentName: string): number {
  let total = 0;
  for (const character of agentName) total = (total * 31 + (character.codePointAt(0) ?? 0)) % 8191;
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
