/**
 * What a reply's model saw, kept with the reply (COR-1810).
 *
 * An {@link EffectiveContextRecord} is the effective-context epoch of the generate attempt that
 * produced a step (`./context-epoch`), flattened to digests and identifiers so it can ride on the
 * step's checkpoint record: the epoch's sources with their dispositions, revisions and digests
 * (steering included), and the conversation's messages as an id, a role and a digest of the
 * content. It never carries a message's content, a prompt, or a tool argument.
 *
 * It is bounded. A conversation can run to thousands of messages, so the record is capped at
 * {@link EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES} of JSON. Over the cap it keeps the newest messages,
 * which are the ones nearest the reply, and says so with `truncated`.
 *
 * @module effective-context-record
 */

import type { Conversation, Message } from 'conversationalist';

import { digestText, type ContextSourceRecord, type EffectiveContextEpoch } from './context-epoch';

/** The most JSON a stored {@link EffectiveContextRecord} may take: 256 KiB. */
export const EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES = 256 * 1024;

/** One conversation message as the record keeps it: who said it, which row it is, and a digest of what it said. */
export interface EffectiveContextMessage {
  /** The row's id in the conversation. */
  readonly id: string;
  /** The row's role. */
  readonly role: string;
  /** A digest of the row's content, never the content. */
  readonly digest: string;
}

/** One context source as the record keeps it. */
export interface EffectiveContextSource {
  /** The source's identity, such as `conversation`, `steering-desired`, or `toolbox`. */
  readonly sourceId: string;
  /** What the source's content may be trusted as. */
  readonly trust: string;
  /** `included`, `excluded`, or `absent-by-composition` (the run never configured the source). */
  readonly disposition: 'included' | 'excluded' | 'absent-by-composition';
  /** Why the source was excluded, when it was. */
  readonly reason?: string | undefined;
  /** The source's own version, when it has one. */
  readonly revision?: number | string | undefined;
  /** A digest of the source's content, when its redaction policy permits one. */
  readonly digest?: string | undefined;
}

/** The effective context of the generate attempt that produced a step. */
export interface EffectiveContextRecord {
  /** The epoch this record flattens; absent for a run that seals no epochs, so the record names none. */
  readonly epochId?: string | undefined;
  /** The epoch it replaced, when it replaced one. */
  readonly supersedes?: string | undefined;
  /** A digest of the rendered provider baseline. */
  readonly baselineDigest: string;
  /** The sources that produced the turn, steering included. */
  readonly sources: readonly EffectiveContextSource[];
  /** The conversation's messages, oldest first; the newest ones only when `truncated`. */
  readonly messages: readonly EffectiveContextMessage[];
  /** How many messages the conversation held, which is more than `messages.length` when `truncated`. */
  readonly messageCount: number;
  /** Whether older messages were left out to keep the record within {@link EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES}. */
  readonly truncated: boolean;
}

function sourceOf(source: ContextSourceRecord): EffectiveContextSource {
  const { disposition } = source;
  return {
    sourceId: source.sourceId,
    trust: source.trust,
    disposition: disposition.kind,
    ...(disposition.kind === 'excluded' ? { reason: disposition.reason } : {}),
    ...(source.revision === undefined ? {} : { revision: source.revision }),
    ...(source.digest === undefined ? {} : { digest: source.digest }),
  };
}

function messageOf(message: Message): EffectiveContextMessage {
  const content =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  return { id: message.id, role: message.role, digest: digestText(content) };
}

const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

type RecordBase = Omit<EffectiveContextRecord, 'messages' | 'truncated'>;

/**
 * The newest of `all` that fit in `limit` bytes of JSON beside `base`, oldest first. `truncated` is
 * set when fewer than `base.messageCount` messages remain.
 */
function fitMessages(
  base: RecordBase,
  all: readonly EffectiveContextMessage[],
  limit: number,
): EffectiveContextRecord {
  // Sized with `truncated: true`, the longer spelling, so the fitted record can only come in under the limit.
  let remaining = limit - byteLength({ ...base, messages: [], truncated: true });
  let kept = 0;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    // One byte for the comma between entries.
    const cost = byteLength(all[index]) + 1;
    if (cost > remaining) break;
    remaining -= cost;
    kept += 1;
  }
  return {
    ...base,
    messages: all.slice(all.length - kept),
    truncated: kept < base.messageCount,
  };
}

