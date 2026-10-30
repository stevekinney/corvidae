/**
 * The chat spend ledger (COR-1915): what each run of a chat spent, so an agent file's
 * `costBudget.perChatUsd` can stop the run that follows the one that passed it.
 *
 * ## Keys
 *
 * `bureau-chat-spend:v1:<sessionId>:<runId>` holds one {@link ChatSpendRecord} per run, both
 * components percent-encoded, so a chat's records are one prefix scan and no session id can be the
 * prefix of another's. Every record carries the owner of the chat's run (`owner`) and the session
 * incarnation it was written in: a chat deleted and recreated under the same id is a new chat, and
 * the total of the new one ignores its predecessor's records.
 *
 * ## The write fence
 *
 * A run's record is written after the run's terminal event and after the session has recorded how
 * the run ended, never before, and it is written once: the write is a compare-and-swap that
 * creates the key only if it is absent. A terminal event a recovery replays, a second process that
 * holds a copy of the run, and a write that is retried all find the key and change nothing, so a
 * run is never counted twice. A record that cannot be written after its retries is diagnosed and
 * the run is not counted (the chat's total then falls short by that run); a total that cannot be
 * read is an error, so a chat whose spend cannot be known does not start a run.
 *
 * Two runs that start in one chat before either has ended both read a total under the limit and
 * both run: the limit stops the run that follows, not one that has begun (the owner's decision),
 * so the chat can end past `perChatUsd` by what those runs spent.
 *
 * @module chat-spend-ledger
 */

import {
  type ConditionalTextValueStore,
  encodeStorageKeyComponent,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';

import { serializeUnknownError } from './serialization';
import type { DiagnosticSink } from './types';

/** The key prefix of a run's spend record. */
export const CHAT_SPEND_KEY_PREFIX = 'bureau-chat-spend:v1:';

/** How many times a record's write is tried before it is given up and diagnosed. */
const RECORD_ATTEMPTS = 3;

/** What one run of a chat spent. */
export interface ChatSpendRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  /** The session incarnation the run ran in. */
  readonly incarnation: string;
  readonly runId: string;
  readonly agentName: string;
  /** The owner of the run, which is the owner of the chat. */
  readonly owner: string;
  /** The run's cost estimate in US dollars, from its terminal result. */
  readonly usd: number;
  /** When the spend was recorded, as an ISO timestamp. */
  readonly recordedAt: string;
}

/** The chat spend ledger. */
export interface ChatSpendLedger {
  /**
   * Records a run's spend once. Resolves `true` when this call wrote the record and `false` when
   * the run was already recorded or the write was given up after its retries (diagnosed).
   */
  record(input: Omit<ChatSpendRecord, 'schemaVersion'>): Promise<boolean>;
  /**
   * What the runs of `sessionId`'s `incarnation` have spent, in US dollars. Rejects when a record
   * cannot be read, because a total that is too low would let a chat past its limit.
   */
  totalOf(sessionId: string, incarnation: string): Promise<number>;
  /**
   * Removes the records of `sessionId`'s `incarnation`, for a chat that was deleted. A record of
   * another incarnation, a chat recreated under the id, is left. Resolves how many it removed.
   */
  forget(sessionId: string, incarnation: string): Promise<number>;
}

/** Options for {@link createChatSpendLedger}. */
export interface CreateChatSpendLedgerOptions {
  /** The Bureau's key-value store. Absent, the ledger keeps its records in memory. */
  readonly kv?: ConditionalTextValueStore | undefined;
  readonly diagnose: DiagnosticSink;
}

function sessionPrefix(sessionId: string): string {
  return `${CHAT_SPEND_KEY_PREFIX}${encodeStorageKeyComponent(sessionId)}:`;
}

function recordKey(sessionId: string, runId: string): string {
  return `${sessionPrefix(sessionId)}${encodeStorageKeyComponent(runId)}`;
}

function readRecord(key: string, raw: string): ChatSpendRecord {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (value as { usd?: unknown }).usd !== 'number' ||
    !Number.isFinite((value as { usd: number }).usd) ||
    typeof (value as { incarnation?: unknown }).incarnation !== 'string'
  ) {
    throw new Error(`The chat spend record at "${key}" is not a version 1 record.`);
  }
  return value as ChatSpendRecord;
}

/** Creates the ledger. */
export function createChatSpendLedger(options: CreateChatSpendLedgerOptions): ChatSpendLedger {
  const kv = options.kv ?? textValueStore(new MemoryStorage());
  return {
    async record(input) {
      // Read before the first await: the caller owns `input` and may reuse it.
      const { sessionId, runId, usd } = input;
      const key = recordKey(sessionId, runId);
      const body = JSON.stringify({ schemaVersion: 1, ...input } satisfies ChatSpendRecord);
      let lastError: unknown;
      for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt += 1) {
        try {
          return await kv.conditionalBatch(
            [{ key, expectedValue: null }],
            [{ type: 'set', key, value: body }],
          );
        } catch (error) {
          lastError = error;
        }
      }
      options.diagnose({
        level: 'error',
        scope: 'chat-spend',
        message: `[bureau] Could not record the $${usd} that run "${runId}" spent in chat "${sessionId}"; the chat's total falls short by that much: ${serializeUnknownError(lastError)}`,
        cause: lastError,
      });
      return false;
    },
    async totalOf(sessionId, incarnation) {
      let total = 0;
      for (const key of await kv.list(sessionPrefix(sessionId))) {
        const raw = await kv.get(key);
        if (raw === null) continue;
        const record = readRecord(key, raw);
        if (record.incarnation === incarnation) total += record.usd;
      }
      return total;
    },
    async forget(sessionId, incarnation) {
      let removed = 0;
      for (const key of await kv.list(sessionPrefix(sessionId))) {
        const raw = await kv.get(key);
        if (raw === null || readRecord(key, raw).incarnation !== incarnation) continue;
        await kv.delete(key);
        removed += 1;
      }
      return removed;
    },
  };
}
