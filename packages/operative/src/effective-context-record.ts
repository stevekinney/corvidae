/**
 * What a reply's model saw, kept with the reply (COR-1810).
 *
 * An {@link EffectiveContextRecord} is the effective-context epoch of the generate attempt that
 * produced a step (`./context-epoch`), flattened to digests and identifiers so it can ride on the
 * step's checkpoint record: the epoch's sources with their dispositions, revisions and digests
 * (steering included), and the conversation's messages as an id, a role and a digest of what the
 * provider is sent for the row (its content, and a tool row's call or result). It never carries a
 * message's content, a prompt, or a tool argument.
 *
 * It is bounded. A conversation can run to thousands of messages, so the record is capped at
 * {@link EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES} of JSON. Over the cap it keeps the newest messages,
 * which are the ones nearest the reply, and says so with `truncated`.
 *
 * A durable run stores it per step as a {@link StoredEffectiveContext}: whole (`full`) when the
 * conversation is not the previous stored step's with rows added, and otherwise as the rows added
 * (`delta`), tied by digest to the conversation it extends. {@link rebuildEffectiveContexts} reads
 * them back.
 *
 * @module effective-context-record
 */

import { sha256HexSync } from '@lostgradient/cryptography';
import type { Conversation, Message } from 'conversationalist';

import { digestText, type ContextSourceRecord, type EffectiveContextEpoch } from './context-epoch';

/** The most JSON a stored {@link EffectiveContextRecord} may take: 256 KiB. */
export const EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES = 256 * 1024;

/**
 * The version of the {@link StoredEffectiveContext} format, which also pins how its digests are
 * computed: a message's `digest` and the `conversationDigest` and `prefixDigest` over messages.
 */
export const STORED_EFFECTIVE_CONTEXT_VERSION = 1;

