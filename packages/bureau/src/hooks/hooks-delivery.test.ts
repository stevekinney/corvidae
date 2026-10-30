/**
 * COR-1939 — `Bureau.hooks` over a real Bureau: hooks match published events, deliveries are
 * signed, keep their request and response, retry, and are audited when exhausted.
 */
import { MemoryStorage, textValueStore, type Storage } from '@lostgradient/storage';
import type { EncryptionKey } from '@lostgradient/cryptography';
import { quietFor } from '@lostgradient/testing/wait-until';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';

import { HOOK_SIGNATURE_HEADER, verifyHookSignature } from './hook-signature.ts';
import { HOOK_DELIVERY_KEY_PREFIX } from './hook-store.ts';
import { HOOK_RESPONSE_EXCERPT_BYTES, type HookDeliveryRecord } from './hook-types.ts';
import {
  createClock,
  createReceiver,
  deliveriesOf,
  fireRunEvents,
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

const opened: OpenedHooksBureau[] = [];
afterEach(async () => {
  for (const bureau of opened.splice(0)) await bureau.dispose();
});

async function open(
  script?: Parameters<typeof createReceiver>[0],
  options: {
    storage?: Storage;
    maxAttempts?: number;
    hooks?: NonNullable<Parameters<typeof openHooksBureau>[0]['hooks']>;
  } = {},
) {
  const receiver = createReceiver(script);
  const { clock, now } = createClock();
  const bureau = await openHooksBureau({
    storage: options.storage ?? new MemoryStorage(),
    fetch: receiver.fetch,
    key,
    now,
    ...options,
  });
  opened.push(bureau);
  return { ...bureau, receiver, clock };
}

const HOOK = {
  url: 'https://receiver.example/hook?token=abc123',
  events: ['run.registered'],
  signingSecret: SIGNING_SECRET,
  principal: 'api-key:alice',
} as const;

describe('a hook on a published event', () => {
  it('delivers a signed webhook that a verifier accepts, and an altered body or timestamp fails', async () => {
    const { bureau, receiver, clock } = await open();
    const hook = await bureau.hooks!.create(HOOK);

    await fireRunEvents(bureau);
    const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);

    expect(delivery!.status).toBe('delivered');
    expect(receiver.calls).toHaveLength(1);
    const call = receiver.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(HOOK.url);
    expect(call.redirect).toBe('manual');
    const header = call.headers.get(HOOK_SIGNATURE_HEADER)!;
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const verify = (body: string, signature = header) =>
      verifyHookSignature({
        secret: SIGNING_SECRET,
        header: signature,
        body,
        now: clock.milliseconds,
      });
    expect(verify(call.body)).toEqual({ ok: true });
    expect(verify(`${call.body} `)).toEqual({ ok: false, reason: 'mismatch' });
    const timestamp = Number(/t=(\d+)/.exec(header)![1]);
    expect(verify(call.body, header.replace(`t=${timestamp}`, `t=${timestamp + 1}`))).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(
      verifyHookSignature({
        secret: 'another-secret-entirely-000000',
        header,
        body: call.body,
        now: clock.milliseconds,
      }),
    ).toEqual({ ok: false, reason: 'mismatch' });

    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: delivery!.id,
      hookId: hook.id,
      kind: 'run.registered',
      bureauId: 'hooks-bureau',
      test: false,
    });
    expect(call.headers.get('Idempotency-Key')).toBe(delivery!.id);
    expect(call.headers.get('X-Delivery-Id')).toBe(delivery!.id);
    expect(call.headers.get('X-Hook-Id')).toBe(hook.id);
    expect(call.headers.get('X-Event-Kind')).toBe('run.registered');
    expect(call.headers.get('X-Delivery-Attempt')).toBe('1');
    expect(call.headers.get('Content-Type')).toBe('application/json');
  });

  it('keeps the request, the response status, a bounded excerpt, the attempts, and the owner on the record', async () => {
    const large = 'x'.repeat(HOOK_RESPONSE_EXCERPT_BYTES * 3);
    const { bureau, receiver } = await open(() => new Response(large, { status: 202 }));
    const hook = await bureau.hooks!.create(HOOK);

    await fireRunEvents(bureau);
    const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);

    expect(delivery).toMatchObject({
      hookId: hook.id,
      owner: 'api-key:alice',
      kind: 'run.registered',
      status: 'delivered',
      request: { url: HOOK.url, body: receiver.calls[0]!.body },
    });
    expect(delivery!.request!.headers['Idempotency-Key']).toBe(delivery!.id);
    // The signature is made fresh for each attempt and is not part of the stored request.
    expect(Object.keys(delivery!.request!.headers).map((name) => name.toLowerCase())).not.toContain(
      'x-signature',
    );
    expect(delivery!.attempts).toHaveLength(1);
    const [attempt] = delivery!.attempts;
    expect(attempt).toMatchObject({
      number: 1,
      outcome: 'response',
      status: 202,
      responseTruncated: true,
    });
    expect(attempt!.responseExcerpt).toHaveLength(HOOK_RESPONSE_EXCERPT_BYTES);
    expect(attempt!.finishedAt).toBeDefined();
  });

  it('fires only on the kinds it lists, and not when disabled', async () => {
    const { bureau, receiver } = await open();
    const settled = await bureau.hooks!.create({ ...HOOK, events: ['run.settled'] });
    const disabled = await bureau.hooks!.create({ ...HOOK, enabled: false });

    await fireRunEvents(bureau);
    const deliveries = await waitForSettledDeliveries(bureau, settled.id, 1);

    expect(deliveries.map((delivery) => delivery.kind)).toEqual(['run.settled']);
    expect(await bureau.hooks!.deliveries(disabled.id)).toEqual([]);
    expect(receiver.calls.map((call) => call.headers.get('X-Event-Kind'))).toEqual(['run.settled']);
  });

  it('retries a failure with the same idempotency key, signs each attempt anew, and ends delivered', async () => {
    const { bureau, receiver, clock } = await open((_call, index) => {
      if (index === 0) return new Response('busy', { status: 503 });
      if (index === 1) throw new TypeError('connection reset');
      return new Response('ok');
    });
    const hook = await bureau.hooks!.create(HOOK);
    await fireRunEvents(bureau);
    const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);

    expect(delivery!.status).toBe('delivered');
    expect(
      delivery!.attempts.map((attempt) => [attempt.number, attempt.outcome, attempt.status]),
    ).toEqual([
      [1, 'response', 503],
      [2, 'network-error', undefined],
      [3, 'response', 200],
    ]);
    expect(delivery!.attempts[0]!.responseExcerpt).toBe('busy');
    expect(delivery!.attempts[1]!.error).toBe('connection reset');
    expect(receiver.calls.map((call) => call.headers.get('X-Delivery-Attempt'))).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(new Set(receiver.calls.map((call) => call.headers.get('Idempotency-Key')))).toEqual(
      new Set([delivery!.id]),
    );
    for (const call of receiver.calls) {
      expect(
        verifyHookSignature({
          secret: SIGNING_SECRET,
          header: call.headers.get(HOOK_SIGNATURE_HEADER)!,
          body: call.body,
          now: clock.milliseconds,
        }),
      ).toEqual({ ok: true });
    }
  });

  it('treats a redirect as a failure and never follows it', async () => {
    const { bureau, receiver } = await open(
      () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
      { maxAttempts: 2 },
    );
    const hook = await bureau.hooks!.create(HOOK);
    await fireRunEvents(bureau);
    const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);

    expect(delivery!.status).toBe('exhausted');
    expect(delivery!.attempts.map((attempt) => attempt.status)).toEqual([302, 302]);
    expect(receiver.calls.map((call) => call.url)).toEqual([HOOK.url, HOOK.url]);
  });

  it('is exhausted after the last attempt, and audits it without the URL or the secret', async () => {
    const { bureau, receiver } = await open(() => new Response('no', { status: 500 }), {
      maxAttempts: 3,
    });
    const hook = await bureau.hooks!.create(HOOK);
    await fireRunEvents(bureau);
    const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);

    expect(delivery!.status).toBe('exhausted');
    expect(receiver.calls).toHaveLength(3);
    const entries = await bureau.audit.query({ runId: `hook:${hook.id}` });
    expect(entries.records.map((entry) => entry.type)).toEqual([
      'hook.created',
      'hook.delivery.exhausted',
    ]);
    expect(entries.records[1]!.detail).toMatchObject({ hookId: hook.id, attempts: 3 });
    const text = JSON.stringify(entries);
    expect(text).not.toContain('token=abc123');
    expect(text).not.toContain(SIGNING_SECRET);
  });

  it('never delivers the diagnostic its own failure raises', async () => {
    const { bureau, receiver } = await open(() => new Response('no', { status: 500 }), {
      maxAttempts: 1,
    });
    const hook = await bureau.hooks!.create({ ...HOOK, events: ['diagnostic', 'run.registered'] });
    await fireRunEvents(bureau);
    await waitForSettledDeliveries(bureau, hook.id, 1);
    const kinds = receiver.calls.map((call) => call.headers.get('X-Event-Kind'));
    expect(kinds.filter((kind) => kind === 'diagnostic')).toEqual([]);
  });

  it('aborts a delivery whose hook is deleted before it finishes, and removes its records', async () => {
    const { bureau } = await open(() => new Response('no', { status: 500 }), { maxAttempts: 3 });
    const hook = await bureau.hooks!.create(HOOK);
    await bureau.hooks!.delete(hook.id);
    await fireRunEvents(bureau);
    expect(await bureau.hooks!.get(hook.id)).toBeUndefined();
    expect(await bureau.hooks!.deliveries(hook.id)).toEqual([]);
  });
});

