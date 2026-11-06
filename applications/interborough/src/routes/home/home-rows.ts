/**
 * What Home's lists say, as plain data: the reviews waiting on you, the system problems that need
 * attention, and the chats you were last in. Each row is the words and the address of one thing, so
 * the cards only draw them and a test can read every sentence without a component.
 *
 * Home's rows are the ones Reviews, Health and Chat hold, said shorter: a review is its question
 * and who asked, a problem is a sentence and the one page that deals with it, and a chat is its
 * title and last message.
 */
import { HOME_COPY } from '../../app/copy.ts';
import { agentLabel } from '../../lib/agent-label.ts';
import type { AttentionItem } from '../../lib/bureau-attention.ts';
import type { AgentSummary, ChatContext } from '../../lib/bureau-client.ts';
import type { ListedReview } from '../../lib/bureau-reviews.ts';
import type { BureauSchedule } from '../../lib/bureau-schedules.ts';
import { clockTime, rowTime, viewerTimeZone } from '../../lib/format/clock.ts';
import { formatBytes, formatDuration } from '../../lib/format/index.ts';
import { hookPath } from '../../lib/identifier-paths.ts';
import { scheduleDetailPath } from '../../lib/router.svelte.ts';
import { reviewTitle, waitingItems } from '../reviews/review-items.ts';
import { describeCadence } from '../schedules/cadence.ts';

/** The most reviews Home lists; the rest are one click away in Reviews. */
export const NEEDS_YOU_ROW_LIMIT = 5;

/** The most chats Home lists. */
export const RECENT_CHAT_LIMIT = 3;

/** One review waiting on you, as Home's Needs you card lists it. */
export interface NeedsYouRow {
  /** The key Reviews selects it by; unique across the Bureau's reviews and the engine's. */
  readonly key: string;
  /** What it asks: the approval's question, or the question's prompt. */
  readonly title: string;
  /** What kind of review it is, which leads line two: Approval, Question or Workflow review. */
  readonly kind: string;
  /** The agent that asked, said as a person says it, or `undefined` when none did. */
  readonly agent: string | undefined;
  /** Whether the tool asking is one whose harm is hard to undo (the catalog's `dangerous` tier). */
  readonly cantBeUndone: boolean;
  /** When it was asked, in epoch milliseconds. */
  readonly requestedAt: number;
  /** The button: Answer for a question, Review for anything else. */
  readonly action: string;
  /** Where the button goes: Reviews with this review open. */
  readonly href: string;
}

/** What {@link needsYouRows} reads besides the reviews: the agents' names and the tools' tiers. */
export interface NeedsYouContext {
  readonly agents: readonly Pick<AgentSummary, 'name' | 'displayName'>[] | undefined;
  readonly tools: readonly { readonly name: string; readonly tier: string | null }[] | undefined;
}

/**
 * The reviews waiting on you, oldest first, as rows. Only a pending review waits, and the engine's
 * workflow reviews are among them, as they are in Reviews and in the count.
 */
export function needsYouRows(
  reviews: readonly ListedReview[],
  context: NeedsYouContext,
): NeedsYouRow[] {
  const copy = HOME_COPY.needsYou;
  return waitingItems(reviews)
    .map(({ key, review }): NeedsYouRow => {
      if (review.kind === 'engine-review') {
        return {
          key,
          title: reviewTitle(review),
          kind: copy.kind.workflow,
          agent: undefined,
          cantBeUndone: false,
          requestedAt: review.requestedAt,
          action: copy.review,
          href: reviewHref(key),
        };
      }
      const isQuestion = review.kind === 'human-wait';
      const toolName = review.kind === 'tool-approval' ? review.approval.toolName : undefined;
      return {
        key,
        title: reviewTitle(review),
        kind: isQuestion ? copy.kind.question : copy.kind.approval,
        agent:
          review.agentName === undefined ? undefined : agentLabel(review.agentName, context.agents),
        cantBeUndone:
          toolName !== undefined &&
          context.tools?.find((tool) => tool.name === toolName)?.tier === 'dangerous',
        requestedAt: review.requestedAt,
        action: isQuestion ? copy.answer : copy.review,
        href: reviewHref(key),
      };
    })
    .toSorted((left, right) => left.requestedAt - right.requestedAt);
}

/** Reviews with the review named by `key` open. */
function reviewHref(key: string): string {
  return `/reviews?review=${encodeURIComponent(key)}`;
}

