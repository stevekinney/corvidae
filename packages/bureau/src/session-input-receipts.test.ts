import {
  createSessionInputDeliveryStore,
  planSessionInputPromotion,
  parseSessionInputDeliveries,
  sessionInputDeliveriesKey,
} from '@lostgradient/operative';
import { type Mailbox } from '@lostgradient/weft';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';
import { CURRENT_SCHEMA_VERSION } from 'conversationalist';

import {
  admitSessionInput,
  createSessionInputMailbox,
  SESSION_INPUT_COMMAND_TIMEOUT_MS,
  SESSION_INPUT_DELIVERY_RETENTION_MS,
  SESSION_INPUT_IDENTITY_TTL_MS,
} from './session-input-durability';
import {
  createSessionInputSettlement,
  SESSION_INPUT_RUN_ENDED_REASON,
} from './session-input-settlement';
import { deferred } from './test/session-input-fixtures';

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
  const mailbox = createSessionInputMailbox(storage, SESSION_ID, 'incarnation-1', 100, () => now);
  const deliveries = createSessionInputDeliveryStore(kv, {
    retentionMs: SESSION_INPUT_DELIVERY_RETENTION_MS,
    nowMs: () => now,
  });
  const attempt = (id = 'input-a') => ({
    storage,
    kv,
    sessionMailbox: mailbox,
    sessionId: SESSION_ID,
    incarnation: 'incarnation-1',
    id,
    principal: 'alice',
    deliveryMode: 'steer' as const,
    payload: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      incarnation: 'incarnation-1',
      payload: 'hello',
    },
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

describe('the identity index (COR-1476)', () => {
  function pair(now: () => number) {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const first = createSessionInputMailbox(storage, 'session-first', 'incarnation-1', 100, now);
    const second = createSessionInputMailbox(storage, 'session-second', 'incarnation-1', 100, now);
    const attempt = (sessionId: string, mailbox: Mailbox, id = 'input-shared') => ({
      storage,
      kv,
      sessionMailbox: mailbox,
      sessionId,
      incarnation: 'incarnation-1',
      id,
      principal: 'alice',
      deliveryMode: 'steer' as const,
      payload: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        incarnation: 'incarnation-1',
        payload: 'hello',
      },
      principalBacklogLimit: 100,
      sessionBacklogLimitForCrossSessionRead: 100,
      nowMs: now(),
    });
    const identities = () => kv.list('session-input-identity:v1:');
    return { storage, kv, first, second, attempt, identities };
  }

  it('refuses the retry of a request the principal backlog rejected, and keeps its identity rather than deleting it', async () => {
    const f = fixture();
    const first = await admitSessionInput({ ...f.attempt('input-a'), principalBacklogLimit: 1 });
    expect(first.outcome).toBe('admitted');
    const rejected = await admitSessionInput({ ...f.attempt('input-b'), principalBacklogLimit: 1 });
    expect(rejected.outcome).toBe('backlog-exhausted');

    const retried = await admitSessionInput({ ...f.attempt('input-b'), principalBacklogLimit: 1 });
    expect(retried.outcome).toBe('backlog-exhausted');
    // Never deleted: a refusal leaves its pending claim, which a later
    // admission of the id commits or another session takes over.
    const identities = await f.kv.list('session-input-identity:v1:');
    expect(
      identities.map((key) => key.split(':').at(-1)).toSorted((a, b) => a!.localeCompare(b!)),
    ).toEqual(['input-a', 'input-b']);
  });

  it('lets another session take over the identity a refused admission left pending', async () => {
    let now = START;
    const f = pair(() => now);
    const earlier = await admitSessionInput(f.attempt('session-first', f.first, 'input-a'));
    expect(earlier.outcome).toBe('admitted');
    const refused = await admitSessionInput({
      ...f.attempt('session-first', f.first),
      principalBacklogLimit: 1,
    });
    expect(refused.outcome).toBe('backlog-exhausted');
    now += 1_000;
    const elsewhere = await admitSessionInput(f.attempt('session-second', f.second));
    expect(elsewhere.outcome).toBe('admitted');
    // And the first session's later retry of the id finds it owned elsewhere.
    const back = await admitSessionInput(f.attempt('session-first', f.first));
    expect(back.outcome).toBe('conflict');
    if (back.outcome === 'conflict') expect(back.conflict.reason).toBe('session-mismatch');
  });

  it('keeps the identity a concurrent same-session retry admitted under when the first attempt is refused at the limit', async () => {
    const now = START;
    const f = pair(() => now);
    const reached = deferred();
    const held = deferred();
    let holds = 1;
    // The first attempt's principal-count read (the mailbox's open count) is
    // held once, after its pending identity claim committed; the retry, in
    // another process, runs meanwhile.
    const holding = new Proxy(f.first, {
      get(target, property, receiver) {
        if (property === 'capacity') {
          return async () => {
            if (holds > 0) {
              holds -= 1;
              reached.resolve();
              await held.promise;
            }
            return target.capacity();
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const winner = admitSessionInput({
      ...f.attempt('session-first', holding),
      principalBacklogLimit: 1,
    });
    await reached.promise;
    // The retry finds a pending claim with no record behind it, so it runs the
    // full admission itself and creates the record.
    const retry = await admitSessionInput({
      ...f.attempt('session-first', f.first),
      principalBacklogLimit: 1,
    });
    held.resolve();
    const refused = await winner;
    expect(retry.outcome).toBe('admitted');
    expect(refused.outcome).toBe('backlog-exhausted');

    // The refusal deleted nothing: the identity still names the session whose
    // record stands, so the id reaches another session as a conflict.
    expect(await f.identities()).toHaveLength(1);
    const [record] = await f.first.list({ limit: 10 });
    expect(record?.state).toBe('available');
    const elsewhere = await admitSessionInput(f.attempt('session-second', f.second));
    expect(elsewhere.outcome).toBe('conflict');
    if (elsewhere.outcome === 'conflict') {
      expect(elsewhere.conflict.reason).toBe('session-mismatch');
    }
  });

  it('cancels an admission whose identity another session took over while it was in flight', async () => {
    let now = START;
    const f = pair(() => now);
    const reached = deferred();
    const held = deferred();
    // The first session's mailbox admission is held after its pending claim
    // committed and its principal check passed.
    const holding = new Proxy(f.first, {
      get(target, property, receiver) {
        if (property === 'admit') {
          return async (options: Parameters<Mailbox['admit']>[0]) => {
            reached.resolve();
            await held.promise;
            return target.admit(options);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const inFlight = admitSessionInput(f.attempt('session-first', holding));
    await reached.promise;
    // Another session sees a pending claim with no record: an orphan, taken over.
    now += 1_000;
    const taker = await admitSessionInput(f.attempt('session-second', f.second));
    expect(taker.outcome).toBe('admitted');
    held.resolve();
    const lost = await inFlight;

    // The record the first session created after losing the identity is
    // cancelled at once, and its caller reads that from the receipt.
    expect(lost.outcome).toBe('admitted');
    if (lost.outcome === 'admitted') expect(lost.receipt.state).toBe('canceled');
    const [firstRecord] = await f.first.list({ limit: 10 });
    expect(firstRecord?.state).toBe('cancelled');
    const [secondRecord] = await f.second.list({ limit: 10 });
    expect(secondRecord?.state).toBe('available');
    // The resend lands as a conflict naming the session that holds the id.
    const resend = await admitSessionInput(f.attempt('session-first', f.first));
    expect(resend.outcome).toBe('conflict');
    if (resend.outcome === 'conflict') expect(resend.conflict.reason).toBe('session-mismatch');
    const replay = await admitSessionInput(f.attempt('session-second', f.second));
    expect(replay.outcome).toBe('replayed');
  });

  it('still finds a live id behind a thousand retained terminal records: conflict elsewhere, replay at home', async () => {
    const now = START;
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const first = createSessionInputMailbox(
      storage,
      'volume-first',
      'incarnation-1',
      5000,
      () => now,
    );
    const second = createSessionInputMailbox(
      storage,
      'volume-second',
      'incarnation-1',
      5000,
      () => now,
    );
    const attempt = (sessionId: string, mailbox: Mailbox, id: string, limit: number) => ({
      storage,
      kv,
      sessionMailbox: mailbox,
      sessionId,
      incarnation: 'incarnation-1',
      id,
      principal: 'alice',
      deliveryMode: 'steer' as const,
      payload: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        incarnation: 'incarnation-1',
        payload: 'hello',
      },
      principalBacklogLimit: limit,
      sessionBacklogLimitForCrossSessionRead: 5000,
      nowMs: now,
    });
    // A thousand earlier inputs of the session, delivered and retained.
    for (let index = 0; index < 1000; index += 1) {
      const admission = await first.admit({
        caller: 'alice',
        target: 'volume-first',
        kind: 'session-input:steer',
        payload: { form: 'inline', value: { incarnation: 'incarnation-1', payload: 'x' } },
        idempotencyKey: `input-${index}`,
      });
      if (admission.status !== 'admitted') throw new Error(`${index}: ${admission.status}`);
      const claimed = await first.claim();
      if (claimed.status !== 'claimed') throw new Error('expected a claim');
      await first.acknowledge({
        commandId: claimed.claim.receipt.commandId,
        attemptToken: claimed.claim.attemptToken,
      });
    }
    const newest = await admitSessionInput(attempt('volume-first', first, 'input-1000', 5000));
    expect(newest.outcome).toBe('admitted');

    // The newest id, live in volume-first, is submitted to another session, and
    // replayed at home by a principal now at its limit.
    const elsewhere = await admitSessionInput(attempt('volume-second', second, 'input-1000', 5000));
    expect(elsewhere.outcome).toBe('conflict');
    if (elsewhere.outcome === 'conflict') {
      expect(elsewhere.conflict.reason).toBe('session-mismatch');
    }
    const replay = await admitSessionInput(attempt('volume-first', first, 'input-1000', 1));
    expect(replay.outcome).toBe('replayed');
    expect(await second.list({ limit: 10 })).toEqual([]);
  });

  it('outlasts an open command: the same id reaches another session as a conflict a day later', async () => {
    let now = START;
    const f = pair(() => now);
    const original = await admitSessionInput(f.attempt('session-first', f.first));
    expect(original.outcome).toBe('admitted');

    now += DAY_MS + 60_000;
    const elsewhere = await admitSessionInput(f.attempt('session-second', f.second));
    expect(elsewhere.outcome).toBe('conflict');
    if (elsewhere.outcome === 'conflict')
      expect(elsewhere.conflict.reason).toBe('session-mismatch');
  });

  it('answers conflict, never a throw, for an original that terminalized long before its identity expires', async () => {
    let now = START;
    const f = pair(() => now);
    const original = await admitSessionInput(f.attempt('session-first', f.first));
    expect(original.outcome).toBe('admitted');
    const claimed = await f.first.claim();
    if (claimed.status !== 'claimed') throw new Error('expected a claim');
    await f.first.acknowledge({
      commandId: claimed.claim.receipt.commandId,
      attemptToken: claimed.claim.attemptToken,
    });

    // Two days on: the identity is live, and the record is still retained.
    now += 2 * DAY_MS;
    await f.first.runMaintenance();
    const elsewhere = await admitSessionInput(f.attempt('session-second', f.second));
    expect(elsewhere.outcome).toBe('conflict');
    if (elsewhere.outcome === 'conflict') {
      expect(elsewhere.conflict.reason).toBe('session-mismatch');
      expect(elsewhere.conflict.originalReceipt.state).toBe('promoted');
    }

    // Past the identity's lifetime the record has been retired too, and the
    // id is admitted afresh.
    now = START + SESSION_INPUT_IDENTITY_TTL_MS + 3_600_000;
    await f.first.runMaintenance();
    expect(await f.first.receipt(claimed.claim.receipt.commandId)).toBeNull();
    const fresh = await admitSessionInput(f.attempt('session-second', f.second));
    expect(fresh.outcome).toBe('admitted');
  });

  it('is outlived by the terminal record the cross-session path reads, and outlives any open command', async () => {
    const storage = new MemoryStorage();
    let now = START;
    const mailbox = createSessionInputMailbox(
      storage,
      'retention-probe',
      'incarnation-1',
      100,
      () => now,
    );
    const admission = await mailbox.admit({
      caller: 'alice',
      target: 'retention-probe',
      kind: 'session-input:steer',
      payload: { form: 'inline', value: {} },
      idempotencyKey: 'probe',
    });
    if (admission.status !== 'admitted') throw new Error('expected admitted');
    const claimed = await mailbox.claim();
    if (claimed.status !== 'claimed') throw new Error('expected a claim');
    await mailbox.acknowledge({
      commandId: claimed.claim.receipt.commandId,
      attemptToken: claimed.claim.attemptToken,
    });

    // Measure, hour by hour, how long the mailbox keeps a terminal record.
    const settledAt = now;
    let retainedFor = 0;
    for (let hour = 1; hour <= 24 * 10; hour += 1) {
      now = settledAt + hour * 3_600_000;
      await mailbox.runMaintenance();
      if ((await mailbox.receipt(admission.receipt.commandId)) === null) break;
      retainedFor = now - settledAt;
    }
    expect(retainedFor).toBeGreaterThan(0);
    expect(SESSION_INPUT_IDENTITY_TTL_MS).toBeGreaterThan(SESSION_INPUT_COMMAND_TIMEOUT_MS);
    expect(retainedFor).toBeGreaterThanOrEqual(SESSION_INPUT_IDENTITY_TTL_MS);
    expect(SESSION_INPUT_DELIVERY_RETENTION_MS).toBeGreaterThan(SESSION_INPUT_IDENTITY_TTL_MS);
  });
});

describe("the principal's open count against admissions landing mid-walk (COR-1476)", () => {
  it('counts only the commands its open count described: admissions between the count and the first page are not counted', async () => {
    const now = START;
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const real = createSessionInputMailbox(storage, SESSION_ID, 'incarnation-1', 100, () => now);
    const admitRaw = async (caller: string, id: string) => {
      const admission = await real.admit({
        caller,
        target: SESSION_ID,
        kind: 'session-input:steer',
        payload: { form: 'inline', value: { incarnation: 'incarnation-1', payload: id } },
        idempotencyKey: id,
      });
      if (admission.status !== 'admitted') throw new Error(admission.status);
    };
    // Two open commands, one of them alice's, so the count equals the limit
    // and the walk runs.
    await admitRaw('alice', 'input-a');
    await admitRaw('bob', 'input-b');
    // After the open count is read, three more of alice's commands are
    // admitted before the first page. Newest first, the walk sees them first;
    // counting them would refuse alice over a limit she is under.
    let bursts = 1;
    const bursting = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'capacity') {
          return async () => {
            const snapshot = await target.capacity();
            if (bursts > 0) {
              bursts -= 1;
              for (const id of ['input-c', 'input-d', 'input-e']) await admitRaw('alice', id);
            }
            return snapshot;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const outcome = await admitSessionInput({
      storage,
      kv,
      sessionMailbox: bursting,
      sessionId: SESSION_ID,
      incarnation: 'incarnation-1',
      id: 'input-f',
      principal: 'alice',
      deliveryMode: 'steer',
      payload: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        incarnation: 'incarnation-1',
        payload: 'f',
      },
      principalBacklogLimit: 2,
      sessionBacklogLimitForCrossSessionRead: 100,
      nowMs: now,
    });
    expect(outcome.outcome).toBe('admitted');
  });
});

describe('the identity across incarnations of one session (COR-1476)', () => {
  const SESSION = 'session-incarnations';
  function attemptFor(
    storage: MemoryStorage,
    kv: ReturnType<typeof textValueStore>,
    incarnation: string,
    mailbox: Mailbox,
  ) {
    return {
      storage,
      kv,
      sessionMailbox: mailbox,
      sessionId: SESSION,
      incarnation,
      id: 'input-shared',
      principal: 'alice',
      deliveryMode: 'steer' as const,
      payload: { schemaVersion: CURRENT_SCHEMA_VERSION, incarnation, payload: 'hello' },
      principalBacklogLimit: 100,
      sessionBacklogLimitForCrossSessionRead: 100,
      nowMs: START,
    };
  }
  function holdAdmit(real: Mailbox) {
    const reached = deferred();
    const held = deferred();
    const proxy = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'admit') {
          return async (options: Parameters<Mailbox['admit']>[0]) => {
            reached.resolve();
            await held.promise;
            return target.admit(options);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { proxy, reached: reached.promise, release: held.resolve };
  }

  it("loses an in-flight admission of the deleted incarnation to the new incarnation's takeover, and cancels its own command", async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const oldMailbox = createSessionInputMailbox(storage, SESSION, 'incarnation-a', 100);
    const newMailbox = createSessionInputMailbox(storage, SESSION, 'incarnation-b', 100);
    const hold = holdAdmit(oldMailbox);
    const inFlight = admitSessionInput(attemptFor(storage, kv, 'incarnation-a', hold.proxy));
    await hold.reached;
    const taker = await admitSessionInput(attemptFor(storage, kv, 'incarnation-b', newMailbox));
    hold.release();
    const lost = await inFlight;
    const identity = await kv.get('session-input-identity:v1:alice:input-shared');
    const [oldRecord] = await oldMailbox.list({ limit: 10 });
    const [newRecord] = await newMailbox.list({ limit: 10 });
    expect(taker.outcome).toBe('admitted');
    expect(lost.outcome === 'admitted' && lost.receipt.state).toBe('canceled');
    expect(oldRecord?.state).toBe('cancelled');
    expect(newRecord?.state).toBe('available');
    expect(identity).toContain('"incarnation-b"');
  });

  it('takes over an admission the deleted incarnation completed, and the retired sweep cancels its record', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const oldMailbox = createSessionInputMailbox(storage, SESSION, 'incarnation-a', 100);
    const newMailbox = createSessionInputMailbox(storage, SESSION, 'incarnation-b', 100);
    const original = await admitSessionInput(attemptFor(storage, kv, 'incarnation-a', oldMailbox));
    expect(original.outcome).toBe('admitted');
    const taker = await admitSessionInput(attemptFor(storage, kv, 'incarnation-b', newMailbox));
    expect(taker.outcome).toBe('admitted');
    const settlement = createSessionInputSettlement({
      kv,
      incarnationOf: () => Promise.resolve('incarnation-b'),
      liveRunIds: () => Promise.resolve([]),
      mailboxOf: (_sessionId, incarnation) =>
        incarnation === 'incarnation-a' ? oldMailbox : newMailbox,
      isClosed: () => false,
      diagnose: () => {},
    });
    await settlement.markOpen(SESSION, 'incarnation-a');
    await settlement.sweep();
    const [oldAfter] = await oldMailbox.list({ limit: 10 });
    const [newRecord] = await newMailbox.list({ limit: 10 });
    expect(oldAfter?.state).toBe('cancelled');
    expect(newRecord?.state).toBe('available');
  });

  it('treats a legacy identity value without an incarnation as absent, never throwing on it', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    await kv.set(
      'session-input-identity:v1:alice:input-shared',
      JSON.stringify({ sessionId: SESSION, recordedAtMs: START, admission: 'admitted' }),
    );
    const mailbox = createSessionInputMailbox(storage, SESSION, 'incarnation-b', 100);
    const outcome = await admitSessionInput(attemptFor(storage, kv, 'incarnation-b', mailbox));
    expect(outcome.outcome).toBe('admitted');
  });
});

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

    // The record is retained, and the id answered as a replay, for the
    // identity's whole lifetime; past it the mailbox has retired the record.
    f.advance(2 * DAY_MS);
    await f.mailbox.runMaintenance();
    const replayed = await admitSessionInput(f.attempt());
    expect(replayed.outcome).toBe('replayed');
    f.advance(SESSION_INPUT_IDENTITY_TTL_MS - 2 * DAY_MS + 3_600_000);
    await f.mailbox.runMaintenance();
    const reused = await admitSessionInput(f.attempt());
    expect(reused.outcome).toBe('admitted');
    if (reused.outcome === 'admitted') expect(reused.receipt.state).toBe('accepted');
  });
});
