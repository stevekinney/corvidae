/**
 * The chat spend ledger (COR-1915): what each run of a chat spent, so an agent file's
 * `costBudget.perChatUsd` can stop the run that follows the one that passed it.
 *
 * ## Keys
 *
 * `bureau-chat-spend:v2:<sessionId>:<incarnation>:<runId>` holds one {@link ChatSpendRecord} per
 * run, every component percent-encoded, so one incarnation's records are one prefix scan and no
 * component can be the prefix of another's. A chat deleted and recreated under the same id is a new
 * chat with another incarnation: the total of the new one ignores its predecessor's records, and
 * deleting a chat removes its incarnation's prefix, a record written after the deletion included.
 * Every record also carries the owner of the chat's run (`owner`) and its incarnation.
 *
 * The key changed in COR-1933 from `bureau-chat-spend:v1:<sessionId>:<runId>`, which kept the
 * incarnation in the value alone and so could not be removed by prefix. Nothing migrates a `v1`
 * record (the feature is pre-release): the total no longer counts one, and {@link
 * ChatSpendLedger.forget} still removes the `v1` records of the incarnation it is asked about.
 *
 * ## The write fence
 *
 * A run's record is written after the run's terminal event and BEFORE the session records how the
 * run ended (COR-1933), and it is written once: the write is a compare-and-swap that creates the
 * key only if it is absent. A terminal event a recovery replays, a second process that holds a
 * copy of the run, and a write that is retried all find the key and change nothing, so a run is
 * never counted twice. The order is what makes a crash repairable: a process that dies after the
 * ledger write and before the session save leaves the session `running`, so recovery reattaches
 * the run and replays its terminal event into a ledger that already holds the record, and one
 * that dies before the ledger write replays it into one that does not. Written the other way
 * round, a crash between the two left a session that said the run had ended, which recovery never
 * reattaches, and the run's spend unrecorded. A record that cannot be written after its retries
 * is diagnosed and the run is not counted (the chat's total then falls short by that run); a
 * total that cannot be read is an error, so a chat whose spend cannot be known does not start a
 * run.
 *
 * ## Spend that is not recorded
 *
 * - A run cancelled from another process (`cancelDurableRun` on a Bureau that does not hold the
 *   run, COR-1580) is ended by the canceller, which writes the session's `aborted` status. The
 *   canceller holds no cost estimate (the run's pricing and checkpoint are the holder's), and the
 *   holder, seeing another engine's terminal commit, writes nothing (COR-1614), so no one records
 *   what that run had spent. The chat's total falls short by it.
 * - A run that never reaches its terminal event, such as a non-durable run in a process that
 *   dies, has no estimate to record. A durable run is recovered and records its spend when it ends.
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
export const CHAT_SPEND_KEY_PREFIX = 'bureau-chat-spend:v2:';

/** The prefix of the records the ledger kept before the incarnation was part of the key (COR-1933). */
const LEGACY_CHAT_SPEND_KEY_PREFIX = 'bureau-chat-spend:v1:';

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
   * Removes the records of `sessionId`'s `incarnation`, for a chat that was deleted: one prefix
   * delete, so a record written afterwards is removed by calling it again. A record of another
   * incarnation, a chat recreated under the id, is left. Resolves how many it removed.
   */
  forget(sessionId: string, incarnation: string): Promise<number>;
}

/** Options for {@link createChatSpendLedger}. */
export interface CreateChatSpendLedgerOptions {
  /** The Bureau's key-value store. Absent, the ledger keeps its records in memory. */
  readonly kv?: ConditionalTextValueStore | undefined;
  readonly diagnose: DiagnosticSink;
}

function incarnationPrefix(sessionId: string, incarnation: string): string {
  return `${CHAT_SPEND_KEY_PREFIX}${encodeStorageKeyComponent(sessionId)}:${encodeStorageKeyComponent(incarnation)}:`;
}

function recordKey(sessionId: string, incarnation: string, runId: string): string {
  return `${incarnationPrefix(sessionId, incarnation)}${encodeStorageKeyComponent(runId)}`;
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
      const { sessionId, incarnation, runId, usd } = input;
      const key = recordKey(sessionId, incarnation, runId);
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
      for (const key of await kv.list(incarnationPrefix(sessionId, incarnation))) {
        const raw = await kv.get(key);
        if (raw === null) continue;
        total += readRecord(key, raw).usd;
      }
      return total;
    },
    async forget(sessionId, incarnation) {
      let removed = await kv.deletePrefix(incarnationPrefix(sessionId, incarnation));
      // A `v1` record names its incarnation in the value only, so it is found by reading.
      const legacyPrefix = `${LEGACY_CHAT_SPEND_KEY_PREFIX}${encodeStorageKeyComponent(sessionId)}:`;
      for (const key of await kv.list(legacyPrefix)) {
        const raw = await kv.get(key);
        if (raw === null || readRecord(key, raw).incarnation !== incarnation) continue;
        await kv.delete(key);
        removed += 1;
      }
      return removed;
    },
  };
}