describe('a delivery whose circumstances change', () => {
  it('is aborted when the hook is disabled after an attempt failed, and sends nothing more', async () => {
    const holder: { disable?: () => Promise<unknown> } = {};
    const { bureau, receiver } = await open(
      async () => {
        await holder.disable?.();
        return new Response('no', { status: 500 });
      },
      { maxAttempts: 5 },
    );
    const hook = await bureau.hooks!.create(HOOK);
    holder.disable = () => bureau.hooks!.update(hook.id, { enabled: false });

    await fireRunEvents(bureau);
    const [delivery] = await waitForSettledDeliveries(bureau, hook.id, 1);

    expect(delivery!.status).toBe('aborted');
    expect(delivery!.attempts).toHaveLength(1);
    expect(receiver.calls).toHaveLength(1);
  });

  it('stops without writing when another writer took the record during the request', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const { bureau, receiver } = await open(
      async () => {
        const [recordKey] = await kv.list(HOOK_DELIVERY_KEY_PREFIX);
        const taken = await kv.get(recordKey!);
        const record = JSON.parse(taken!) as HookDeliveryRecord;
        // Another process resumed the delivery: it moved the revision on.
        await kv.set(recordKey!, JSON.stringify({ ...record, revision: record.revision + 1 }));
        return new Response('no', { status: 500 });
      },
      { storage },
    );
    const hook = await bureau.hooks!.create(HOOK);

    await fireRunEvents(bureau);
    await bureau.internals.webhookNotifier!.flush();

    // The first writer lost the fence at the end of its attempt and did nothing further.
    expect(receiver.calls).toHaveLength(1);
    const [delivery] = await deliveriesOf(bureau, hook.id);
    expect(delivery!.attempts.map((attempt) => attempt.outcome)).toEqual(['sending']);
    expect(delivery!.status).toBe('pending');
  });
});

