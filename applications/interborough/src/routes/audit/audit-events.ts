/**
 * What an audit record says, in the words the log's table and its pane use. The trail holds
 * metadata only (never a tool's arguments, a chat's title or a memory's text), so a sentence like
 * "Asked to refund order 4471" is made from the record and from what the page looks up for it: the
 * review the call waits in, the chat a run belongs to, the schedule that missed its runs, the
 * memory that was corrected, the tool's name for a person. A lookup that has not arrived leaves a
 * plainer sentence ("Asked to use Issue refund"), and the sentence sharpens when it does.
 *
 * Only some records are events (`lib/audit-event-types.ts`): the engine's steps are a run's own
 * timeline, and a tool that ran without asking is not news.
 */
import {
  formatDate,
  formatDateTime,
  formatTimeOfDay,
  formatTimeZoneLabel,
  humanizeIdentifier,
} from '@lostgradient/cinder';

import { AUDIT_COPY, AUDIT_EVENT_COPY } from '../../app/copy.ts';
import type { AuditEventKind } from '../../lib/audit-event-types.ts';
import { AUDIT_EVENT_KINDS } from '../../lib/audit-event-types.ts';
import type { AuditRecord } from '../../lib/bureau-audit.ts';
import type { BureauToolApproval } from '../../lib/bureau-reviews.ts';
import { providerDisplayName } from '../settings/models/format-model.ts';
import { splitResource, type AuditActorFilter } from './audit-filter.ts';

/** What the page has looked up to word records; anything absent leaves a plainer sentence. */
export interface AuditLookups {
  /** Each chat's title by session identifier; `null` for a chat that is gone. */
  readonly chatTitles: ReadonlyMap<string, string | null>;
  /** Each schedule's name by schedule identifier. */
  readonly scheduleNames: ReadonlyMap<string, string>;
  /** The review a tool call waits in or waited in, by review identifier; `null` when it cannot be read. */
  readonly reviews: ReadonlyMap<string, BureauToolApproval | null>;
  /** The text of a corrected memory by memory identifier. */
  readonly memories: ReadonlyMap<string, string>;
  /** The tools a person can name, by identifier. */
  readonly tools: ReadonlyMap<string, AuditTool>;
  /** What an agent is called where a person reads it. */
  readonly agentName: (identifier: string) => string;
}

/** A tool as the catalog names it for a person. */
export interface AuditTool {
  /** The tool's name for a person ("Issue refund"), or `null` when it has none. */
  readonly title: string | null;
  /** What the tool may technically do, or `null` when it declares nothing. */
  readonly tier: 'read-only' | 'mutating' | 'dangerous' | null;
}

/** Lookups with nothing in them, for a page that has not asked yet. */
export const NO_LOOKUPS: AuditLookups = {
  chatTitles: new Map(),
  scheduleNames: new Map(),
  reviews: new Map(),
  memories: new Map(),
  tools: new Map(),
  agentName: (identifier) => humanizeIdentifier(identifier, { casing: 'sentence' }),
};

/** Who did it, as the table's Who column reads it. */
export interface AuditActor {
  /** `you` for a person at this host, `agent` for an agent, `host` for Interborough itself. */
  readonly kind: 'you' | 'agent' | 'host';
  /** The name to show: "You", "Tool runner" or "Interborough". */
  readonly name: string;
}

/** One audit event: a record, worded. */
export interface AuditEvent {
  /** The record's own key: its time and its place in the trail's order within that time. */
  readonly key: string;
  readonly record: AuditRecord;
  /** When it happened, in epoch milliseconds. */
  readonly at: number;
  readonly actor: AuditActor;
  /** What was done, as a sentence that starts with a verb: "Removed the Anthropic key". */
  readonly action: string;
  /** What it was done to, as one short line: "Anthropic provider". */
  readonly target: string;
  /** The pane's title: the actor and the action as one sentence. */
  readonly title: string;
  readonly kind: AuditEventKind;
}

/**
 * The longest a target is before the pane shows it whole under a heading with its length, instead
 * of as a fact. A storage key can be thousands of characters long.
 */
export const LONG_TARGET_CHARACTERS = 80;

/** The key a record is listed and selected under. */
export function recordKey(record: AuditRecord): string {
  return `${record.timestamp}#${String(record.sequence ?? '')}`;
}

