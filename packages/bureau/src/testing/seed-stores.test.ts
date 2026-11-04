/**
 * COR-2009 — `openBureauSeedStores` writes a hook delivery the way the Bureau writes one, over a
 * storage no Bureau runs on: the next Bureau over that storage lists it as the hook's last
 * delivery, with the times the fixture gave it, and sends nothing.
 */
import type { EncryptionKey } from '@lostgradient/cryptography';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import {
  createReceiver,
  newEncryptionKey,
  openHooksBureau,
  SIGNING_SECRET,
} from '../hooks/hooks.test-support.ts';
import { createSqliteStorageFixture } from '../test/storage-fixtures.ts';
import { openBureauSeedStores, type HookDeliveryRecord } from './index.ts';

let key: EncryptionKey;
beforeAll(async () => {
  key = await newEncryptionKey();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Oct 30, 2026, 11:00:03 AM Central: when the sample world's failed run paged on-call. */
const DELIVERED_AT = Date.UTC(2026, 9, 30, 16, 0, 3);

describe('openBureauSeedStores', () => {
  it('writes a delivery the next Bureau lists as the hook’s last, without sending it', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const receiver = createReceiver();

    const first = await openHooksBureau({ storage: database.storage, fetch: receiver.fetch, key });
    const hook = await first.bureau.hooks!.create({
      url: 'https://events.example/page',
      events: ['run.settled'],
      signingSecret: SIGNING_SECRET,
      principal: 'api-key:alice',
      name: 'Page on-call',
    });
    await first.dispose();

    const seeded = openBureauSeedStores(await database.reopen());
    const delivery: HookDeliveryRecord = {
      version: 1,
      id: 'delivery-page-on-call-oct-30',
      hookId: hook.id,
      owner: 'api-key:alice',
      actionType: 'webhook',
      kind: 'run.settled',
      test: false,
      status: 'delivered',
      request: {
        url: 'https://events.example/page',
        headers: { 'content-type': 'application/json' },
        body: '{"kind":"run.settled"}',
      },
      attempts: [
        {
          number: 1,
          startedAt: DELIVERED_AT,
          finishedAt: DELIVERED_AT + 212,
          outcome: 'response',
          status: 202,
        },
      ],
      maxAttempts: 8,
      createdAt: DELIVERED_AT,
      updatedAt: DELIVERED_AT + 212,
      leaseUntil: 0,
      revision: 1,
    };
    expect(await seeded.hooks.createDelivery(delivery)).toBe(true);
    // The same id is never written twice.
    expect(await seeded.hooks.createDelivery(delivery)).toBe(false);
    // A webhook delivery with no request is one the Bureau could not read back, so it is refused.
    const { request: _request, ...unreadable } = delivery;
    const refused = await rejectionOf(
      seeded.hooks.createDelivery({ ...unreadable, id: 'no-request' }),
    );
    expect(String(refused)).toContain('would not read back');
    expect(await seeded.hooks.getDelivery('no-request')).toBeUndefined();

    const second = await openHooksBureau({
      storage: await database.reopen(),
      fetch: receiver.fetch,
      key,
    });
    cleanups.push(() => second.dispose());
    await second.bureau.internals.webhookNotifier!.flush();
    const [listed] = await second.bureau.hooks!.list();
    expect(listed?.lastDelivery).toMatchObject({
      id: 'delivery-page-on-call-oct-30',
      kind: 'run.settled',
      status: 'delivered',
      createdAt: DELIVERED_AT,
      lastAttempt: { number: 1, outcome: 'response', status: 202 },
    });
    expect(receiver.calls).toEqual([]);
  });
});
