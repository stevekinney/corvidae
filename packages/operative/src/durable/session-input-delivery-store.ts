import { type ConditionalTextValueStore, encodeStorageKeyComponent } from '@lostgradient/storage';

import { defineOwn } from '../define-own.ts';
import type { SessionInputDelivery, SessionInputPromotion } from './types';

/**
 * COR-1476 — the durable record of which run is delivering each admitted
 * session input, and of the promotion that completes it.
 *
 * ## One key per session, keyed by the mailbox command
 *
 * `session-input-deliveries:v1:{sessionId}` holds `{ [commandId]: record }`, and
 * is only ever written through `conditionalBatch`, so every writer (a claiming
 * gate, a releasing run, the checkpoint write that promotes) is fenced against
 * every other. Records are keyed by the mailbox COMMAND's identity, never by the
 * caller's input id: a caller may legitimately reuse an id once the mailbox has
 * retired the record, and a record keyed by that id would call a brand new input
 * already delivered.
 *
 * It lives in the same text-value store as the run's checkpoint, which is what
 * lets promotion commit in the SAME batch as the transcript that holds the input
 * ({@link planSessionInputPromotion}, used by the checkpoint store). Whether an
 * input is promoted is therefore a property of the durable transcript, not of a
 * second write that a cancellation can separate from it.
 *
 * ## Ownership follows the owning run's lifecycle
 *
 * A record names the run delivering the command. It stands while that run is
 * live: a crashed run's replay re-appends (its step never committed) or replays
 * (it did) and promotes. Another run's gate takes it over only when the owner is
 * reported not live, and a run releases its unpromoted records when it ends. An
 * unpromoted input is in no durable transcript, so releasing it is always safe.
 *
 * ## Pruning
 *
 * A record may be deleted only when its command can no longer be claimed by any
 * run and a replay of its caller's id is answered from the mailbox's retained
 * terminal record or as a fresh admission with a new command. Pruning happens
 * only inside the claim writer, never on a timer.
 */

/** One command's delivery state. */
export interface SessionInputDeliveryRecord {
  readonly runId: string;
  readonly claimedAt: string;
  readonly promotion?: SessionInputPromotion | undefined;
}

/** How a gate stands with one command after {@link SessionInputDeliveryStore.claim}. */
export type SessionInputDeliveryClaim = 'claimed' | 'owned' | 'taken-over' | 'promoted';

export type SessionInputDeliveryRecords = Record<string, SessionInputDeliveryRecord>;

const MAXIMUM_ATTEMPTS = 20;