/** One system problem, as Home's Needs attention card lists it. */
export interface AttentionRow {
  readonly key: string;
  /** The sentence that says what is wrong. */
  readonly title: string;
  /** The line under it: a reading, or where it comes from. */
  readonly detail: string | undefined;
  /** The button: its words and the page it opens. */
  readonly action: { readonly label: string; readonly href: string };
}

/** What {@link attentionRows} reads besides the problems: the schedules, and the viewer's clock. */
export interface AttentionContext {
  readonly schedules: readonly BureauSchedule[] | undefined;
  readonly agents: readonly Pick<AgentSummary, 'name' | 'displayName'>[] | undefined;
  /** The instant the card is read at, which names the zone's short form. */
  readonly now: number;
  readonly zone?: string;
}

/** The first day of a missed run, as the title says it: "Oct 30". */
function dayOf(at: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  }).format(at);
}

/** The short name of a zone at an instant: "CST", "UTC". */
function shortZone(at: number, zone: string): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? zone
  );
}

const FIXED_DAILY_CRON = /^\d{1,2} \d{1,2} \* \* \*$/;

/**
 * A schedule's cadence as the viewer reads it, with the schedule's own zone in parentheses where it
 * differs: "Every day at 3:00 AM (9:00 AM UTC)". A fixed daily time is read off the schedule's next
 * fire, so the viewer's clock and the schedule's agree on which instant it is; any other cadence is
 * said in the schedule's own words (`describeCadence`), which carry no clock to convert.
 */
export function viewerCadence(
  schedule: Pick<BureauSchedule, 'cronExpression' | 'intervalMs' | 'timeZone' | 'nextFireAt'>,
  zone: string = viewerTimeZone(),
): string {
  const cadence = {
    ...(schedule.cronExpression === null ? {} : { cronExpression: schedule.cronExpression }),
    ...(schedule.intervalMs === null ? {} : { intervalMs: schedule.intervalMs }),
    timeZone: schedule.timeZone,
  };
  const next = schedule.nextFireAt === null ? Number.NaN : Date.parse(schedule.nextFireAt);
  if (
    schedule.cronExpression === null ||
    !FIXED_DAILY_CRON.test(schedule.cronExpression.trim()) ||
    Number.isNaN(next)
  ) {
    return describeCadence(cadence);
  }
  const viewer = `Every day at ${clockTime(next, zone)}`;
  if (zone === schedule.timeZone) return viewer;
  return `${viewer} (${clockTime(next, schedule.timeZone)} ${shortZone(next, schedule.timeZone)})`;
}

/**
 * The order the kinds of problem are listed in: what the host measures first, then what a person
 * set up and did not happen (a schedule's missed runs, a hook, a plugin), and last the one that is
 * about the whole host and is cleared by connecting a provider.
 */
const KIND_ORDER: readonly AttentionItem['kind'][] = [
  'alert',
  'missed-runs',
  'hook-failed',
  'plugin-not-loaded',
  'no-provider',
];

/**
 * The problems as rows, by kind ({@link KIND_ORDER}) and, within a kind, in the order the Bureau
 * lists them (most recent first), so the order does not move when a different kind is the newest.
 */
export function attentionRows(
  items: readonly AttentionItem[],
  context: AttentionContext,
): AttentionRow[] {
  const copy = HOME_COPY.attention;
  const zone = context.zone ?? viewerTimeZone();
  const ordered = items.toSorted(
    (left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind),
  );
  return ordered.map((item, index): AttentionRow => {
    const key = `${item.kind}:${String(index)}`;
    switch (item.kind) {
      case 'alert':
        return alertRow(key, item);
      case 'missed-runs': {
        const schedule = context.schedules?.find((entry) => entry.id === item.scheduleId);
        const name = item.scheduleName ?? schedule?.description ?? copy.missedRuns.unnamed;
        const agent =
          schedule?.agentName === null || schedule?.agentName === undefined
            ? undefined
            : agentLabel(schedule.agentName, context.agents);
        const cadence = schedule === undefined ? undefined : viewerCadence(schedule, zone);
        const detail = [copy.missedRuns.kind, agent, cadence]
          .filter((part): part is string => part !== undefined)
          .join(' · ');
        return {
          key,
          title: copy.missedRuns.title(name, item.count, dayOf(item.since, zone)),
          detail,
          action: { label: copy.missedRuns.action, href: scheduleDetailPath(item.scheduleId) },
        };
      }
      case 'hook-failed': {
        const reason =
          item.status === null
            ? (item.error ?? undefined)
            : `${String(item.status)}${item.host === null ? '' : ` from ${item.host}`}`;
        return {
          key,
          title: copy.hookFailed.title(item.hookName ?? copy.hookFailed.unnamed, item.gaveUp),
          detail: reason,
          action: { label: copy.hookFailed.action, href: hookPath(item.hookId) },
        };
      }
      case 'plugin-not-loaded':
        return {
          key,
          title: copy.pluginNotLoaded.title(item.plugin),
          detail: item.problems.length === 0 ? undefined : item.problems.join(' · '),
          action: { label: copy.pluginNotLoaded.action, href: '/settings/plugins' },
        };
      case 'no-provider':
        return {
          key,
          title: copy.noProvider.title,
          detail: copy.noProvider.detail,
          action: { label: copy.noProvider.action, href: '/settings/models' },
        };
    }
  });
}

