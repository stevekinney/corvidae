/**
 * COR-1283: direct unit tests for `RacingStorage` and
 * `NoConditionalBatchStorage`'s own Storage-interface plumbing.
 *
 * `workflow-visibility-backfill.test.ts` only ever drives these fixtures
 * through `runWorkflowVisibilityBackfill`, which never calls plain
 * `get`/`put`/`delete` on either wrapper directly (it reads and writes
 * exclusively through `scan`/`batch`/`conditionalBatch`), and refuses to run
 * against `NoConditionalBatchStorage` before touching storage at all — its
 * guard checks `storage.conditionalBatch === undefined` structurally, never
 * calling `capabilities()`. Both classes still implement the full `Storage`
 * interface (required by `implements Storage`), so these tests exercise that
 * plumbing directly: `RacingStorage`'s pass-through delegation to its inner
 * storage, and `NoConditionalBatchStorage`'s documented stub behavior.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../src/storage/memory.ts';
import {
  NoConditionalBatchStorage,
  RacingStorage,
} from './workflow-visibility-backfill.test-support.ts';

describe('RacingStorage — pass-through delegation to its inner storage', () => {
  it('delegates get/put/delete to the inner storage', async () => {
    const inner = new MemoryStorage();
    const racing = new RacingStorage(inner, new Set());

    await racing.put('key-1', new TextEncoder().encode('value-1'));
    expect(await racing.get('key-1')).toEqual(new TextEncoder().encode('value-1'));
    expect(await inner.get('key-1')).toEqual(new TextEncoder().encode('value-1'));

    await racing.delete('key-1');
    expect(await racing.get('key-1')).toBeNull();
    expect(await inner.get('key-1')).toBeNull();
  });

  it('delegates scan and batch to the inner storage', async () => {
    const inner = new MemoryStorage();
    const racing = new RacingStorage(inner, new Set());

    await racing.batch([
      { type: 'put', key: 'key-a', value: new TextEncoder().encode('a') },
      { type: 'put', key: 'key-b', value: new TextEncoder().encode('b') },
    ]);
    const scanned: string[] = [];
    for await (const [key] of racing.scan('key-')) scanned.push(key);

    expect(scanned).toEqual(['key-a', 'key-b']);
    expect(await inner.get('key-b')).toEqual(new TextEncoder().encode('b'));
  });

  it('disposes the inner storage', () => {
    let disposed = false;
    class TrackingDisposeStorage extends MemoryStorage {
      override [Symbol.dispose](): void {
        disposed = true;
        super[Symbol.dispose]();
      }
    }
    const inner = new TrackingDisposeStorage();
    const racing = new RacingStorage(inner, new Set());

    racing[Symbol.dispose]();

    expect(disposed).toBe(true);
  });
});

describe('NoConditionalBatchStorage — documented stub behavior', () => {
  it('reports conditionalBatch: false in its capabilities', () => {
    const storage = new NoConditionalBatchStorage();
    expect(storage.capabilities()).toEqual({
      persistence: 'ephemeral',
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: false,
      boundedRangeDelete: false,
    });
  });

  it('get always resolves null, put/delete/batch are no-ops, and scan yields nothing', async () => {
    const storage = new NoConditionalBatchStorage();

    expect(await storage.get()).toBeNull();
    expect(await storage.put()).toBeUndefined();
    expect(await storage.delete()).toBeUndefined();
    expect(await storage.batch()).toBeUndefined();

    const scanned: unknown[] = [];
    for await (const entry of storage.scan()) scanned.push(entry);
    expect(scanned).toEqual([]);
  });
});
