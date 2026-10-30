/**
 * COR-1943 — hook delivery records are kept by age and resumed from a pending index. The
 * lifecycle matrix: a delivery that is pending, in flight, delivered, or failed for good, older or
 * younger than the retention window, and a write that never lands. A pending or in-flight delivery
 * is never pruned and is always resumed; a settled one is pruned once it is older than the window
 * and never resumed; the record and its pending index key never disagree.
 */
import type { EncryptionKey } from '@lostgradient/cryptography';
import {
  type BatchOperation,
  type ConditionalBatchCondition,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import {
  HOOK_DELIVERY_INDEX_BUILT_KEY,
  HOOK_DELIVERY_KEY_PREFIX,
  HOOK_DELIVERY_PENDING_KEY_PREFIX,
  createHookStore,
} from './hook-store.ts';
import type { HookDeliveryRecord, HookDeliveryStatus } from './hook-types.ts';
import {
  createClock,
  createReceiver,
  newEncryptionKey,
  openHooksBureau,
  SIGNING_SECRET,
} from './hooks.test-support.ts';

let key: EncryptionKey;
beforeAll(async () => {
  key = await newEncryptionKey();
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const byText = (a: unknown, b: unknown): number => String(a).localeCompare(String(b));

const DAY = 86_400_000;
const WINDOW = 7 * DAY;

/** Memory storage that records every key read and every conditional batch, and can lose a batch. */
class WatchedStorage extends MemoryStorage {
  readonly reads: string[] = [];
  readonly batches: Array<{
    conditions: ConditionalBatchCondition[];
    operations: BatchOperation[];
  }> = [];
  /** When set, the next conditional batch throws before it applies anything: a crash. */
  crashNextBatch = false;

  override async get(storageKey: string): Promise<Uint8Array | null> {
    this.reads.push(storageKey);
    return super.get(storageKey);
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    if (this.crashNextBatch) {
      this.crashNextBatch = false;
      throw new Error('crash before the batch applied');
    }
    this.batches.push({ conditions, operations });
    return super.conditionalBatch(conditions, operations);
  }
}

function deliveryRecord(
  id: string,
  hookId: string,
  status: HookDeliveryStatus,
  overrides: Partial<HookDeliveryRecord> = {},
): HookDeliveryRecord {
  return {
    version: 1,
    id,
    hookId,
    owner: 'api-key:alice',
    kind: 'run.registered',
    test: false,
    status,
    request: {
      url: 'https://receiver.example/hook',
      headers: { 'Idempotency-Key': id },
      body: '{}',
    },
    attempts: [],
    maxAttempts: 3,
    createdAt: 0,
    updatedAt: 0,
    leaseUntil: 0,
    revision: 0,
    ...overrides,
  };
}

/** Every delivery record paired with whether its pending index key exists. */
async function indexAgreement(storage: MemoryStorage) {
  const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
  const result: Array<{ id: string; status: string; indexed: boolean }> = [];
  for (const recordKey of await kv.list(HOOK_DELIVERY_KEY_PREFIX)) {
    const record = JSON.parse((await kv.get(recordKey))!) as HookDeliveryRecord;
    result.push({
      id: record.id,
      status: record.status,
      indexed: await kv.has(`${HOOK_DELIVERY_PENDING_KEY_PREFIX}${record.id}`),
    });
  }
  return result;
}

type Lifecycle = {
  readonly name: string;
  readonly status: HookDeliveryStatus;
  /** An attempt still `sending` and a lease that has run out: a process died mid-request. */
  readonly inFlight?: boolean;
};

const LIFECYCLES: readonly Lifecycle[] = [
  { name: 'pending', status: 'pending' },
  { name: 'in flight', status: 'pending', inFlight: true },
  { name: 'delivered', status: 'delivered' },
  { name: 'exhausted', status: 'exhausted' },
  { name: 'aborted', status: 'aborted' },
  { name: 'failed-secret', status: 'failed-secret' },
];

const AGES = [
  { name: 'younger than the window', age: WINDOW - DAY },
  { name: 'older than the window', age: WINDOW + DAY },
] as const;

function seededRecord(
  lifecycle: Lifecycle,
  id: string,
  hookId: string,
  writtenAt: number,
): HookDeliveryRecord {
  return deliveryRecord(id, hookId, lifecycle.status, {
    createdAt: writtenAt,
    updatedAt: writtenAt,
    ...(lifecycle.inFlight === true
      ? {
          attempts: [{ number: 1, startedAt: writtenAt, outcome: 'sending' as const }],
          leaseUntil: writtenAt + 60_000,
        }
      : {}),
  });
}

describe('retaining delivery records', () => {
  it.each(
    LIFECYCLES.flatMap((lifecycle) => AGES.map((age) => ({ lifecycle, age }))).map((row) => [
      `${row.lifecycle.name}, ${row.age.name}`,
      row,
    ]),
  )('%s', async (_name, { lifecycle, age }) => {
    const storage = new WatchedStorage();
    const { clock, now } = createClock();
    const opened = await openHooksBureau({
      storage,
      fetch: createReceiver().fetch,
      key,
      now,
      retention: { hookDeliveries: { olderThan: WINDOW } },
    });
    cleanups.push(() => opened.dispose());
    const store = createHookStore(textValueStore(storage, { disposeUnderlyingStorage: false }));
    await store.createDelivery(
      seededRecord(lifecycle, 'delivery-under-test', 'gone', clock.milliseconds - age.age),
    );

    await opened.bureau.maintain();

    const settled = lifecycle.status !== 'pending';
    const pruned = settled && age.age > WINDOW;
    const remaining = await indexAgreement(storage);
    expect(remaining.map((entry) => entry.id)).toEqual(pruned ? [] : ['delivery-under-test']);
    // A pending delivery keeps its index key; nothing else has one.
    for (const entry of remaining) expect(entry.indexed).toBe(entry.status === 'pending');
  });

  it('prunes by the last write, and removes only the settled deliveries of a mixed store', async () => {
    const storage = new WatchedStorage();
    const { clock, now } = createClock();
    const opened = await openHooksBureau({
      storage,
      fetch: createReceiver().fetch,
      key,
      now,
      retention: { hookDeliveries: { olderThan: WINDOW } },
    });
    cleanups.push(() => opened.dispose());
    const store = createHookStore(textValueStore(storage, { disposeUnderlyingStorage: false }));
    const old = clock.milliseconds - 30 * DAY;
    await store.createDelivery(
      deliveryRecord('old-pending', 'gone', 'pending', { updatedAt: old }),
    );
    await store.createDelivery(
      deliveryRecord('old-delivered', 'gone', 'delivered', { updatedAt: old }),
    );
    await store.createDelivery(
      deliveryRecord('old-created-new-written', 'gone', 'delivered', {
        createdAt: old,
        updatedAt: clock.milliseconds - DAY,
      }),
    );

    await opened.bureau.maintain();

    const remaining = await indexAgreement(storage);
    expect(remaining.map((entry) => entry.id).toSorted(byText)).toEqual([
      'old-created-new-written',
      'old-pending',
    ]);
  });

  it('prunes nothing without the setting', async () => {
    const storage = new WatchedStorage();
    const { clock, now } = createClock();
    const opened = await openHooksBureau({ storage, fetch: createReceiver().fetch, key, now });
    cleanups.push(() => opened.dispose());
    const store = createHookStore(textValueStore(storage, { disposeUnderlyingStorage: false }));
    await store.createDelivery(
      deliveryRecord('ancient', 'gone', 'delivered', { updatedAt: clock.milliseconds - 900 * DAY }),
    );

    await opened.bureau.maintain();

    expect(await indexAgreement(storage)).toHaveLength(1);
  });

  it('refuses a window that is not a positive integer', async () => {
    for (const olderThan of [0, -1, 1.5, Number.NaN]) {
      const refusal = await rejectionOf(
        openHooksBureau({
          storage: new MemoryStorage(),
          fetch: createReceiver().fetch,
          key,
          retention: { hookDeliveries: { olderThan } },
        }),
      );
      expect((refusal as Error).message).toContain('options.retention.hookDeliveries');
    }
  });
});

describe('resuming from the pending index', () => {
  async function reopen(lifecycles: readonly Lifecycle[], seed: 'indexed' | 'raw') {
    const storage = new WatchedStorage();
    const { clock, now } = createClock();
    const first = await openHooksBureau({ storage, fetch: createReceiver().fetch, key, now });
    const hook = await first.bureau.hooks!.create({
      url: 'https://receiver.example/hook',
      events: ['run.registered'],
      signingSecret: SIGNING_SECRET,
      principal: 'api-key:alice',
    });
    await first.dispose();

    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    const store = createHookStore(kv);
    const ids = new Map<string, Lifecycle>();
    for (const [index, lifecycle] of lifecycles.entries()) {
      const id = `delivery-${index}`;
      ids.set(id, lifecycle);
      const record = seededRecord(lifecycle, id, hook.id, clock.milliseconds - 30 * DAY);
      if (seed === 'indexed') await store.createDelivery(record);
      else await kv.set(`${HOOK_DELIVERY_KEY_PREFIX}${id}`, JSON.stringify(record));
    }
    if (seed === 'raw') await kv.delete(HOOK_DELIVERY_INDEX_BUILT_KEY);
    storage.reads.length = 0;

    const receiver = createReceiver();
    const second = await openHooksBureau({ storage, fetch: receiver.fetch, key, now });
    cleanups.push(() => second.dispose());
    await second.bureau.internals.webhookNotifier!.flush();
    return { storage, receiver, ids, hook };
  }

  it('drives every pending and in-flight delivery and reads no settled record', async () => {
    const { storage, receiver, ids } = await reopen(LIFECYCLES, 'indexed');

    const driven = receiver.calls
      .map((call) => call.headers.get('Idempotency-Key'))
      .toSorted(byText);
    const expected = [...ids]
      .filter(([, lifecycle]) => lifecycle.status === 'pending')
      .map(([id]) => id)
      .toSorted(byText);
    expect(driven).toEqual(expected);
    const recordsRead = new Set(
      storage.reads.filter((storageKey) => storageKey.startsWith(HOOK_DELIVERY_KEY_PREFIX)),
    );
    for (const [id, lifecycle] of ids) {
      expect(recordsRead.has(`${HOOK_DELIVERY_KEY_PREFIX}${id}`)).toBe(
        lifecycle.status === 'pending',
      );
    }
    for (const entry of await indexAgreement(storage)) {
      expect(entry.indexed).toBe(entry.status === 'pending');
    }
  });

  it('indexes a pending delivery written before the index existed, once', async () => {
    const { storage, receiver, ids } = await reopen(LIFECYCLES, 'raw');

    const driven = receiver.calls
      .map((call) => call.headers.get('Idempotency-Key'))
      .toSorted(byText);
    expect(driven).toEqual(
      [...ids]
        .filter(([, lifecycle]) => lifecycle.status === 'pending')
        .map(([id]) => id)
        .toSorted(byText),
    );
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    expect(await kv.has(HOOK_DELIVERY_INDEX_BUILT_KEY)).toBe(true);
    for (const entry of await indexAgreement(storage)) {
      expect(entry.indexed).toBe(entry.status === 'pending');
    }
  });
});

describe('the record and its index key', () => {
  async function storeOf(storage: WatchedStorage) {
    return createHookStore(textValueStore(storage, { disposeUnderlyingStorage: false }));
  }

  it('are written, replaced and removed in one conditional batch', async () => {
    const storage = new WatchedStorage();
    const store = await storeOf(storage);
    const pending = deliveryRecord('one', 'hook', 'pending');
    await store.createDelivery(pending);
    const stored = (await store.getDelivery('one'))!;
    const delivered = { ...pending, status: 'delivered' as const, revision: 1 };
    await store.replaceDelivery(stored, delivered);
    await store.deleteDelivery((await store.getDelivery('one'))!);

    const touching = storage.batches.filter((batch) =>
      batch.operations.some((operation) => operation.key.includes('one')),
    );
    expect(touching).toHaveLength(3);
    for (const batch of touching) {
      const keys = batch.operations.map((operation) => operation.key);
      expect(keys).toContain(`${HOOK_DELIVERY_KEY_PREFIX}one`);
      expect(keys).toContain(`${HOOK_DELIVERY_PENDING_KEY_PREFIX}one`);
    }
    expect(await indexAgreement(storage)).toEqual([]);
  });

  it.each([
    ['settling', 'delivered'],
    ['staying pending', 'pending'],
  ] as const)('stay together when the write %s never lands', async (_name, next) => {
    const storage = new WatchedStorage();
    const store = await storeOf(storage);
    await store.createDelivery(deliveryRecord('one', 'hook', 'pending'));
    const stored = (await store.getDelivery('one'))!;

    storage.crashNextBatch = true;
    const failure = await rejectionOf(
      store.replaceDelivery(stored, { ...stored.record, status: next, revision: 1 }),
    );
    expect((failure as Error).message).toContain('crash');

    expect(await indexAgreement(storage)).toEqual([
      { id: 'one', status: 'pending', indexed: true },
    ]);
    expect(await store.listPendingDeliveryIds()).toEqual(['one']);
  });

  it('are not written when the record is no longer the one read', async () => {
    const storage = new WatchedStorage();
    const store = await storeOf(storage);
    await store.createDelivery(deliveryRecord('one', 'hook', 'pending'));
    const stale = (await store.getDelivery('one'))!;
    await store.replaceDelivery(stale, { ...stale.record, revision: 1 });

    expect(
      await store.replaceDelivery(stale, { ...stale.record, status: 'delivered', revision: 1 }),
    ).toBe(false);
    expect(await indexAgreement(storage)).toEqual([
      { id: 'one', status: 'pending', indexed: true },
    ]);
  });

  it('go together when a hook is deleted', async () => {
    const storage = new WatchedStorage();
    const store = await storeOf(storage);
    await store.createDelivery(deliveryRecord('one', 'hook-a', 'pending'));
    await store.createDelivery(deliveryRecord('two', 'hook-b', 'pending'));

    await store.deleteDeliveriesOf('hook-a');

    expect(await indexAgreement(storage)).toEqual([
      { id: 'two', status: 'pending', indexed: true },
    ]);
  });
});