/** The row for a rule that is firing. The storage rule shows only its reading, never its limit. */
function alertRow(key: string, alert: Extract<AttentionItem, { kind: 'alert' }>): AttentionRow {
  const copy = HOME_COPY.attention;
  switch (alert.metric) {
    case 'storage.size':
      return {
        key,
        title: copy.storage.title,
        detail: copy.storage.detail(formatBytes(alert.currentValue)),
        action: { label: copy.storage.action, href: '/health/storage' },
      };
    case 'workflow.failure_rate':
      return {
        key,
        title: copy.failureRate.title,
        detail: copy.failureRate.detail(`${(alert.currentValue * 100).toFixed(1)}%`),
        action: { label: copy.failureRate.action, href: '/health' },
      };
    case 'activity.p99_duration':
      return {
        key,
        title: copy.slowSteps.title,
        detail: copy.slowSteps.detail(formatDuration(alert.currentValue)),
        action: { label: copy.slowSteps.action, href: '/health' },
      };
    default:
      return {
        key,
        title: copy.otherAlert.title(alert.metric),
        detail: undefined,
        action: { label: copy.otherAlert.action, href: '/health' },
      };
  }
}

/** The missed runs the last seven days hold, across every schedule: the fourth count. */
export function missedRunCount(items: readonly AttentionItem[]): number {
  let total = 0;
  for (const item of items) if (item.kind === 'missed-runs') total += item.count;
  return total;
}

/** One chat, as Home's Recent chats card lists it. */
export interface RecentChatRow {
  readonly id: string;
  readonly title: string;
  /** The latest message the chat holds, which is line two. */
  readonly latest: string;
  /** The status word, which leads the row: the word and its tone come from Cinder's table. */
  readonly status: 'Waiting on you' | 'Running' | 'Failed' | 'Ended' | 'Done';
  /** When it last changed, as the row says it ("10:42 AM", "Yesterday, 4:12 PM"). */
  readonly time: string;
  /** The same instant, for the element's `datetime`. */
  readonly timestamp: number | null;
}

/** The status word of a chat: waiting on you, running, failed, ended by the host, or done. */
export function chatStatusWord(
  context: Pick<ChatContext, 'id' | 'activity' | 'endReason'>,
  failedChats: ReadonlySet<string>,
): RecentChatRow['status'] {
  if (context.activity === 'awaiting-input') return 'Waiting on you';
  if (context.activity === 'running') return 'Running';
  if (failedChats.has(context.id)) return 'Failed';
  if (context.endReason === 'host-stopped') return 'Ended';
  return 'Done';
}

/** The newest chats, as rows, at most {@link RECENT_CHAT_LIMIT}. */
export function recentChatRows(
  contexts: readonly ChatContext[],
  failedChats: ReadonlySet<string>,
  fallbackTitle: string,
  messageCount: (count: number) => string,
  now: number,
  zone: string = viewerTimeZone(),
): RecentChatRow[] {
  return contexts.slice(0, RECENT_CHAT_LIMIT).map((context): RecentChatRow => {
    const updated = Date.parse(context.updatedAt);
    const preview = context.lastMessagePreview?.trim();
    return {
      id: context.id,
      title: context.title ?? fallbackTitle,
      latest:
        preview === undefined || preview === '' ? messageCount(context.messageCount) : preview,
      status: chatStatusWord(context, failedChats),
      time: Number.isNaN(updated) ? '' : rowTime(updated, now, zone),
      timestamp: Number.isNaN(updated) ? null : updated,
    };
  });
}