function text(record: AuditRecord, name: string): string | undefined {
  const value = record.detail?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberOf(record: AuditRecord, name: string): number | undefined {
  const value = record.detail?.[name];
  return typeof value === 'number' ? value : undefined;
}

const lowerFirst = (sentence: string): string =>
  `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;

/** The review a tool record names, or the one its call opened (`approval:<run>:<call>`). */
export function reviewIdOf(record: AuditRecord): string | undefined {
  const named = text(record, 'reviewId');
  if (named !== undefined) return named;
  const call = text(record, 'toolCallId') ?? text(record, 'callId');
  return call === undefined ? undefined : `approval:${record.resource}:${call}`;
}

/**
 * Whether a `tool.settled` record is news: the call asked first (`paused`), or it ran after a
 * person approved it (it names its review). A tool that ran without asking is not an event.
 */
function isGatedToolRecord(record: AuditRecord): boolean {
  return text(record, 'status') === 'paused' || text(record, 'reviewId') !== undefined;
}

/**
 * The first money amount in a tool's own sentence, "$42.00" in "Refund order 4471 for $42.00?",
 * which is how a tool says what a call is worth: the trail never carries the arguments.
 */
export function amountOf(summary: string | undefined): string | undefined {
  return summary === undefined ? undefined : /[$€£]\d[\d,]*(?:\.\d+)?/.exec(summary)?.[0];
}

/** The tool's own sentence for a call, from its review, with no closing question mark. */
export function summaryOf(review: BureauToolApproval | null | undefined): string | undefined {
  const message = review?.approval.action.message?.trim();
  if (message === undefined || message === '' || message === review?.approval.reason) {
    return undefined;
  }
  return message.replace(/[?.]+$/, '');
}

/** The call's own sentence without its amount: "Refund order 4471 for $42.00" reads "Refund order 4471". */
export function withoutAmount(summary: string): string {
  return summary.replace(/\s+for\s+[$€£]\d[\d,]*(?:\.\d+)?$/, '');
}

/** The few verbs a tool's sentence is likely to start with that do not take -ed. */
const IRREGULAR_PAST = new Map([
  ['build', 'built'],
  ['do', 'did'],
  ['find', 'found'],
  ['get', 'got'],
  ['give', 'gave'],
  ['make', 'made'],
  ['pay', 'paid'],
  ['put', 'put'],
  ['read', 'read'],
  ['reset', 'reset'],
  ['run', 'ran'],
  ['send', 'sent'],
  ['set', 'set'],
  ['take', 'took'],
  ['write', 'wrote'],
]);

/**
 * A tool's own sentence told in the past: "Refund order 4472" reads "Refunded order 4472". Its
 * first word is the verb, which takes -ed (-d after an e, -ied after a consonant and y) unless it is
 * one of the few that do not.
 */
export function pastTense(sentence: string): string {
  const [verb = '', ...rest] = sentence.split(' ');
  const lower = verb.toLowerCase();
  const past =
    IRREGULAR_PAST.get(lower) ??
    (/[^aeiou]y$/.test(lower)
      ? `${lower.slice(0, -1)}ied`
      : lower.endsWith('e')
        ? `${lower}d`
        : `${lower}ed`);
  return [`${past.charAt(0).toUpperCase()}${past.slice(1)}`, ...rest].join(' ');
}

/**
 * What a call was about, from its arguments: the first identifier-like argument, named by its key
 * ("orderId" with 4471 reads "order 4471"), or `undefined` when the arguments hold none.
 */
export function callLabelOf(review: BureauToolApproval | null | undefined): string | undefined {
  const args = review?.approval.arguments;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  for (const [key, value] of Object.entries(args)) {
    if (!/[a-z]Id$/.test(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const noun = key
      .slice(0, -2)
      .replace(/([A-Z])/g, ' $1')
      .toLowerCase()
      .trim();
    return `${noun} ${String(value)}`;
  }
  return undefined;
}

function toolTitle(record: AuditRecord, lookups: AuditLookups): string {
  const name = text(record, 'toolName') ?? '';
  return lookups.tools.get(name)?.title ?? humanizeIdentifier(name, { casing: 'sentence' });
}

/** Who did it: a person at this host, an agent, or Interborough. */
export function actorOf(record: AuditRecord, lookups: AuditLookups): AuditActor {
  const agent = text(record, 'agentName');
  const principal = record.principal;
  // A tool's records and a memory an agent wrote name no actor, or the run: the agent did it.
  const byAgent =
    agent !== undefined &&
    (record.type === 'tool.settled' ||
      (record.type === 'memory.corrected' && text(record, 'writer') === 'agent'));
  if (byAgent) return { kind: 'agent', name: lookups.agentName(agent) };
  if (principal !== null && principal.startsWith('system:')) {
    return { kind: 'host', name: AUDIT_EVENT_COPY.host };
  }
  if (principal === null) {
    return agent === undefined
      ? { kind: 'host', name: AUDIT_EVENT_COPY.host }
      : { kind: 'agent', name: lookups.agentName(agent) };
  }
  return { kind: 'you', name: AUDIT_EVENT_COPY.you };
}

/** What a record says was done and to what, before it is dressed as an event. */
interface Wording {
  readonly action: string;
  readonly target: string;
  /** The pane's title when it is not the actor and the action. */
  readonly title?: string;
}

function resourceName(resource: string, lookups: AuditLookups): string {
  const { kind, id } = splitResource(resource);
  if (kind === 'agent') return lookups.agentName(id);
  if (kind === 'workflow' || kind === 'schedule') {
    return humanizeIdentifier(id, { casing: 'sentence' });
  }
  return resource;
}

function wordingOf(
  record: AuditRecord,
  lookups: AuditLookups,
  newestRuns: ReadonlySet<string> | undefined,
): Wording | undefined {
  const copy = AUDIT_EVENT_COPY;
  const agent = text(record, 'agentName');
  switch (record.type) {
    case 'host.started':
      return {
        action: copy.serverStarted,
        target: copy.serverStartedTarget,
        title: copy.serverStarted,
      };
    case 'provider.disconnected': {
      const provider = text(record, 'provider');
      const name = provider === undefined ? 'provider' : providerDisplayName(provider);
      return { action: copy.removedProviderKey(name), target: copy.providerTarget(name) };
    }
    case 'run.started':
    case 'run.aborted':
    case 'run.error': {
      const sessionId = text(record, 'sessionId');
      // A chat's title is the start of its latest message, so only the newest run of a chat is
      // called after it; an earlier run's own message is not recorded, and the title would name
      // the wrong one.
      const named = newestRuns === undefined || newestRuns.has(recordKey(record));
      const title =
        sessionId === undefined || !named ? undefined : lookups.chatTitles.get(sessionId);
      const action =
        record.type === 'run.started'
          ? copy.startedRun
          : record.type === 'run.aborted'
            ? copy.stoppedRun
            : copy.runFailed;
      return {
        action,
        target:
          title === undefined || title === null
            ? agent === undefined
              ? record.resource
              : lookups.agentName(agent)
            : copy.chatTarget(title),
      };
    }
    case 'schedule.missed':
    case 'schedule.fired':
    case 'schedule.created':
    case 'schedule.paused':
    case 'schedule.resumed':
    case 'schedule.cancelled': {
      const scheduleId = text(record, 'scheduleId') ?? splitResource(record.resource).id;
      const name = lookups.scheduleNames.get(scheduleId) ?? copy.aSchedule;
      const action =
        record.type === 'schedule.missed'
          ? copy.missedRuns(numberOf(record, 'missedCount') ?? 1)
          : record.type === 'schedule.fired'
            ? copy.scheduleRan
            : record.type === 'schedule.created'
              ? copy.createdSchedule
              : record.type === 'schedule.paused'
                ? copy.pausedSchedule
                : record.type === 'schedule.resumed'
                  ? copy.resumedSchedule
                  : copy.canceledSchedule;
      return { action, target: name };
    }
    case 'tool.settled': {
      if (!isGatedToolRecord(record)) return undefined;
      const review = lookups.reviews.get(reviewIdOf(record) ?? '');
      const tool = toolTitle(record, lookups);
      const callLabel = callLabelOf(review);
      const summary = summaryOf(review);
      if (text(record, 'status') === 'paused') {
        return {
          action:
            summary === undefined
              ? copy.askedToUse(tool)
              : copy.askedTo(lowerFirst(withoutAmount(summary))),
          target: callLabel === undefined ? tool : `${tool} · ${callLabel}`,
        };
      }
      // What the call was worth, then the tool; with no amount, what it was about.
      const amount = amountOf(summary);
      const detail = amount ?? callLabel;
      return {
        // The tool's own sentence in the past ("Refunded order 4472") when its review can be read.
        action:
          summary !== undefined && text(record, 'status') === 'success'
            ? pastTense(withoutAmount(summary))
            : copy.ranTool(tool),
        target: detail === undefined ? tool : `${detail} · ${tool}`,
      };
    }
    case 'review.tool-approval.approved':
    case 'review.tool-approval.denied': {
      const review = lookups.reviews.get(reviewIdOf(record) ?? '');
      const tool = toolTitle(record, lookups);
      const callLabel = callLabelOf(review);
      return {
        action:
          record.type === 'review.tool-approval.approved'
            ? copy.approvedToolCall
            : copy.deniedToolCall,
        target: callLabel === undefined ? tool : `${tool} · ${callLabel}`,
      };
    }
    case 'memory.corrected':
    case 'memory.forgotten': {
      const memoryId = text(record, 'memoryId');
      const memory = memoryId === undefined ? undefined : lookups.memories.get(memoryId);
      return {
        action: record.type === 'memory.corrected' ? copy.correctedMemory : copy.forgotMemory,
        target:
          memory === undefined
            ? agent === undefined
              ? ''
              : lookups.agentName(agent)
            : `“${memory}”`,
      };
    }
    case 'agent.updated': {
      const revision = numberOf(record, 'revision');
      const previous = numberOf(record, 'previousRevision');
      const name = resourceName(record.resource, lookups);
      return {
        action: copy.editedAgent,
        target: `${name} · ${copy.versionRange(previous, revision)}`,
      };
    }
    case 'workflow.created':
    case 'workflow.updated':
      return {
        action: record.type === 'workflow.created' ? copy.createdWorkflow : copy.editedWorkflow,
        target: resourceName(record.resource, lookups),
      };
    case 'hook.created':
    case 'hook.updated':
      return {
        action: record.type === 'hook.created' ? copy.createdHook : copy.editedHook,
        target: text(record, 'hookId') ?? record.resource,
      };
    case 'session.deleted':
      return { action: copy.deletedChat, target: copy.chatTargetDeleted };
    case 'storage.key.deleted':
      return {
        action: copy.deletedStorageKey,
        target: copy.storageTarget(record.resource.replace(/^storage:/, '')),
      };
    case 'tool.source.connected':
    case 'tool.source.removed':
      return {
        action:
          record.type === 'tool.source.connected'
            ? copy.connectedToolSource
            : copy.removedToolSource,
        target: text(record, 'sourceId') ?? record.resource.replace(/^tool-source:/, ''),
      };
    case 'skill.source.trusted':
      return {
        action: copy.trustedSkillSource,
        target: text(record, 'sourceId') ?? record.resource,
      };
    case 'settings.changed':
      return { action: copy.changedSettings, target: record.resource };
    case 'webhook.delivery.exhausted':
      return { action: copy.webhookGaveUp, target: text(record, 'hookId') ?? record.resource };
    default:
      return undefined;
  }
}

/**
 * The event a record is, or `undefined` when it is not one the log lists: a step of a run, a tool
 * that ran without asking, a type the page has no wording for.
 */
export function describeRecord(
  record: AuditRecord,
  lookups: AuditLookups,
  newestRuns?: ReadonlySet<string>,
): AuditEvent | undefined {
  const kind = AUDIT_EVENT_KINDS.get(record.type);
  if (kind === undefined) return undefined;
  const wording = wordingOf(record, lookups, newestRuns);
  if (wording === undefined) return undefined;
  const actor = actorOf(record, lookups);
  const at = Date.parse(record.timestamp);
  return {
    key: recordKey(record),
    record,
    at,
    actor,
    action: wording.action,
    target: wording.target,
    title: wording.title ?? `${actor.name} ${lowerFirst(wording.action)}`,
    kind,
  };
}

/** The keys of the `run.started` records that are the newest of their chat, whatever order `records` come in. */
function newestRunOfEachChat(records: readonly AuditRecord[]): ReadonlySet<string> {
  const newest = new Map<string, AuditRecord>();
  for (const record of records) {
    const sessionId = text(record, 'sessionId');
    if (record.type !== 'run.started' || sessionId === undefined) continue;
    const held = newest.get(sessionId);
    if (
      held === undefined ||
      Date.parse(record.timestamp) > Date.parse(held.timestamp) ||
      (record.timestamp === held.timestamp && (record.sequence ?? 0) > (held.sequence ?? 0))
    ) {
      newest.set(sessionId, record);
    }
  }
  return new Set([...newest.values()].map(recordKey));
}

/** The events of a trail's records, in the trail's order. */
export function describeRecords(
  records: readonly AuditRecord[],
  lookups: AuditLookups,
): AuditEvent[] {
  const newestRuns = newestRunOfEachChat(records);
  return records.flatMap((record) => {
    const event = describeRecord(record, lookups, newestRuns);
    return event === undefined ? [] : [event];
  });
}

/**
 * The events a Who choice and a search keep: the actor's kind, and the text anywhere in the actor,
 * the action or the target, whatever its case.
 */
export function narrowEvents(
  events: readonly AuditEvent[],
  actor: AuditActorFilter | '',
  query: string,
): AuditEvent[] {
  const wanted = query.trim().toLowerCase();
  return events.filter((event) => {
    if (actor === 'you' && event.actor.kind !== 'you') return false;
    if (actor === 'agents' && event.actor.kind !== 'agent') return false;
    if (actor === 'interborough' && event.actor.kind !== 'host') return false;
    return (
      wanted === '' ||
      `${event.actor.name} ${event.action} ${event.target}`.toLowerCase().includes(wanted)
    );
  });
}

/** The record types whose events name a chat, a review or a memory the page needs to look up. */
export interface AuditLookupRequests {
  readonly sessionIds: readonly string[];
  readonly reviewIds: readonly string[];
  readonly scheduleIds: readonly string[];
  readonly memories: readonly { readonly agent: string; readonly id: string }[];
}

/** What the records ask the page to look up, so it reads exactly those. */
export function lookupRequestsFor(records: readonly AuditRecord[]): AuditLookupRequests {
  const sessionIds = new Set<string>();
  const reviewIds = new Set<string>();
  const scheduleIds = new Set<string>();
  const memories = new Map<string, { agent: string; id: string }>();
  for (const record of records) {
    if (!AUDIT_EVENT_KINDS.has(record.type)) continue;
    const sessionId = text(record, 'sessionId');
    if (sessionId !== undefined && record.type !== 'schedule.fired') sessionIds.add(sessionId);
    if (
      record.type === 'review.tool-approval.approved' ||
      record.type === 'review.tool-approval.denied' ||
      (record.type === 'tool.settled' && isGatedToolRecord(record))
    ) {
      const reviewId = reviewIdOf(record);
      if (reviewId !== undefined) reviewIds.add(reviewId);
    }
    if (record.type.startsWith('schedule.')) {
      scheduleIds.add(text(record, 'scheduleId') ?? splitResource(record.resource).id);
    }
    const memoryId = text(record, 'memoryId');
    const agent = text(record, 'agentName');
    if (record.type.startsWith('memory.') && memoryId !== undefined && agent !== undefined) {
      memories.set(memoryId, { agent, id: memoryId });
    }
  }
  return {
    sessionIds: [...sessionIds],
    reviewIds: [...reviewIds],
    scheduleIds: [...scheduleIds],
    memories: [...memories.values()],
  };
}

/** The time of a table row: "10:45 AM". */
export function clockOf(at: number): string {
  return formatTimeOfDay(at);
}

/** "Thu Oct 29": the weekday, month and day, with no comma, as the log's day headings read. */
function calendarDay(at: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).formatToParts(new Date(at));
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('weekday')} ${read('month')} ${read('day')}`;
}

/** The day a group of rows is under: "today", "yesterday", or the day. */
export function dayGroupOf(
  at: number,
  now: number,
): { readonly key: string; readonly label: string; readonly detail: string } {
  const label = formatDateTime(at, { now, dayWords: true });
  const detail = formatTimeZoneLabel(at, { style: 'long' });
  const key = calendarDay(at);
  if (label.startsWith('Today, ')) {
    const date = formatDate(at, 'en-US', { month: 'short', day: 'numeric' });
    return { key, label: AUDIT_COPY.dayHeading.today(date), detail };
  }
  if (label.startsWith('Yesterday, ')) {
    return { key, label: AUDIT_COPY.dayHeading.yesterday(key), detail };
  }
  return { key, label: key, detail };
}

/** "Today at 10:45:12 AM", "Yesterday at 4:12:00 PM" or "Thu Oct 29 at 7:40:12 AM". */
export function whenOf(at: number, now: number): string {
  const day = formatDateTime(at, { now, dayWords: true }).split(', ')[0] ?? '';
  const clock = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
    .format(new Date(at))
    .replace(/[  ]/g, ' ');
  return `${day === 'Today' || day === 'Yesterday' ? day : calendarDay(at)} at ${clock}`;
}