/**
 * Flatten a sealed epoch and the conversation it was sealed over into a record of at most `limit`
 * bytes of JSON. Over the limit the oldest messages are left out until it fits, `truncated` is set,
 * and `messageCount` still says how many the conversation held.
 */
export function composeEffectiveContextRecord(
  epoch: Omit<EffectiveContextEpoch, 'epochId'> & { readonly epochId?: string | undefined },
  conversation: Conversation,
  limit: number = EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES,
): EffectiveContextRecord {
  const all = conversation.getMessages().map(messageOf);
  const base: RecordBase = {
    ...(epoch.epochId === undefined ? {} : { epochId: epoch.epochId }),
    ...(epoch.supersedes === undefined ? {} : { supersedes: epoch.supersedes }),
    baselineDigest: epoch.baselineDigest,
    sources: epoch.sources.map(sourceOf),
    messageCount: all.length,
  };
  return fitMessages(base, all, limit);
}

/**
 * One step's effective context as the run's checkpoint stores it (COR-1810): the record without
 * the messages the previous step already stored. A step's context holds the whole conversation, so
 * storing it whole would make every step's write grow with the conversation (COR-1376). A delta
 * holds the epoch's sources, `messageCount` and `baselineDigest` (a digest over the rendered
 * conversation), and only the messages from `messagesFrom` on.
 */
export interface EffectiveContextDelta extends Omit<
  EffectiveContextRecord,
  'messages' | 'truncated'
> {
  /**
   * The conversation index of `messages[0]`. Messages before it are the previous steps' (a read
   * keeps what the earlier deltas stored up to this index, then appends `messages`).
   */
  readonly messagesFrom: number;
  /** The messages from `messagesFrom` on, oldest first. */
  readonly messages: readonly EffectiveContextMessage[];
}

/** The step a run-scoped message id (`<runId>:step:<n>` and its `:call:` and `:result:` rows) belongs to. */
function stepOfMessageId(runId: string, id: string): number | undefined {
  const prefix = `${runId}:step:`;
  if (!id.startsWith(prefix)) return undefined;
  const digits = /^\d+/.exec(id.slice(prefix.length))?.[0];
  return digits === undefined ? undefined : Number(digits);
}

/** How many earlier steps' rows are looked for before a delta gives up and keeps every message it holds. */
const PREVIOUS_STEP_LOOKBACK = 8;

/**
 * The delta of `record`, the effective context of `step` of run `runId`: the messages from the
 * first row the most recent earlier step committed (that step sealed its context before committing
 * its reply, so everything before that row it had already stored). A step with no such row in the
 * record, such as the first, keeps every message the record holds, which `record` already caps.
 */
export function toEffectiveContextDelta(
  record: EffectiveContextRecord,
  runId: string,
  step: number,
): EffectiveContextDelta {
  const { messages, truncated: _truncated, ...rest } = record;
  const offset = record.messageCount - messages.length;
  const earliest = Math.max(0, step - PREVIOUS_STEP_LOOKBACK);
  let start = 0;
  let found = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const owner = stepOfMessageId(runId, messages[index]!.id);
    if (owner === undefined || owner >= step || owner < earliest) continue;
    if (owner > found) {
      found = owner;
      start = index;
    }
  }
  return { ...rest, messagesFrom: offset + start, messages: messages.slice(start) };
}

/**
 * Rebuild each step's whole effective context from the deltas the steps stored, in step order, and
 * cap each at `limit` bytes as {@link composeEffectiveContextRecord} does. A step stored without
 * one reads `undefined`. `wanted` skips the cap, which costs a pass over the messages, for steps
 * the caller will not show.
 */
export function rebuildEffectiveContexts(
  deltas: readonly (EffectiveContextDelta | undefined)[],
  wanted: (index: number) => boolean = () => true,
  limit: number = EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES,
): (EffectiveContextRecord | undefined)[] {
  let held: EffectiveContextMessage[] = [];
  // The conversation index of held[0]: what no delta stored is simply absent.
  let heldFrom = 0;
  return deltas.map((delta, index) => {
    if (delta === undefined) return undefined;
    const keep = delta.messagesFrom - heldFrom;
    if (keep < 0 || keep > held.length) {
      held = [];
      heldFrom = delta.messagesFrom;
    } else {
      held.length = keep;
    }
    held.push(...delta.messages);
    if (!wanted(index)) return undefined;
    const { messagesFrom: _from, messages: _messages, ...base } = delta;
    return fitMessages(base, held, limit);
  });
}
