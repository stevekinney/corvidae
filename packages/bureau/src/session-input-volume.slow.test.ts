import { createSessionInputDeliveryStore } from '@lostgradient/operative';
import { type Mailbox, MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';
import { CURRENT_SCHEMA_VERSION } from 'conversationalist';

import { createSessionInputDeliveryGate } from './session-input-delivery';
import {
  admitSessionInput,
  createSessionInputMailbox,
  SESSION_INPUT_DELIVERY_RETENTION_MS,
} from './session-input-durability';
import { cancelOpenSessionInput } from './session-input-settlement';

/**
 * COR-1476 — the session-input code never lets a bounded `Mailbox.list` walk
 * decide existence, emptiness, or a limit. A mailbox listing examines at most
 * a fixed number of index entries, and a session keeps its terminal records
 * for the identity's lifetime, so a live command can sit behind more retained
 * entries than one listing reaches. Each decision here is taken against that
 * volume: the principal's open count, the run-end cancel pass, and the gate's
 * check for a lease held elsewhere.
 */

const START = Date.parse('2026-01-01T00:00:00.000Z');
const SESSION_ID = 'volume-session';
/** More index entries than one `Mailbox.list` call examines. */
const BEYOND_ONE_LISTING = 5_001;

async function admitRaw(mailbox: Mailbox, id: string): Promise<string> {
  const admission = await mailbox.admit({
    caller: 'alice',
    target: SESSION_ID,
    kind: 'session-input:steer',
    payload: { form: 'inline', value: { incarnation: 'incarnation-1', payload: id } },
    idempotencyKey: id,
  });
  if (admission.status !== 'admitted') throw new Error(`${id}: ${admission.status}`);
  return admission.receipt.commandId;
}

/** Fills the session's index with retained terminal records, ahead of whatever follows. */
async function seedRetained(mailbox: Mailbox, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const commandId = await admitRaw(mailbox, `retained-${index}`);
    await mailbox.requestCancellation({ commandId, reason: 'seeded' });
  }
}

describe('decisions behind more retained records than one listing reaches (COR-1476)', () => {
  it("counts a principal's open input exhaustively: an admission at the limit is refused", async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const mailbox = createSessionInputMailbox(
      storage,
      SESSION_ID,
      'incarnation-1',
      10_000,
      () => START,
    );
    await seedRetained(mailbox, BEYOND_ONE_LISTING);
    const attempt = (id: string) => ({
      storage,
      kv,
      sessionMailbox: mailbox,
      sessionId: SESSION_ID,
      incarnation: 'incarnation-1',
      id,
      principal: 'alice',
      deliveryMode: 'steer' as const,
      payload: { schemaVersion: CURRENT_SCHEMA_VERSION, incarnation: 'incarnation-1', payload: id },
      principalBacklogLimit: 1,
      sessionBacklogLimitForCrossSessionRead: 10_000,
      nowMs: START,
    });
    const first = await admitSessionInput(attempt('live-a'));
    expect(first.outcome).toBe('admitted');
    const second = await admitSessionInput(attempt('live-b'));
    expect(second.outcome).toBe('backlog-exhausted');
    if (second.outcome === 'backlog-exhausted') expect(second.scope).toBe('principal');
  }, 120_000);

  it('cancels open input the run-end pass would otherwise never reach', async () => {
    const storage = new MemoryStorage();
    const mailbox = createSessionInputMailbox(
      storage,
      SESSION_ID,
      'incarnation-1',
      10_000,
      () => START,
    );
    await seedRetained(mailbox, BEYOND_ONE_LISTING);
    const commandId = await admitRaw(mailbox, 'live-a');

    const cancelled = await cancelOpenSessionInput(mailbox, new Set());

    expect(cancelled).toEqual([commandId]);
    const receipt = await mailbox.receipt(commandId);
    expect(receipt?.state).toBe('cancelled');
  }, 120_000);

  it('reads the newest records first: with one open input behind thousands of retained ones, each decision takes at most two listings', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const real = createSessionInputMailbox(
      storage,
      SESSION_ID,
      'incarnation-1',
      10_000,
      () => START,
    );
    await seedRetained(real, BEYOND_ONE_LISTING);
    let listings = 0;
    const counting = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'list') {
          return (options?: Parameters<Mailbox['list']>[0]) => {
            listings += 1;
            return target.list(options);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const attempt = (id: string) => ({
      storage,
      kv,
      sessionMailbox: counting,
      sessionId: SESSION_ID,
      incarnation: 'incarnation-1',
      id,
      principal: 'alice',
      deliveryMode: 'steer' as const,
      payload: { schemaVersion: CURRENT_SCHEMA_VERSION, incarnation: 'incarnation-1', payload: id },
      principalBacklogLimit: 1,
      sessionBacklogLimitForCrossSessionRead: 10_000,
      nowMs: START,
    });
    const first = await admitSessionInput(attempt('live-a'));
    expect(first.outcome).toBe('admitted');

    // The principal's open count: one open record, newest of all.
    listings = 0;
    const second = await admitSessionInput(attempt('live-b'));
    expect(second.outcome).toBe('backlog-exhausted');
    expect(listings).toBeLessThanOrEqual(2);

    // The gate's check for a lease held elsewhere: the one open record is leased.
    const leased = await real.claim();
    if (leased.status !== 'claimed') throw new Error('expected a claim');
    const gate = createSessionInputDeliveryGate({
      sessionId: SESSION_ID,
      runId: 'run-ours',
      incarnation: 'incarnation-1',
      mailbox: counting,
      deliveryStore: createSessionInputDeliveryStore(kv, {
        retentionMs: SESSION_INPUT_DELIVERY_RETENTION_MS,
        nowMs: () => START,
      }),
      isOwnerLive: () => Promise.resolve(true),
      now: () => START,
    });
    try {
      listings = 0;
      expect(await gate.claimPending()).toEqual([]);
      expect(listings).toBeLessThanOrEqual(2);
    } finally {
      await gate.dispose?.();
    }
  }, 120_000);

  it('holds a later input back while an earlier one is leased elsewhere, however far back that lease sits', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const mailbox = createSessionInputMailbox(
      storage,
      SESSION_ID,
      'incarnation-1',
      10_000,
      () => START,
    );
    await seedRetained(mailbox, BEYOND_ONE_LISTING);
    const commandA = await admitRaw(mailbox, 'live-a');
    // Another process's gate holds A.
    const leased = await mailbox.claim();
    if (leased.status !== 'claimed') throw new Error('expected a claim');
    expect(leased.claim.receipt.commandId).toBe(commandA);
    const commandB = await admitRaw(mailbox, 'live-b');

    const gate = createSessionInputDeliveryGate({
      sessionId: SESSION_ID,
      runId: 'run-ours',
      incarnation: 'incarnation-1',
      mailbox,
      deliveryStore: createSessionInputDeliveryStore(kv, {
        retentionMs: SESSION_INPUT_DELIVERY_RETENTION_MS,
        nowMs: () => START,
      }),
      isOwnerLive: () => Promise.resolve(true),
      now: () => START,
    });
    try {
      // B is claimable, but A, leased elsewhere, comes before it.
      expect(await gate.claimPending()).toEqual([]);
      const receiptB = await mailbox.receipt(commandB);
      expect(receiptB?.state).toBe('available');
    } finally {
      await gate.dispose?.();
    }
  }, 120_000);
});
