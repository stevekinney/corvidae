/**
 * What Home's lists say, as plain data: the reviews waiting on you, the system problems that need
 * attention, and the chats you were last in. Each row is the words and the address of one thing, so
 * the cards only draw them and a test can read every sentence without a component.
 *
 * Home's rows are the ones Reviews, Health and Chat hold, said shorter: a review is its question
 * and who asked, a problem is a sentence and the one page that deals with it, and a chat is its
 * title and last message.
 */
import { HOME_COPY } from '../../app/copy/home.ts';
import {
  FIRST_RUN_STEPS,
  type FirstRunProgress,
  type FirstRunStepId,
} from '../../app/first-run.ts';
import { agentLabel } from '../../lib/agent-label.ts';
import type { AttentionItem } from '../../lib/bureau-attention.ts';
import type { AgentSummary, ChatContext } from '../../lib/bureau-client.ts';
import type { ListedReview } from '../../lib/bureau-reviews.ts';
import type { BureauSchedule } from '../../lib/bureau-schedules.ts';
import type { TaskView } from '../../lib/bureau-tasks.ts';
import { clockTime, rowTime, viewerTimeZone } from '../../lib/format/clock.ts';
import { formatBytes, formatDuration } from '../../lib/format/index.ts';
import { hookPath } from '../../lib/identifier-paths.ts';
import { scheduleDetailPath, workflowDetailPath } from '../../lib/router.svelte.ts';
import { chatStatusWord, sessionRow, type ChatStatusWord } from '../chat/session-groups.ts';
import { reviewTitle, waitingItems } from '../reviews/review-items.ts';
import { describeCadence } from '../schedules/cadence.ts';
import { providerDisplayName } from '../settings/models/format-model.ts';
import { buildRunRows } from '../workflows/runs/run-rows.ts';
import { findAssistant } from './home-start-chat.ts';

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
const KIND_ORDER = [
  'alert',
  'missed-runs',
  'hook-failed',
  'plugin-not-loaded',
  'no-provider',
] as const satisfies readonly AttentionItem['kind'][];

/** A problem of a kind Home has words for ({@link KIND_ORDER}). */
type HomeAttentionItem = Extract<AttentionItem, { kind: (typeof KIND_ORDER)[number] }>;

function isHomeKind(item: AttentionItem): item is HomeAttentionItem {
  return (KIND_ORDER as readonly string[]).includes(item.kind);
}

/**
 * The problems as rows, by kind ({@link KIND_ORDER}) and, within a kind, in the order the Bureau
 * lists them (most recent first), so the order does not move when a different kind is the newest.
 * A kind outside {@link KIND_ORDER} has no row here.
 */
export function attentionRows(
  items: readonly AttentionItem[],
  context: AttentionContext,
): AttentionRow[] {
  const copy = HOME_COPY.attention;
  const zone = context.zone ?? viewerTimeZone();
  // A kind Home has no words for (a worker that disconnected) is left out; Health lists it.
  const ordered = items
    .filter(isHomeKind)
    .toSorted((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));
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
          .join(', ');
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
          detail: item.problems.length === 0 ? undefined : item.problems.join(', '),
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
  readonly status: ChatStatusWord;
  /** When it last changed, as the row says it ("10:42 AM", "Yesterday, 4:12 PM"). */
  readonly time: string;
  /** The same instant, for the element's `datetime`. */
  readonly timestamp: number | null;
}

/**
 * The newest chats, as rows, at most {@link RECENT_CHAT_LIMIT}. Line two is what the chat list says
 * (`sessionRow`): the question a chat that waits on you is asking, which is the thing to read, and
 * otherwise the latest message, which for a chat that waits is only your own words again.
 */
export function recentChatRows(
  contexts: readonly ChatContext[],
  questions: ReadonlyMap<string, string>,
  failedChats: ReadonlySet<string>,
  now: number,
  zone: string = viewerTimeZone(),
): RecentChatRow[] {
  return contexts.slice(0, RECENT_CHAT_LIMIT).map((context): RecentChatRow => {
    const row = sessionRow(context, questions, failedChats);
    return {
      id: context.id,
      title: row.title,
      latest: row.snippet,
      status: chatStatusWord(context, failedChats),
      time: row.updatedAt === null ? '' : rowTime(row.updatedAt, now, zone),
      timestamp: row.updatedAt,
    };
  });
}

/** The most runs Home's Running now card lists; the rest are one click away in Runs. */
export const RUNNING_ROW_LIMIT = 5;

/** One run that is running now, as Home's Running now card lists it. */
export interface RunningRow {
  readonly key: string;
  /** What the run is: the schedule's name, the chat's title, or the agent that runs. */
  readonly title: string;
  /**
   * Line two: the status word, then what started it, which agent runs, and when it started, joined
   * by commas ("Running, Schedule, Assistant, started 10:44 AM").
   */
  readonly line: string;
  /** The run's page, which "View run" opens. */
  readonly href: string;
}

