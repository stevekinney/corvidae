/**
 * Adapter-level coverage for the operations the shared contract does not reach on its own. Before
 * the adapter moved out of Weft, Weft's engine suites ran these paths; they now have direct tests
 * so the package's coverage floor holds without an engine.
 */
import { describe, expect, it } from 'bun:test';

import { collect } from '@lostgradient/storage/testing';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  createFakeRequest,
  createFakeTransaction,
  withFakeIndexedDb,
} from './indexeddb-fault-harness.test-support.ts';
import { IndexedDBStorage } from './indexeddb.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function createStorage(): IndexedDBStorage {
  return new IndexedDBStorage(`operations-${crypto.randomUUID()}`);
}

describe('IndexedDBStorage has', () => {
  it('reports whether a key exists', async () => {
    const storage = createStorage();
    expect(await storage.has('k:a')).toBe(false);
    await storage.put('k:a', encode('a'));
    expect(await storage.has('k:a')).toBe(true);
    await storage.delete('k:a');
    expect(await storage.has('k:a')).toBe(false);
  });
});

describe('IndexedDBStorage count', () => {
  it('counts only the keys under the prefix', async () => {
    const storage = createStorage();
    await storage.batch([
      { type: 'put', key: 'a:1', value: encode('1') },
      { type: 'put', key: 'a:2', value: encode('2') },
      { type: 'put', key: 'b:1', value: encode('3') },
    ]);
    expect(await storage.count('a:')).toBe(2);
    expect(await storage.count('b:')).toBe(1);
    expect(await storage.count('c:')).toBe(0);
    expect(await storage.count('')).toBe(3);
  });
});

describe('IndexedDBStorage deletePrefix', () => {
  it('removes every key under the prefix and reports how many it removed', async () => {
    const storage = createStorage();
    await storage.batch([
      { type: 'put', key: 'a:1', value: encode('1') },
      { type: 'put', key: 'a:2', value: encode('2') },
      { type: 'put', key: 'b:1', value: encode('3') },
    ]);

    expect(await storage.deletePrefix('a:')).toBe(2);
    expect(await storage.deletePrefix('a:')).toBe(0);
    expect(await collect(storage.keys(''))).toEqual(['b:1']);
  });
});

describe('IndexedDBStorage scoped', () => {
  it('reads and writes through a prefixed view of the same store', async () => {
    const storage = createStorage();
    const scoped = storage.scoped('tenant:');
    await scoped.put('greeting', encode('hello'));

    expect(await storage.get('tenant:greeting')).toEqual(encode('hello'));
    expect(await scoped.get('greeting')).toEqual(encode('hello'));
    expect(await collect(storage.keys('tenant:'))).toEqual(['tenant:greeting']);
  });
});

describe('IndexedDBStorage deleteRange bounds and limits', () => {
  async function seed(keys: string[]): Promise<IndexedDBStorage> {
    const storage = createStorage();
    await storage.batch(keys.map((key) => ({ type: 'put' as const, key, value: encode(key) })));
    return storage;
  }

  it('deletes everything at or above a lower bound when the prefix is empty', async () => {
    const storage = await seed(['a', 'b', 'c']);
    expect(await storage.deleteRange('', { gte: 'b' })).toBe(2);
    expect(await collect(storage.keys(''))).toEqual(['a']);
  });

  it('deletes every match when the limit exceeds the number of matches', async () => {
    const storage = await seed(['k:1', 'k:2']);
    expect(await storage.deleteRange('k:', { gte: 'k:', limit: 5 })).toBe(2);
    expect(await collect(storage.keys('k:'))).toEqual([]);
  });

  it('deletes nothing from a range that holds no keys under a limit', async () => {
    const storage = await seed(['k:1']);
    expect(await storage.deleteRange('k:', { gt: 'k:1', limit: 3 })).toBe(0);
    expect(await collect(storage.keys('k:'))).toEqual(['k:1']);
  });
});

describe('IndexedDBStorage conditionalBatch delete operations', () => {
  it('applies a delete when its condition holds', async () => {
    const storage = createStorage();
    await storage.put('k:a', encode('a'));
    await storage.put('k:b', encode('b'));

    const applied = await storage.conditionalBatch(
      [{ key: 'k:a', expectedValue: encode('a') }],
      [
        { type: 'delete', key: 'k:b' },
        { type: 'put', key: 'k:c', value: encode('c') },
      ],
    );

    expect(applied).toBe(true);
    expect(await storage.has('k:b')).toBe(false);
    expect(await storage.get('k:c')).toEqual(encode('c'));
  });

  it('leaves a key in place when its condition fails', async () => {
    const storage = createStorage();
    await storage.put('k:a', encode('a'));

    const applied = await storage.conditionalBatch(
      [{ key: 'k:a', expectedValue: encode('other') }],
      [{ type: 'delete', key: 'k:a' }],
    );

    expect(applied).toBe(false);
    expect(await storage.has('k:a')).toBe(true);
  });
});

describe('IndexedDBStorage deleteRange transaction errors', () => {
  it('rejects with the transaction error when an uncapped range delete fails', async () => {
    const transactionError = new Error('deleteRange failed');
    const transaction = createFakeTransaction({
      transactionError,
      store: (tx) => ({
        count() {
          const countRequest = createFakeRequest<number>({ result: 2 });
          queueMicrotask(() => countRequest.fireSuccess());
          return countRequest;
        },
        delete() {
          queueMicrotask(() => tx.fireError());
          return createFakeRequest<undefined>({});
        },
      }),
    });

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      expect(await rejectionOf(storage.deleteRange('k:', { gte: 'k:' }))).toBe(transactionError);
    });
  });

  it('rejects with the transaction error when a capped range delete fails', async () => {
    const transactionError = new Error('capped deleteRange failed');
    const transaction = createFakeTransaction({
      transactionError,
      store: (tx) => ({
        openCursor() {
          queueMicrotask(() => tx.fireError());
          return createFakeRequest<IDBCursorWithValue | null>({ result: null });
        },
      }),
    });

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      expect(await rejectionOf(storage.deleteRange('k:', { gte: 'k:', limit: 2 }))).toBe(
        transactionError,
      );
    });
  });
});
