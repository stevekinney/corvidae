import { describe, expect, it } from 'bun:test';

import { storageScanWithMetadata, storageStat } from './entry-metadata.ts';
import type { Storage } from './interface.ts';
import { MemoryStorage } from './memory.ts';
import { scopedStorage } from './scoped-storage.ts';
import { bytes, collect } from './testing/storage-test-primitives.test-support.ts';

describe('storage entry metadata', () => {
  it('answers an unknown write time for a backend that records none, and null for an absent key', async () => {
    await using storage = new MemoryStorage();
    expect(Reflect.get(storage, 'stat')).toBeUndefined();
    await storage.put('memory:goals', bytes('g'));

    expect(await storageStat(storage, 'memory:goals')).toEqual({ updatedAt: null });
    expect(await storageStat(storage, 'memory:absent')).toBeNull();
    const entries = await collect(storageScanWithMetadata(storage, 'memory:', { limit: 1 }));
    expect(entries).toEqual([['memory:goals', bytes('g'), { updatedAt: null }]]);
  });

  it('dispatches to a backend’s own stat and metadata scan, through a scoped view too', async () => {
    await using inner = new MemoryStorage();
    await inner.put('tenant:log:server', bytes('line'));
    const reads: string[] = [];
    const recording: Storage = Object.assign(Object.create(inner) as Storage, {
      async stat(key: string) {
        reads.push(`stat ${key}`);
        return (await inner.get(key)) === null ? null : { updatedAt: 1_700 };
      },
      async *scanWithMetadata(prefix: string) {
        reads.push(`scan ${prefix}`);
        for await (const [key, value] of inner.scan(prefix))
          yield [key, value, { updatedAt: 1_700 }];
      },
    });
    const scoped = scopedStorage(recording, 'tenant');

    expect(await storageStat(scoped, 'log:server')).toEqual({ updatedAt: 1_700 });
    expect(await collect(storageScanWithMetadata(scoped, 'log:'))).toEqual([
      ['log:server', bytes('line'), { updatedAt: 1_700 }],
    ]);
    expect(reads).toEqual(['stat tenant:log:server', 'scan tenant:log:']);
  });
});
