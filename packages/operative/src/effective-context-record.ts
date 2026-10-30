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
  const base = {
    ...(epoch.epochId === undefined ? {} : { epochId: epoch.epochId }),
    ...(epoch.supersedes === undefined ? {} : { supersedes: epoch.supersedes }),
    baselineDigest: epoch.baselineDigest,
    sources: epoch.sources.map(sourceOf),
    messageCount: all.length,
  };
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
  const truncated = kept < all.length;
  return { ...base, messages: all.slice(all.length - kept), truncated };
}
