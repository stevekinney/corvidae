import {
  createSessionInputDeliveryStore,
  planSessionInputPromotion,
  parseSessionInputDeliveries,
  sessionInputDeliveriesKey,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  admitSessionInput,
  createSessionInputMailbox,
  SESSION_INPUT_COMMAND_TIMEOUT_MS,
  SESSION_INPUT_DELIVERY_RETENTION_MS,
} from './session-input-durability';
import { SESSION_INPUT_RUN_ENDED_REASON } from './session-input-settlement';

/**
 * COR-1476 — a replayed `submitSessionInput` reads an honest receipt on every
 * way an admitted input can end, and the receipt follows the mailbox command,
 * never the caller's reusable id.
 */

const SESSION_ID = 'receipts-session';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const DAY_MS = 86_400_000;

function fixture() {
  const storage = new MemoryStorage();
  const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
  let now = START;
  const mailbox = createSessionInputMailbox(storage, SESSION_ID, 100, () => now);
  const deliveries = createSessionInputDeliveryStore(kv, {
    retentionMs: SESSION_INPUT_DELIVERY_RETENTION_MS,
    nowMs: () => now,
  });
  const attempt = (id = 'input-a') => ({
    storage,
    kv,
    sessionMailbox: mailbox,
    sessionId: SESSION_ID,
    id,
    principal: 'alice',
    deliveryMode: 'steer' as const,
    payload: { incarnation: 'incarnation-1', payload: 'hello' },
    principalBacklogLimit: 100,
    sessionBacklogLimitForCrossSessionRead: 100,
    nowMs: now,
  });
  /** The state a retry of the input reads. */
  const replayState = async (id = 'input-a') => {
    const outcome = await admitSessionInput(attempt(id));
    if (outcome.outcome === 'replayed') return outcome.receipt.state;
    throw new Error(`expected a replay, got ${outcome.outcome}`);
  };
  return {
    storage,
    kv,
    mailbox,
    deliveries,
    attempt,
    replayState,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

async function commandIdOf(mailbox: ReturnType<typeof fixture>['mailbox']): Promise<string> {
  const [receipt] = await mailbox.list({ limit: 10 });
  if (receipt === undefined) throw new Error('no command');
  return receipt.commandId;
}

describe('receipts on every way an input can end (COR-1476)', () => {
  it('reads accepted while it waits and promoted once its transcript write promoted it', async () => {
    const f = fixture();
    const admitted = await admitSessionInput(f.attempt());
    expect(admitted.outcome).toBe('admitted');
    expect(await f.replayState()).toBe('accepted');

    const commandId = await commandIdOf(f.mailbox);
    await f.deliveries.claim(SESSION_ID, 'run-1', [commandId], () => Promise.resolve(true));
    const key = sessionInputDeliveriesKey(SESSION_ID);
    await f.kv.set(
      key,
      JSON.stringify(
        planSessionInputPromotion(parseSessionInputDeliveries(await f.kv.get(key)), 'run-1', [
          {
            id: 'input-a',
            commandId,
            sessionId: SESSION_ID,
            deliveredAt: new Date(f.now()).toISOString(),
            conversationMessageId: 'message-a',
            providerTurn: 0,
          },
        ]),
      ),
    );
    expect(await f.replayState()).toBe('promoted');
  });

  it('reads promoted for an acknowledged command whose delivery record has been pruned', async () => {
    const f = fixture();
    await admitSessionInput(f.attempt());
    const claimed = await f.mailbox.claim();
    if (claimed.status !== 'claimed') throw new Error('expected a claim');
    await f.mailbox.acknowledge({
      commandId: claimed.claim.receipt.commandId,
      attemptToken: claimed.claim.attemptToken,
    });
    expect(await f.replayState()).toBe('promoted');
  });

  it('reads expired when its deadline passes undelivered', async () => {
    const f = fixture();
    await admitSessionInput(f.attempt());
    f.advance(SESSION_INPUT_COMMAND_TIMEOUT_MS + 1);
    await f.mailbox.runMaintenance();
    expect(await f.replayState()).toBe('expired');
  });

  it('reads failed when it is rejected as undecodable', async () => {
    const f = fixture();
    await admitSessionInput(f.attempt());
    const claimed = await f.mailbox.claim();
    if (claimed.status !== 'claimed') throw new Error('expected a claim');
    await f.mailbox.reject({
      commandId: claimed.claim.receipt.commandId,
      attemptToken: claimed.claim.attemptToken,
      failure: { reason: 'application', message: 'malformed' },
      retry: false,
    });
    expect(await f.replayState()).toBe('failed');
  });

  it('reads canceled when its session is deleted and when its run ended before delivering it', async () => {
    const deleted = fixture();
    await admitSessionInput(deleted.attempt());
    await deleted.mailbox.requestCancellation({
      commandId: await commandIdOf(deleted.mailbox),
      reason: 'the session was deleted',
    });
    expect(await deleted.replayState()).toBe('canceled');

    const orphaned = fixture();
    await admitSessionInput(orphaned.attempt());
    await orphaned.mailbox.requestCancellation({
      commandId: await commandIdOf(orphaned.mailbox),
      reason: SESSION_INPUT_RUN_ENDED_REASON,
    });
    expect(await orphaned.replayState()).toBe('canceled');
  });

  it("does not call a caller's reused id delivered once the mailbox retired the first record", async () => {
    const f = fixture();
    await admitSessionInput(f.attempt());
    const commandId = await commandIdOf(f.mailbox);
    await f.deliveries.claim(SESSION_ID, 'run-1', [commandId], () => Promise.resolve(true));
    const claimed = await f.mailbox.claim();
    if (claimed.status !== 'claimed') throw new Error('expected a claim');
    await f.mailbox.acknowledge({
      commandId: claimed.claim.receipt.commandId,
      attemptToken: claimed.claim.attemptToken,
    });

    f.advance(2 * DAY_MS);
    await f.mailbox.runMaintenance();
    const reused = await admitSessionInput(f.attempt());
    expect(reused.outcome).toBe('admitted');
    if (reused.outcome === 'admitted') expect(reused.receipt.state).toBe('accepted');
  });
});
