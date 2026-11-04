import { describe, expect, it } from 'bun:test';

import { MemoryStorage, storageScanWithMetadata, storageStat } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { collect, bytes as encode } from '@lostgradient/storage/testing';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { fenceStorage } from './storage-fence.ts';

describe('fenceStorage', () => {
  // The storage page's Updated column and its "The app wrote a new value at 10:45 AM." alert read
  // the write time through the engine's storage, which is Bureau's fenced view of the host's.
  it('passes the caller storage’s write times through, before and after the fence closes', async () => {
    let clock = Date.UTC(2026, 10, 2, 16, 42);
    using inner = new BunSQLiteStorage(':memory:', { now: () => clock });
    const fence = fenceStorage(inner);
    expect(typeof fence.storage.stat).toBe('function');
    expect(typeof fence.storage.scanWithMetadata).toBe('function');

    await fence.storage.put('memory:preferences', encode('{"tone":"short"}'));
    clock = Date.UTC(2026, 10, 2, 16, 45);
    await fence.storage.put('memory:goals', encode('{"goals":[]}'));

    expect(await storageStat(fence.storage, 'memory:preferences')).toEqual({
      updatedAt: Date.UTC(2026, 10, 2, 16, 42),
    });

    // Closing the fence stops Bureau's writes; a read of what it left behind still answers.
    fence.close();
    expect(await storageStat(fence.storage, 'memory:goals')).toEqual({
      updatedAt: Date.UTC(2026, 10, 2, 16, 45),
    });
    const entries = await collect(storageScanWithMetadata(fence.storage, 'memory:'));
    expect(entries.map(([key, , metadata]) => [key, metadata.updatedAt])).toEqual([
      ['memory:goals', Date.UTC(2026, 10, 2, 16, 45)],
      ['memory:preferences', Date.UTC(2026, 10, 2, 16, 42)],
    ]);
    expect(await throwingRejectionOf(fence.storage.put('memory:goals', encode('{}')))).toThrow(
      'Bureau has stopped writing to its storage',
    );
  });

  it('keeps the write-time reads optional, as they are on the caller’s storage', async () => {
    using inner = new MemoryStorage();
    const fence = fenceStorage(inner);
    expect(fence.storage.stat).toBeUndefined();
    expect(fence.storage.scanWithMetadata).toBeUndefined();

    await fence.storage.put('memory:goals', encode('{}'));
    expect(await storageStat(fence.storage, 'memory:goals')).toEqual({ updatedAt: null });
  });
});