describe('hooks.test', () => {
  it('sends one signed hook.test delivery with one attempt and returns its record', async () => {
    const { bureau, receiver, clock } = await open(() => new Response('pong', { status: 200 }));
    const hook = await bureau.hooks!.create({ ...HOOK, enabled: false });

    const delivery = await bureau.hooks!.test(hook.id);

    expect(delivery).toMatchObject({
      kind: 'hook.test',
      test: true,
      status: 'delivered',
      hookId: hook.id,
    });
    expect(delivery!.attempts).toHaveLength(1);
    expect(delivery!.attempts[0]).toMatchObject({ status: 200, responseExcerpt: 'pong' });
    const call = receiver.calls[0]!;
    expect(JSON.parse(call.body)).toMatchObject({ kind: 'hook.test', test: true });
    expect(
      verifyHookSignature({
        secret: SIGNING_SECRET,
        header: call.headers.get(HOOK_SIGNATURE_HEADER)!,
        body: call.body,
        now: clock.milliseconds,
      }),
    ).toEqual({ ok: true });
  });

  it('is not retried when it fails, and the failure is an answer', async () => {
    const { bureau, receiver } = await open(() => new Response('no', { status: 500 }));
    const hook = await bureau.hooks!.create(HOOK);
    const delivery = await bureau.hooks!.test(hook.id);
    expect(delivery!.status).toBe('exhausted');
    expect(delivery!.attempts).toHaveLength(1);
    expect(receiver.calls).toHaveLength(1);
  });

  it('answers undefined for a hook that does not exist', async () => {
    const { bureau } = await open();
    expect(await bureau.hooks!.test('nope')).toBeUndefined();
  });
});

