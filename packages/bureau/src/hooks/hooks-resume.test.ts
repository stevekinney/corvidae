/**
 * COR-1939 — delivery records survive a restart and pending deliveries resume. One attempt record
 * produces at most one HTTP request: an attempt with an unknown outcome is closed as interrupted and
 * the retry is a new attempt under the same idempotency key.
 */
import type { EncryptionKey } from '@lostgradient/cryptography';
import { textValueStore } from '@lostgradient/storage';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { BureauDiagnostic } from '../types.ts';
import { createSqliteStorageFixture } from '../test/storage-fixtures.ts';
import { waitForCondition } from '../test';
import { HOOK_SIGNATURE_HEADER, verifyHookSignature } from './hook-signature.ts';
import { HOOK_DELIVERY_KEY_PREFIX } from './hook-store.ts';
import type { HookDeliveryRecord } from './hook-types.ts';
import {
  createClock,
  createManualSleep,
  createReceiver,
  deliveriesOf,
  fireRunEvents,
  hangUntilAborted,
  newEncryptionKey,
  openHooksBureau,
  type OpenedHooksBureau,
  SIGNING_SECRET,
  waitForSettledDeliveries,
} from './hooks.test-support.ts';

let key: EncryptionKey;
beforeAll(async () => {
  key = await newEncryptionKey();
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const HOOK = {
  url: 'https://receiver.example/hook',
  events: ['run.registered'],
  signingSecret: SIGNING_SECRET,
  principal: 'api-key:alice',
} as const;

/** Waits for the notifier to finish the resume pass and every delivery it took. */
async function resumed(opened: OpenedHooksBureau): Promise<void> {
  await opened.bureau.internals.webhookNotifier!.flush();
}

async function firstProcess() {
  const database = createSqliteStorageFixture();
  cleanups.push(() => database.dispose());
  const receiver = createReceiver(hangUntilAborted);
  const { clock, now } = createClock();
  const first = await openHooksBureau({
    storage: database.storage,
    fetch: receiver.fetch,
    key,
    now,
  });
  let firstOpen = true;
  cleanups.push(async () => {
    if (firstOpen) await first.dispose();
  });
  const hook = await first.bureau.hooks!.create(HOOK);
  await fireRunEvents(first.bureau);
  await waitForCondition(() => receiver.calls.length === 1, 'the first request never started');
  return {
    database,
    clock,
    now,
    hook,
    first,
    receiver,
    stopFirst: async () => {
      firstOpen = false;
      await first.dispose();
    },
  };
}

describe('a delivery after a restart', () => {
  it('survives a clean stop, resumes as a new attempt, and sends one request per attempt', async () => {
    const run = await firstProcess();
    await run.stopFirst();

    const secondReceiver = createReceiver();
    const second = await openHooksBureau({
      storage: await run.database.reopen(),
      fetch: secondReceiver.fetch,
      key,
      now: run.now,
    });
    cleanups.push(() => second.dispose());
    const [delivery] = await waitForSettledDeliveries(second.bureau, run.hook.id, 1);

    expect(delivery!.status).toBe('delivered');
    expect(delivery!.attempts.map((attempt) => [attempt.number, attempt.outcome])).toEqual([
      [1, 'interrupted'],
      [2, 'response'],
    ]);
    // The interrupted attempt made its one request in the first process; the second made one more.
    expect(run.receiver.calls).toHaveLength(1);
    expect(secondReceiver.calls).toHaveLength(1);
    const resent = secondReceiver.calls[0]!;
    expect(resent.headers.get('X-Delivery-Attempt')).toBe('2');
    expect(resent.headers.get('Idempotency-Key')).toBe(delivery!.id);
    expect(resent.headers.get('Idempotency-Key')).toBe(
      run.receiver.calls[0]!.headers.get('Idempotency-Key'),
    );
    expect(resent.body).toBe(run.receiver.calls[0]!.body);
    expect(
      verifyHookSignature({
        secret: SIGNING_SECRET,
        header: resent.headers.get(HOOK_SIGNATURE_HEADER)!,
        body: resent.body,
        now: run.clock.milliseconds,
      }),
    ).toEqual({ ok: true });
    // The hook, and who owns it, came back too.
    expect(await second.bureau.hooks!.get(run.hook.id)).toMatchObject({ owner: 'api-key:alice' });
  });

  it('resumes a crashed process’s delivery when its lease runs out, even if the restart came inside the window', async () => {
    const run = await firstProcess();
    await run.stopFirst();
    // What a crash leaves: the attempt written as sending, and a lease that has not run out.
    const storage = await run.database.reopen();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const [deliveryKey] = await kv.list(HOOK_DELIVERY_KEY_PREFIX);
    const record = JSON.parse((await kv.get(deliveryKey!))!) as HookDeliveryRecord;
    const [sent] = record.attempts;
    const { finishedAt: _finished, ...sending } = sent!;
    const crashed: HookDeliveryRecord = {
      ...record,
      attempts: [{ ...sending, outcome: 'sending' }],
      leaseUntil: run.clock.milliseconds + 60_000,
      revision: record.revision + 1,
    };
    await kv.set(deliveryKey!, JSON.stringify(crashed));

    const receiver = createReceiver();
    const wait = createManualSleep();
    const second = await openHooksBureau({
      storage,
      fetch: receiver.fetch,
      key,
      now: run.now,
      sleep: wait.sleep,
    });
    cleanups.push(() => second.dispose());
    // The live lease keeps this process from taking it now; it schedules one scan for the expiry.
    await waitForCondition(() => wait.requested.length === 1, 'no re-scan was scheduled');
    expect(wait.requested).toEqual([60_000]);
    expect(receiver.calls).toHaveLength(0);
    const [held] = await deliveriesOf(second.bureau, run.hook.id);
    expect(held!.status).toBe('pending');

    // The lease runs out; the same process takes the delivery, with no further restart.
    run.clock.milliseconds += 60_000;
    wait.release();
    const [delivery] = await waitForSettledDeliveries(second.bureau, run.hook.id, 1);

    expect(delivery!.status).toBe('delivered');
    expect(delivery!.attempts.map((attempt) => [attempt.number, attempt.outcome])).toEqual([
      [1, 'interrupted'],
      [2, 'response'],
    ]);
    // Sent once, as a new attempt that never reuses the interrupted one's number, and the
    // re-scan did not schedule itself again, since nothing is left to wait for.
    expect(receiver.calls).toHaveLength(1);
    expect(receiver.calls[0]!.headers.get('X-Delivery-Attempt')).toBe('2');
    expect(wait.requested).toEqual([60_000]);
  });

  it('cancels the scheduled re-scan on shutdown, and takes nothing after it', async () => {
    const run = await firstProcess();
    await run.stopFirst();
    const storage = await run.database.reopen();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const [deliveryKey] = await kv.list(HOOK_DELIVERY_KEY_PREFIX);
    const record = JSON.parse((await kv.get(deliveryKey!))!) as HookDeliveryRecord;
    await kv.set(
      deliveryKey!,
      JSON.stringify({
        ...record,
        leaseUntil: run.clock.milliseconds + 60_000,
        revision: record.revision + 1,
      }),
    );

    const receiver = createReceiver();
    const wait = createManualSleep();
    const diagnostics: BureauDiagnostic[] = [];
    const second = await openHooksBureau({
      storage,
      fetch: receiver.fetch,
      key,
      now: run.now,
      sleep: wait.sleep,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await waitForCondition(() => wait.requested.length === 1, 'no re-scan was scheduled');
    // The wait never finishes on its own; the shutdown abandons it and still completes.
    await second.dispose();
    run.clock.milliseconds += 61_000;
    wait.release();

    expect(receiver.calls).toHaveLength(0);
    expect(diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([]);
  });

  it('counts interrupted attempts against the limit, so a restart loop cannot retry forever', async () => {
    const run = await firstProcess();
    await run.stopFirst();
    const storage = await run.database.reopen();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const [deliveryKey] = await kv.list(HOOK_DELIVERY_KEY_PREFIX);
    const record = JSON.parse((await kv.get(deliveryKey!))!) as HookDeliveryRecord;
    const attempt = record.attempts[0]!;
    const exhaustedByInterruptions: HookDeliveryRecord = {
      ...record,
      attempts: Array.from({ length: record.maxAttempts }, (_, index) => ({
        ...attempt,
        number: index + 1,
      })),
      revision: record.revision + 1,
    };
    await kv.set(deliveryKey!, JSON.stringify(exhaustedByInterruptions));

    const receiver = createReceiver();
    const second = await openHooksBureau({ storage, fetch: receiver.fetch, key, now: run.now });
    cleanups.push(() => second.dispose());
    const [delivery] = await waitForSettledDeliveries(second.bureau, run.hook.id, 1);

    expect(delivery!.status).toBe('exhausted');
    expect(receiver.calls).toHaveLength(0);
  });

  it('does not resume a finished delivery', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const receiver = createReceiver();
    const { now } = createClock();
    const first = await openHooksBureau({
      storage: database.storage,
      fetch: receiver.fetch,
      key,
      now,
    });
    const hook = await first.bureau.hooks!.create(HOOK);
    await fireRunEvents(first.bureau);
    await waitForSettledDeliveries(first.bureau, hook.id, 1);
    await first.dispose();

    const second = await openHooksBureau({
      storage: await database.reopen(),
      fetch: receiver.fetch,
      key,
      now,
    });
    cleanups.push(() => second.dispose());
    await resumed(second);

    expect(receiver.calls).toHaveLength(1);
    const [delivery] = await deliveriesOf(second.bureau, hook.id);
    expect(delivery).toMatchObject({ status: 'delivered', attempts: [{ number: 1 }] });
  });

  it('sends nothing from a second process once the first has finished the delivery', async () => {
    const run = await firstProcess();
    await run.stopFirst();
    const storage = await run.database.reopen();
    const receiverA = createReceiver();
    const receiverB = createReceiver();
    const a = await openHooksBureau({ storage, fetch: receiverA.fetch, key, now: run.now });
    cleanups.push(() => a.dispose());
    await resumed(a);
    const [settled] = await waitForSettledDeliveries(a.bureau, run.hook.id, 1);
    expect(settled!.status).toBe('delivered');
    // A second process opening on the same store finds nothing pending and sends nothing.
    const b = await openHooksBureau({ storage, fetch: receiverB.fetch, key, now: run.now });
    cleanups.push(() => b.dispose());
    await resumed(b);
    expect(receiverA.calls).toHaveLength(1);
    expect(receiverB.calls).toHaveLength(0);
  });

  it('refuses at send time a URL the deployment’s policy now refuses, and makes no request', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const hanging = createReceiver(hangUntilAborted);
    const { now } = createClock();
    const first = await openHooksBureau({
      storage: database.storage,
      fetch: hanging.fetch,
      key,
      now,
    });
    const hook = await first.bureau.hooks!.create({ ...HOOK, url: 'http://localhost:9/hook' });
    await fireRunEvents(first.bureau);
    await waitForCondition(() => hanging.calls.length === 1, 'the request never started');
    await first.dispose();

    const receiver = createReceiver();
    const strict = await openHooksBureau({
      storage: await database.reopen(),
      fetch: receiver.fetch,
      key,
      now,
      hooks: { urlPolicy: { allowPrivateNetworks: false } },
    });
    cleanups.push(() => strict.dispose());
    const [delivery] = await waitForSettledDeliveries(strict.bureau, hook.id, 1);

    expect(delivery!.status).toBe('exhausted');
    expect(delivery!.attempts.map((attempt) => attempt.outcome)).toEqual([
      'interrupted',
      'refused',
    ]);
    expect(receiver.calls).toHaveLength(0);
  });
});
