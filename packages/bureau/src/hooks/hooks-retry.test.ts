/**
 * COR-2022 — PageHooks: a failed delivery is retried from its record, not rebuilt from the hook as
 * it is now; a delivery waiting out its backoff says when its next try is due and can be tried at
 * once; and a webhook can be tested before it is saved, which writes nothing.
 */
import type { EncryptionKey } from '@lostgradient/cryptography';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { waitForCondition } from '../test';
import { HOOK_DRAFT_ID, type HookDraftTestInput } from './create-hooks.ts';
import { HOOK_SIGNATURE_HEADER, verifyHookSignature } from './hook-signature.ts';
import { HookError } from './hook-types.ts';
import {
  createClock,
  createManualSleep,
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
    readonly maxAttempts?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const receiver = createReceiver(script);
  const { clock, now } = createClock();
  const bureau = await openHooksBureau({
    storage: new MemoryStorage(),
    fetch: receiver.fetch,
    key,
    now,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  opened.push(bureau);
  return { ...bureau, receiver, clock };
}

const URL_AT_DELIVERY = 'https://events.pagerduty.example/v2/enqueue';

const WEBHOOK = {
  url: URL_AT_DELIVERY,
  events: ['run.registered'],
  principal: 'api-key:alice',
} as const;

describe('retrying a delivery', () => {
  it('re-sends the recorded request, body and key, signed with the current secret, though the hook has changed', async () => {
    let status = 410;
    const { bureau, receiver, clock } = await open(() => new Response('gone', { status }), {
      maxAttempts: 2,
    });
    const hook = await bureau.hooks!.create(WEBHOOK);
    await fireRunEvents(bureau);
    const [exhausted] = await waitForSettledDeliveries(bureau, hook.id, 1);
    expect(exhausted!.status).toBe('exhausted');
    expect(receiver.calls).toHaveLength(2);

    // The hook moves on: a new URL and a new secret. The delivery keeps what it was made with.
    await bureau.hooks!.update(hook.id, { url: 'https://hooks.example.com/moved' });
    const replaced = await bureau.hooks!.replaceSigningSecret(hook.id);
    status = 200;

    const retried = await bureau.hooks!.retryDelivery(hook.id, exhausted!.id, {
      principal: 'api-key:alice',
    });

    expect(retried).toMatchObject({
      id: exhausted!.id,
      status: 'delivered',
      maxAttempts: 3,
    });
    expect(retried!.attempts.map((attempt) => [attempt.number, attempt.status])).toEqual([
      [1, 410],
      [2, 410],
      [3, 200],
    ]);
    expect(retried!.request).toEqual(exhausted!.request);
    expect(receiver.calls).toHaveLength(3);
    const [first, , again] = receiver.calls;
    expect(again!.url).toBe(URL_AT_DELIVERY);
    expect(again!.body).toBe(first!.body);
    expect(again!.headers.get('Idempotency-Key')).toBe(exhausted!.id);
    expect(again!.headers.get('X-Delivery-Id')).toBe(exhausted!.id);
    expect(again!.headers.get('X-Delivery-Attempt')).toBe('3');
    expect(
      verifyHookSignature({
        secret: replaced!.signingSecret,
        header: again!.headers.get(HOOK_SIGNATURE_HEADER)!,
        body: again!.body,
        now: clock.milliseconds,
      }),
    ).toEqual({ ok: true });
    // No answer carries a secret, the one the hook was created with or its replacement.
    for (const answer of [retried, await bureau.hooks!.deliveries(hook.id)]) {
      expect(JSON.stringify(answer)).not.toContain(replaced!.signingSecret);
      expect(JSON.stringify(answer)).not.toContain(hook.signingSecret!);
    }
  });

  it('gives a delivery that fails again one more try only, and ends it exhausted', async () => {
    const { bureau, receiver } = await open(() => new Response('gone', { status: 410 }), {
      maxAttempts: 2,
    });
    const hook = await bureau.hooks!.create(WEBHOOK);
    await fireRunEvents(bureau);
    const [exhausted] = await waitForSettledDeliveries(bureau, hook.id, 1);

    const retried = await bureau.hooks!.retryDelivery(hook.id, exhausted!.id);

    expect(retried).toMatchObject({ status: 'exhausted', maxAttempts: 3 });
    expect(retried!.attempts).toHaveLength(3);
    expect(receiver.calls).toHaveLength(3);
  });

  it('refuses a delivered delivery, and finds nothing through another hook', async () => {
    const { bureau, receiver } = await open();
    const hook = await bureau.hooks!.create(WEBHOOK);
    const other = await bureau.hooks!.create({ ...WEBHOOK, signingSecret: SIGNING_SECRET });
    const tested = await bureau.hooks!.test(hook.id);
    expect(tested!.status).toBe('delivered');

    const refusal = await bureau.hooks!.retryDelivery(hook.id, tested!.id).catch((error) => error);
    expect(refusal).toBeInstanceOf(HookError);
    expect((refusal as HookError).code).toBe('invalid');
    expect(await bureau.hooks!.retryDelivery(other.id, tested!.id)).toBeUndefined();
    expect(await bureau.hooks!.retryDelivery(hook.id, 'delivery-missing')).toBeUndefined();
    expect(receiver.calls).toHaveLength(1);
  });
});

describe('a delivery waiting out its backoff', () => {
  it('says when its next try is due, and is tried at once when retried', async () => {
    const sleep = createManualSleep();
    const { bureau, receiver, clock } = await open(
      (_call, index) =>
        index === 0 ? new Response('busy', { status: 503 }) : new Response('ok', { status: 200 }),
      { sleep: sleep.sleep },
    );
    const hook = await bureau.hooks!.create(WEBHOOK);
    await fireRunEvents(bureau);

    // The backoff sleep is asked for only once the wait can be cut short, after the record says
    // when the next try is due.
    await waitForCondition(
      () => sleep.requested.length === 1,
      'the delivery never waited for its next try',
    );
    const [waiting] = await deliveriesOf(bureau, hook.id);
    expect(waiting!.status).toBe('pending');
    expect(waiting!.attempts).toHaveLength(1);
    expect(sleep.requested).toEqual([1000]);
    expect(waiting!.nextAttemptAt).toBe(clock.milliseconds + 1000);

    // "Retry now": the wait is cut short, and the backoff sleep is never released.
    await bureau.hooks!.retryDelivery(hook.id, waiting!.id);
    const [delivered] = await waitForSettledDeliveries(bureau, hook.id, 1);

    expect(delivered!.status).toBe('delivered');
    expect(delivered!.attempts.map((attempt) => attempt.status)).toEqual([503, 200]);
    expect(delivered!.maxAttempts).toBe(8);
    expect(delivered).not.toHaveProperty('nextAttemptAt');
    expect(receiver.calls).toHaveLength(2);
    expect(receiver.calls[1]!.body).toBe(receiver.calls[0]!.body);
  });
});

describe('testing a webhook before it is saved', () => {
  it('sends one signed test and writes nothing: no hook and no delivery', async () => {
    const { bureau, receiver, clock } = await open();

    const sent = await bureau.hooks!.testDraft({
      url: URL_AT_DELIVERY,
      signingSecret: SIGNING_SECRET,
      principal: 'api-key:alice',
    });

    expect(sent).toMatchObject({
      hookId: HOOK_DRAFT_ID,
      owner: 'api-key:alice',
      kind: 'hook.test',
      test: true,
      status: 'delivered',
      maxAttempts: 1,
    });
    expect(sent.attempts).toEqual([
      expect.objectContaining({ number: 1, outcome: 'response', status: 200 }),
    ]);
    expect(receiver.calls).toHaveLength(1);
    const call = receiver.calls[0]!;
    expect(call.url).toBe(URL_AT_DELIVERY);
    expect(
      verifyHookSignature({
        secret: SIGNING_SECRET,
        header: call.headers.get(HOOK_SIGNATURE_HEADER)!,
        body: call.body,
        now: clock.milliseconds,
      }),
    ).toEqual({ ok: true });
    expect(JSON.stringify(sent)).not.toContain(SIGNING_SECRET);
    expect(await bureau.hooks!.list()).toEqual([]);
    expect(await bureau.hooks!.deliveries(HOOK_DRAFT_ID)).toEqual([]);
  });

  it('answers a receiver that fails as an exhausted delivery, not an error', async () => {
    const { bureau } = await open(() => new Response('nope', { status: 500 }));
    const sent = await bureau.hooks!.testDraft({ url: URL_AT_DELIVERY });
    expect(sent.status).toBe('exhausted');
    expect(sent.attempts[0]).toMatchObject({ outcome: 'response', status: 500 });
  });

  it('refuses a URL and a secret that create would refuse, and sends nothing', async () => {
    const { bureau, receiver } = await open();
    const refused: readonly HookDraftTestInput[] = [
      { url: 'http://169.254.169.254/latest' },
      { url: URL_AT_DELIVERY, signingSecret: 'short' },
    ];
    for (const input of refused) {
      const refusal = await bureau.hooks!.testDraft(input).catch((error) => error);
      expect(refusal).toBeInstanceOf(HookError);
      expect((refusal as HookError).code).toBe('invalid');
    }
    expect(receiver.calls).toHaveLength(0);
  });
});