/** What {@link runningRows} reads besides the running tasks. */
export interface RunningContext {
  /** The chats the caller lists, whose titles name a run a chat or a schedule's fire started. */
  readonly chats: readonly ChatContext[];
  /** The schedules, whose names title a run a schedule started; absent until they are read. */
  readonly schedules: readonly Pick<BureauSchedule, 'id' | 'description'>[] | undefined;
  readonly agents: readonly Pick<AgentSummary, 'name' | 'displayName'>[] | undefined;
  /** The instant the card is read at, which decides whether a start time is today's. */
  readonly now: number;
  readonly zone?: string;
}

/**
 * The runs running now, as rows, the most recently changed first. A row is read from what the Runs
 * list reads (`buildRunRows`), so a run says the same thing about what started it in both places.
 */
export function runningRows(tasks: readonly TaskView[], context: RunningContext): RunningRow[] {
  const copy = HOME_COPY.running;
  const zone = context.zone ?? viewerTimeZone();
  const schedules = new Map((context.schedules ?? []).map((schedule) => [schedule.id, schedule]));
  return buildRunRows({ tasks, goals: [], chats: context.chats }).map((run): RunningRow => {
    const agent = run.agentName === null ? undefined : agentLabel(run.agentName, context.agents);
    const origin = run.origin;
    const scheduleName =
      origin.kind === 'schedule' && origin.scheduleId !== null
        ? schedules.get(origin.scheduleId)?.description
        : undefined;
    const title =
      [
        scheduleName,
        origin.kind === 'chat' || origin.kind === 'schedule' ? origin.title : undefined,
        agent,
      ].find((candidate) => candidate !== undefined && candidate !== null && candidate !== '') ??
      copy.untitled;
    const parts = [
      origin.kind === 'none' ? undefined : copy.startedBy[origin.kind],
      agent,
      copy.startedAt(rowTime(run.startedAt, context.now, zone)),
    ].filter((part): part is string => part !== undefined);
    return {
      key: run.id,
      title,
      line: `${copy.status}, ${parts.join(', ')}`,
      href: workflowDetailPath(run.id),
    };
  });
}

/** One step of Home's first-run checklist, as the card draws it. */
export interface ChecklistStep {
  readonly id: FirstRunStepId;
  readonly title: string;
  /** What the step says: what it asks while it is open, what is true once it is done. */
  readonly description: string;
  readonly done: boolean;
}

/** What {@link checklistSteps} reads besides which steps are done. */
export interface ChecklistContext {
  readonly providers: readonly { readonly name: string; readonly hasKey: boolean }[];
  readonly agents: readonly Pick<AgentSummary, 'name' | 'displayName' | 'kind'>[] | undefined;
  /** Whether the person chose Assistant, which is how the second step is done without an agent made. */
  readonly assistantChosen: boolean;
}

/**
 * The three steps in the order the card shows them, each with its words: the question while it is
 * open, and what is now true once it is done ("Anthropic is connected.", "Assistant is ready to
 * use.").
 */
export function checklistSteps(
  progress: FirstRunProgress,
  context: ChecklistContext,
): ChecklistStep[] {
  const copy = HOME_COPY.firstRun;
  // Assistant is named only where the host lists one. Without it the second step says an agent is
  // ready, naming the person's own or else the first one the host lists.
  const assistant = findAssistant(context.agents ?? []);
  const fileAgent = context.agents?.find((agent) => agent.kind === 'file');
  const readyAgent =
    assistant !== undefined && (context.assistantChosen || fileAgent === undefined)
      ? assistant
      : (fileAgent?.name ?? context.agents?.[0]?.name);
  const connected = context.providers
    .filter((provider) => provider.hasKey)
    .map((provider) => providerDisplayName(provider.name));
  const words: Record<FirstRunStepId, { title: string; open: string; done: string }> = {
    provider: {
      title: copy.provider.title,
      open: copy.provider.description,
      done: copy.provider.done(connected),
    },
    agent: {
      title: assistant === undefined ? copy.agent.titleWithoutAssistant : copy.agent.title,
      open:
        assistant === undefined ? copy.agent.descriptionWithoutAssistant : copy.agent.description,
      done: copy.agent.done(
        readyAgent === undefined ? copy.agent.anAgent : agentLabel(readyAgent, context.agents),
      ),
    },
    chat: { title: copy.chat.title, open: copy.chat.description, done: copy.chat.description },
  };
  return FIRST_RUN_STEPS.map((id) => ({
    id,
    title: words[id].title,
    description: progress[id] ? words[id].done : words[id].open,
    done: progress[id],
  }));
}