export function sessionInputDeliveriesKey(sessionId: string): string {
  return `session-input-deliveries:v1:${encodeStorageKeyComponent(sessionId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): SessionInputDeliveryRecord | undefined {
  if (!isRecord(value) || typeof value['runId'] !== 'string') return undefined;
  if (typeof value['claimedAt'] !== 'string') return undefined;
  const promotion = value['promotion'];
  if (promotion === undefined) {
    return { runId: value['runId'], claimedAt: value['claimedAt'] };
  }
  if (
    !isRecord(promotion) ||
    typeof promotion['promotedAt'] !== 'string' ||
    typeof promotion['conversationMessageId'] !== 'string' ||
    typeof promotion['providerTurn'] !== 'number'
  ) {
    return undefined;
  }
  return {
    runId: value['runId'],
    claimedAt: value['claimedAt'],
    promotion: {
      promotedAt: promotion['promotedAt'],
      conversationMessageId: promotion['conversationMessageId'],
      providerTurn: promotion['providerTurn'],
    },
  };
}

/** Reads a stored deliveries value. A record that is not valid is corruption and throws. */
export function parseSessionInputDeliveries(raw: string | null): SessionInputDeliveryRecords {
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new TypeError('Stored session input deliveries are malformed.');
  const records: SessionInputDeliveryRecords = {};
  for (const [commandId, value] of Object.entries(parsed)) {
    const record = parseRecord(value);
    if (record === undefined) {
      throw new TypeError(`Stored session input delivery "${commandId}" is malformed.`);
    }
    defineOwn(records, commandId, record);
  }
  return records;
}

/**
 * The records still within retention as of `nowMs`. A record is as old as its
 * promotion, or its claim while it has none.
 */
export function pruneSessionInputDeliveries(
  records: SessionInputDeliveryRecords,
  nowMs: number,
  retentionMs: number,
): SessionInputDeliveryRecords {
  const retained: SessionInputDeliveryRecords = {};
  for (const [commandId, record] of Object.entries(records)) {
    const writtenAt = Date.parse(record.promotion?.promotedAt ?? record.claimedAt);
    if (Number.isNaN(writtenAt) || nowMs - writtenAt <= retentionMs) {
      defineOwn(retained, commandId, record);
    }
  }
  return retained;
}

/**
 * The records after `runId` promotes `deliveries`, or a throw when a delivery
 * cannot be promoted by this run. Each must be owned by `runId` and unpromoted
 * (promoted now) or already promoted by `runId` (left as it is). A missing or
 * foreign record means the run no longer owns the input, and the run fails
 * loudly rather than commit a transcript that disagrees with the record.
 */
export function planSessionInputPromotion(
  records: SessionInputDeliveryRecords,
  runId: string,
  deliveries: readonly SessionInputDelivery[],
): SessionInputDeliveryRecords {
  const next: SessionInputDeliveryRecords = { ...records };
  for (const delivery of deliveries) {
    const record = Object.hasOwn(records, delivery.commandId)
      ? records[delivery.commandId]
      : undefined;
    if (record === undefined || record.runId !== runId) {
      throw new Error(
        `Run "${runId}" cannot promote session input "${delivery.id}": ${
          record === undefined
            ? 'no run is recorded as delivering it'
            : `run "${record.runId}" owns it`
        }.`,
      );
    }
    if (record.promotion !== undefined) continue;
    defineOwn<SessionInputDeliveryRecord>(next, delivery.commandId, {
      ...record,
      promotion: {
        promotedAt: delivery.deliveredAt,
        conversationMessageId: delivery.conversationMessageId,
        providerTurn: delivery.providerTurn,
      },
    });
  }
  return next;
}

/** A command's promotion, or `undefined` when it has none. */
export async function readSessionInputPromotion(
  kv: Pick<ConditionalTextValueStore, 'get'>,
  sessionId: string,
  commandId: string,
): Promise<SessionInputPromotion | undefined> {
  const records = parseSessionInputDeliveries(await kv.get(sessionInputDeliveriesKey(sessionId)));
  return Object.hasOwn(records, commandId) ? records[commandId]?.promotion : undefined;
}

export interface SessionInputDeliveryStoreOptions {
  /** How long a record outlives its last write. */
  readonly retentionMs: number;
  readonly nowMs: () => number;
}

export interface SessionInputDeliveryStore {
  /**
   * Records `owner` as the run delivering each of `commandIds`, which are in
   * mailbox order, and reports the deliverable PREFIX of them: it stops at the
   * first command another run is delivering and is live, and writes no record
   * for it or anything behind it. A record whose owner is not live is taken over.
   */
  claim(
    sessionId: string,
    owner: string,
    commandIds: readonly string[],
    isOwnerLive: (runId: string) => Promise<boolean>,
  ): Promise<ReadonlyMap<string, SessionInputDeliveryClaim>>;
  /** Deletes `runId`'s unpromoted records, returning how many. Always safe: they are in no transcript. */
  release(sessionId: string, runId: string): Promise<number>;
  /** The records of a session. */
  read(sessionId: string): Promise<SessionInputDeliveryRecords>;
}

export function createSessionInputDeliveryStore(
  kv: ConditionalTextValueStore,
  options: SessionInputDeliveryStoreOptions,
): SessionInputDeliveryStore {
  async function update<T>(
    sessionId: string,
    decide: (
      records: SessionInputDeliveryRecords,
    ) => Promise<{ readonly next?: SessionInputDeliveryRecords; readonly result: T }>,
  ): Promise<T> {
    const key = sessionInputDeliveriesKey(sessionId);
    for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
      const raw = await kv.get(key);
      const decision = await decide(parseSessionInputDeliveries(raw));
      if (decision.next === undefined) return decision.result;
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: raw }],
        [{ type: 'set', key, value: JSON.stringify(decision.next) }],
      );
      if (committed) return decision.result;
    }
    throw new Error(
      `Session input deliveries for "${sessionId}" kept changing; gave up after ${MAXIMUM_ATTEMPTS} attempts.`,
    );
  }

  return {
    claim(sessionId, owner, commandIds, isOwnerLive) {
      return update(sessionId, async (records) => {
        const now = options.nowMs();
        const next: SessionInputDeliveryRecords = { ...records };
        const outcomes = new Map<string, SessionInputDeliveryClaim>();
        const liveness = new Map<string, boolean>();
        let changed = false;
        for (const commandId of commandIds) {
          const record = Object.hasOwn(next, commandId) ? next[commandId] : undefined;
          if (record === undefined) {
            defineOwn(next, commandId, { runId: owner, claimedAt: new Date(now).toISOString() });
            outcomes.set(commandId, 'claimed');
            changed = true;
          } else if (record.promotion !== undefined) {
            outcomes.set(commandId, 'promoted');
          } else if (record.runId === owner) {
            outcomes.set(commandId, 'owned');
          } else {
            let live = liveness.get(record.runId);
            if (live === undefined) {
              live = await isOwnerLive(record.runId);
              liveness.set(record.runId, live);
            }
            if (live) break;
            defineOwn(next, commandId, { runId: owner, claimedAt: new Date(now).toISOString() });
            outcomes.set(commandId, 'taken-over');
            changed = true;
          }
        }
        const kept = pruneSessionInputDeliveries(next, now, options.retentionMs);
        if (Object.keys(kept).length !== Object.keys(next).length) changed = true;
        return { ...(changed ? { next: kept } : {}), result: outcomes };
      });
    },

    release(sessionId, runId) {
      return update(sessionId, async (records) => {
        const next: SessionInputDeliveryRecords = {};
        let released = 0;
        for (const [commandId, record] of Object.entries(records)) {
          if (record.runId === runId && record.promotion === undefined) released += 1;
          else defineOwn(next, commandId, record);
        }
        return { ...(released > 0 ? { next } : {}), result: released };
      });
    },

    async read(sessionId) {
      return parseSessionInputDeliveries(await kv.get(sessionInputDeliveriesKey(sessionId)));
    },
  };
}