/** One conversation message as the record keeps it: who said it, which row it is, and a digest of what it said. */
export interface EffectiveContextMessage {
  /** The row's id in the conversation. */
  readonly id: string;
  /** The row's role. */
  readonly role: string;
  /** A digest of what the provider is sent for the row (its content, and its tool call or result), never the content. */
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

/** What every {@link StoredEffectiveContext} carries besides its messages. */
interface StoredEffectiveContextBase extends Omit<
  EffectiveContextRecord,
  'messages' | 'truncated'
> {
  /** The format version, {@link STORED_EFFECTIVE_CONTEXT_VERSION}. A reader skips any other. */
  readonly version: typeof STORED_EFFECTIVE_CONTEXT_VERSION;
  /**
   * A digest over every message of the conversation, oldest first, including any a `full` record
   * left out: `sha256:` and the SHA-256 of the JSON array of each message's `[id, role, digest]`.
   */
  readonly conversationDigest: string;
}

/** A step's effective context stored whole, capped as {@link EffectiveContextRecord} is. A reader starts from it. */
export interface StoredEffectiveContextFull extends StoredEffectiveContextBase {
  /** Stored whole. */
  readonly kind: 'full';
  /** The conversation's messages, oldest first; the newest ones only when `truncated`. */
  readonly messages: readonly EffectiveContextMessage[];
  /** Whether older messages were left out to keep the stored record within the cap. */
  readonly truncated: boolean;
}

/**
 * A step's effective context stored as the rows added to the conversation the previous stored step
 * saw. It holds only when that conversation is this one's first `messagesFrom` messages, which
 * `prefixDigest` attests.
 */
export interface StoredEffectiveContextDelta extends StoredEffectiveContextBase {
  /** Stored as the rows added since the previous stored step. */
  readonly kind: 'delta';
  /** The conversation index of `messages[0]`: how many messages the previous stored step saw. */
  readonly messagesFrom: number;
  /**
   * The digest, computed as `conversationDigest` is, over this conversation's first `messagesFrom`
   * messages. It equals the previous stored step's `conversationDigest`; a reader applies the delta
   * only to a conversation with that digest.
   */
  readonly prefixDigest: string;
  /** The messages from `messagesFrom` on, oldest first. */
  readonly messages: readonly EffectiveContextMessage[];
}

/**
 * One step's effective context as a durable run's checkpoint stores it (COR-1810). A record stored
 * whole on every step would make each step's write grow with the conversation (COR-1376), so a step
 * whose conversation extends the previous stored step's stores only the added rows.
 */
export type StoredEffectiveContext = StoredEffectiveContextFull | StoredEffectiveContextDelta;

/** What the next step needs of the previous stored step's context to store a delta from it. */
export interface EffectiveContextTail {
  /** How many messages the previous stored step's conversation held. */
  readonly messageCount: number;
  /** That conversation's {@link StoredEffectiveContextBase.conversationDigest}. */
  readonly conversationDigest: string;
}

/** A step's effective context: the record a run reports, and the form a durable run stores. */
export interface ComposedEffectiveContext {
  /** The record `StepResult.effectiveContext` carries. */
  readonly record: EffectiveContextRecord;
  /** The form the step's checkpoint record stores. */
  readonly stored: StoredEffectiveContext;
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

/**
 * A row's digest covers what the provider is sent for it. A tool call's or result's row keeps its
 * payload in `toolCall` or `toolResult` beside an empty `content`, so a digest of the content alone
 * would be the same for every tool row.
 */
function messageOf(message: Message): EffectiveContextMessage {
  const content =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  const sent =
    message.toolCall === undefined && message.toolResult === undefined
      ? content
      : JSON.stringify([content, message.toolCall ?? null, message.toolResult ?? null]);
  return { id: message.id, role: message.role, digest: digestText(sent) };
}

/** The `conversationDigest` of `messages`. */
function digestMessages(messages: readonly EffectiveContextMessage[]): string {
  const entries = messages.map((message) => [message.id, message.role, message.digest]);
  return `sha256:${sha256HexSync(JSON.stringify(entries))}`;
}

const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

type FullBase = Omit<StoredEffectiveContextFull, 'kind' | 'messages' | 'truncated'>;

/**
 * The newest of `held` that fit in `limit` bytes of JSON beside `base`, stored whole. `held` are
 * the conversation's messages from index `base.messageCount - held.length`; `truncated` is set when
 * fewer than `base.messageCount` messages remain.
 */
function fitFull(
  base: FullBase,
  held: readonly EffectiveContextMessage[],
  limit: number,
): StoredEffectiveContextFull {
  const { version, ...rest } = base;
  const empty = { version, kind: 'full' as const, ...rest, messages: [], truncated: true };
  // Sized with `truncated: true`, the longer spelling, so the fitted record can only come in under the limit.
  let remaining = limit - byteLength(empty);
  let kept = 0;
  for (let index = held.length - 1; index >= 0; index -= 1) {
    // One byte for the comma between entries.
    const cost = byteLength(held[index]) + 1;
    if (cost > remaining) break;
    remaining -= cost;
    kept += 1;
  }
  return {
    ...empty,
    messages: held.slice(held.length - kept),
    truncated: kept < base.messageCount,
  };
}

/** The record a stored full one describes. */
function recordOf(full: StoredEffectiveContextFull): EffectiveContextRecord {
  const { version: _version, kind: _kind, conversationDigest: _digest, ...record } = full;
  return record;
}

/**
 * Flatten a sealed epoch and the conversation it was sealed over into a step's effective context:
 * the record, capped at `limit` bytes of JSON, and the form a durable run stores. `previous` is the
 * {@link EffectiveContextTail} of the run's previous stored step. When this conversation's first
 * `previous.messageCount` messages are that step's conversation (their digest equals its
 * `conversationDigest`), the stored form is a delta of the rows added since; otherwise, as after a
 * compaction, a redaction, or with no previous step, it is the record whole.
 */
export function composeEffectiveContext(
  epoch: Omit<EffectiveContextEpoch, 'epochId'> & { readonly epochId?: string | undefined },
  conversation: Conversation,
  previous?: EffectiveContextTail,
  limit: number = EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES,
): ComposedEffectiveContext {
  const all = conversation.getMessages().map(messageOf);
  const conversationDigest = digestMessages(all);
  const base: FullBase = {
    version: STORED_EFFECTIVE_CONTEXT_VERSION,
    ...(epoch.epochId === undefined ? {} : { epochId: epoch.epochId }),
    ...(epoch.supersedes === undefined ? {} : { supersedes: epoch.supersedes }),
    baselineDigest: epoch.baselineDigest,
    sources: epoch.sources.map(sourceOf),
    messageCount: all.length,
    conversationDigest,
  };
  const full = fitFull(base, all, limit);
  const record = recordOf(full);
  if (previous === undefined || previous.messageCount > all.length) return { record, stored: full };
  const prefixDigest =
    previous.messageCount === all.length
      ? conversationDigest
      : digestMessages(all.slice(0, previous.messageCount));
  if (prefixDigest !== previous.conversationDigest) return { record, stored: full };
  const { version, ...rest } = base;
  const delta: StoredEffectiveContextDelta = {
    version,
    kind: 'delta',
    ...rest,
    messagesFrom: previous.messageCount,
    prefixDigest,
    messages: all.slice(previous.messageCount),
  };
  // The rows added in one step can themselves exceed the cap; the capped whole record stands in.
  return { record, stored: byteLength(delta) <= limit ? delta : full };
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
  return composeEffectiveContext(epoch, conversation, undefined, limit).record;
}

/** The {@link EffectiveContextTail} the step after `stored` stores its delta from. */
export function effectiveContextTail(stored: StoredEffectiveContext): EffectiveContextTail {
  return { messageCount: stored.messageCount, conversationDigest: stored.conversationDigest };
}

/** What a stored record carries besides its messages, read field by field. */
function baseOf(stored: StoredEffectiveContext): FullBase {
  return {
    version: stored.version,
    ...(stored.epochId === undefined ? {} : { epochId: stored.epochId }),
    ...(stored.supersedes === undefined ? {} : { supersedes: stored.supersedes }),
    baselineDigest: stored.baselineDigest,
    sources: stored.sources,
    messageCount: stored.messageCount,
    conversationDigest: stored.conversationDigest,
  };
}

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isMessage(value: unknown): value is EffectiveContextMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message['id'] === 'string' &&
    typeof message['role'] === 'string' &&
    typeof message['digest'] === 'string'
  );
}