/** A storage whose `failing`th creation of a hook delivery record fails (1-based). */
function failingDeliveryCreation(storage: Storage, failing: number) {
  const counts = { created: 0, failed: false };
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      const call = (...args: unknown[]) =>
        (member as (...rest: unknown[]) => unknown).apply(target, args);
      if (String(property) !== 'conditionalBatch') return call;
      return async (...args: unknown[]) => {
        const text = JSON.stringify(args);
        if (text.includes(HOOK_DELIVERY_KEY_PREFIX) && text.includes('"expectedValue":null')) {
          counts.created += 1;
          if (counts.created === failing) {
            counts.failed = true;
            throw new Error('the delivery record could not be stored');
          }
        }
        return call(...args);
      };
    },
  });
  return { storage: proxy, counts };
}

describe('an event that matches several hooks when a later delivery cannot be stored', () => {
  it('still waits for the deliveries it already started before flush() settles', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const diagnostics: string[] = [];
    const failing = failingDeliveryCreation(new MemoryStorage(), 2);
    const receiver = createReceiver(async () => {
      await held;
      return new Response('ok');
    });
    const bureau = await openHooksBureau({
      storage: failing.storage,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      fetch: receiver.fetch,
      key,
    });
    opened.push(bureau);
    const first = await bureau.bureau.hooks!.create(HOOK);
    await bureau.bureau.hooks!.create({ ...HOOK, name: 'second' });

    let flushed = false;
    let flushing: Promise<void> = Promise.resolve();
    let fired: Promise<void> = Promise.resolve();
    try {
      // Starting a task waits for its run, and the run for its hook deliveries: not awaited here.
      fired = fireRunEvents(bureau.bureau);
      await waitForCondition(
        async () => receiver.calls.length === 1 && failing.counts.failed,
        'the first delivery never started, or the second enqueue never failed',
      );

      flushing = bureau.bureau.internals.webhookNotifier!.flush().then(() => {
        flushed = true;
      });
      await quietFor(50);
      expect(flushed).toBe(false);
    } finally {
      release();
    }
    await Promise.all([fired, flushing]);
    const [delivery] = await deliveriesOf(bureau.bureau, first.id);
    expect(delivery!.status).toBe('delivered');
    expect(diagnostics.some((message) => message.includes('Failed to dispatch'))).toBe(true);
  });
});
