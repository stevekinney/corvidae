/**
 * The prefix guard in `LMDBStorage#scan` and `#keys`.
 *
 * Both iterate an lmdb-js range already bounded to the prefix, and they still stop at the first
 * key outside it. The guard is the last defence if a range bound is ever computed wrongly, so
 * these tests give the adapter a database whose range reaches past the prefix and check that
 * nothing outside the prefix is yielded.
 */
import { describe, expect, it } from 'bun:test';

import { LMDBStorage } from './lmdb.ts';

type StrayRangeEntry = { key: string; value: Uint8Array };

function openStrayRangeStorage(keys: readonly string[]): LMDBStorage {
  const entries: StrayRangeEntry[] = keys.map((key) => ({
    key,
    value: new TextEncoder().encode(`value:${key}`),
  }));
  const database = {
    getRange: () => entries,
    getKeys: () => keys,
    close: async () => {},
  };
  return new LMDBStorage('unused', undefined, () => database as never);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterable) results.push(item);
  return results;
}

describe('LMDBStorage prefix guard', () => {
  it('scan stops at the first key past the prefix', async () => {
    const storage = openStrayRangeStorage(['p:a', 'p:b', 'q:c', 'p:d']);

    const entries = await collect(storage.scan('p:'));

    expect(entries.map(([key]) => key)).toEqual(['p:a', 'p:b']);
    await storage.close();
  });

  it('keys stops at the first key past the prefix', async () => {
    const storage = openStrayRangeStorage(['p:a', 'p:b', 'q:c', 'p:d']);

    expect(await collect(storage.keys('p:'))).toEqual(['p:a', 'p:b']);
    await storage.close();
  });
});