/**
 * Whether `value`, read back from a checkpoint, is a {@link StoredEffectiveContext} this build
 * reads: version {@link STORED_EFFECTIVE_CONTEXT_VERSION}, and messages that account for the
 * conversation they claim to.
 */
export function isStoredEffectiveContext(value: unknown): value is StoredEffectiveContext {
  if (typeof value !== 'object' || value === null) return false;
  const stored = value as Record<string, unknown>;
  const messages = stored['messages'];
  const messageCount = stored['messageCount'];
  if (
    stored['version'] !== STORED_EFFECTIVE_CONTEXT_VERSION ||
    typeof stored['conversationDigest'] !== 'string' ||
    typeof stored['baselineDigest'] !== 'string' ||
    !Array.isArray(stored['sources']) ||
    !isInteger(messageCount) ||
    !Array.isArray(messages) ||
    !messages.every(isMessage)
  ) {
    return false;
  }
  if (stored['kind'] === 'full') {
    return (
      typeof stored['truncated'] === 'boolean' &&
      messages.length <= messageCount &&
      (stored['truncated'] || messages.length === messageCount)
    );
  }
  return (
    stored['kind'] === 'delta' &&
    typeof stored['prefixDigest'] === 'string' &&
    isInteger(stored['messagesFrom']) &&
    stored['messagesFrom'] + messages.length === messageCount
  );
}

/**
 * Rebuild the whole effective context of each step `wanted` selects from the run's stored records,
 * in step order, capped at `limit` bytes as {@link composeEffectiveContextRecord} caps a record.
 *
 * It walks from the latest `full` record at or before the first wanted step. A delta extends the
 * conversation rebuilt so far only when its `prefixDigest` is that conversation's digest and its
 * `messagesFrom` is that conversation's length. Otherwise (a leftover record of a longer regenerated
 * run, a step stored without one before a compaction, or a record this build cannot read) the
 * conversation is known only from the delta's own rows on, and the step reads `truncated: true`
 * with the newest messages it does know. A record never reads as complete unless the messages it
 * returns have the conversation's digest.
 *
 * A step stored without a record, or with one this build cannot read, reads `undefined`.
 */
export function rebuildEffectiveContexts(
  stored: readonly unknown[],
  wanted: (index: number) => boolean = () => true,
  limit: number = EFFECTIVE_CONTEXT_RECORD_LIMIT_BYTES,
): (EffectiveContextRecord | undefined)[] {
  const result: (EffectiveContextRecord | undefined)[] = stored.map(() => undefined);
  const indexes = stored.flatMap((value, index) =>
    wanted(index) && isStoredEffectiveContext(value) ? [index] : [],
  );
  if (indexes.length === 0) return result;
  let start = indexes[0]!;
  const isFull = (value: unknown): boolean =>
    isStoredEffectiveContext(value) && value.kind === 'full';
  while (start > 0 && !isFull(stored[start])) start -= 1;
  // The conversation rebuilt so far: the messages from index `heldFrom` on of a conversation with
  // digest `heldDigest`, which a `full` record or the rows a mismatched delta stored can leave partial.
  let held: EffectiveContextMessage[] = [];
  let heldFrom = 0;
  let heldDigest: string | undefined;
  for (let index = start; index <= indexes.at(-1)!; index += 1) {
    const entry = stored[index];
    if (!isStoredEffectiveContext(entry)) {
      // A step stored without a record changes nothing; one this build cannot read breaks the chain.
      if (entry !== undefined) heldDigest = undefined;
      continue;
    }
    if (entry.kind === 'full') {
      held = [...entry.messages];
      heldFrom = entry.messageCount - entry.messages.length;
    } else if (heldDigest === entry.prefixDigest && heldFrom + held.length === entry.messagesFrom) {
      held.push(...entry.messages);
    } else {
      held = [...entry.messages];
      heldFrom = entry.messagesFrom;
    }
    heldDigest = entry.conversationDigest;
    if (!wanted(index)) continue;
    if (heldFrom === 0 && digestMessages(held) !== entry.conversationDigest) {
      // Unreachable from records this module wrote. A list that does not have its conversation's
      // digest is never returned as complete: the entry's own rows are kept when they are only the
      // newest, and none when they claim to be the whole conversation.
      const ownFrom = entry.messageCount - entry.messages.length;
      held = ownFrom === 0 ? [] : [...entry.messages];
      heldFrom = ownFrom === 0 ? entry.messageCount : ownFrom;
    }
    result[index] = recordOf(fitFull(baseOf(entry), held, limit));
  }
  return result;
}
