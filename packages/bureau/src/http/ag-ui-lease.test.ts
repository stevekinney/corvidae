/**
 * The mount's durable leases: a held lease is not given to another claimant, an
 * expired one is taken over by exactly one, and a claimant that was taken over can
 * neither renew nor release what its successor holds.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createMemoryStorageFixture } from '../test/storage-fixtures.ts';
import { AG_UI_LEASE_KEY_PREFIX, createAgUiLeases, DEFAULT_AG_UI_LEASE_MS } from './ag-ui-lease.ts';

async function withLeases<T>(
  body: (context: {
    runtime: ReturnType<typeof createManualRuntimeServices>;
    leases: ReturnType<typeof createAgUiLeases>;
    other: ReturnType<typeof createAgUiLeases>;
    keys: () => Promise<string[]>;
  }) => Promise<T>,
): Promise<T> {
  const fixture = createMemoryStorageFixture();
  const kv = textValueStore(fixture.configuration, { disposeUnderlyingStorage: false });
  const runtime = createManualRuntimeServices();
  // A second claimant with a clock of its own, as another process has.
  const otherRuntime = createManualRuntimeServices();
  try {
    return await body({
      runtime: otherRuntime,
      leases: createAgUiLeases({ kv, runtime }),
      other: createAgUiLeases({ kv, runtime: otherRuntime }),
      keys: () => kv.list(`${AG_UI_LEASE_KEY_PREFIX}:`),
    });
  } finally {
    await fixture.dispose();
  }
}

describe('a lease', () => {
  it('is held by one claimant, and another finds it taken', async () => {
    await withLeases(async ({ leases, other }) => {
      const first = await leases.acquire('thread', 'thread-1');
      const second = await other.acquire('thread', 'thread-1');
      const elsewhere = await other.acquire('thread', 'thread-2');

      expect(first).toBeDefined();
      expect(second).toBeUndefined();
      expect(elsewhere).toBeDefined();
      await first!.release();
      await elsewhere!.release();
    });
  });

  it('is free again once released, and its record is gone', async () => {
    await withLeases(async ({ leases, other, keys }) => {
      const first = await leases.acquire('resume', 'a:b');
      await first!.release();

      expect(await keys()).toEqual([]);
      expect(await other.acquire('resume', 'a:b')).toBeDefined();
    });
  });

  it('is taken over only once it has expired by the taker’s clock', async () => {
    await withLeases(async ({ runtime, leases, other }) => {
      const held = await leases.acquire('thread', 'thread-1');
      await runtime.advance(DEFAULT_AG_UI_LEASE_MS - 1);
      expect(await other.acquire('thread', 'thread-1')).toBeUndefined();

      await runtime.advance(1);
      const taken = await other.acquire('thread', 'thread-1');

      expect(held).toBeDefined();
      expect(taken).toBeDefined();
    });
  });

  it('cannot be renewed or released by a claimant that was taken over', async () => {
    await withLeases(async ({ runtime, leases, other }) => {
      const dead = await leases.acquire('thread', 'thread-1');
      await runtime.advance(DEFAULT_AG_UI_LEASE_MS);
      const successor = await other.acquire('thread', 'thread-1');

      expect(await dead!.renew()).toBe(false);
      await dead!.release();

      // The successor still holds it, and nobody else can take it.
      expect(await successor!.renew()).toBe(true);
      expect(await leases.acquire('thread', 'thread-1')).toBeUndefined();
    });
  });

  it('is kept by a claimant that renews, and the renewal timer goes with the release', async () => {
    await withLeases(async ({ runtime, leases, other }) => {
      const held = await other.acquire('resume', 'key');
      expect(runtime.pendingTimers()).toHaveLength(1);

      await held!.renew();
      await held!.release();

      expect(runtime.pendingTimers()).toHaveLength(0);
      expect(await leases.acquire('resume', 'key')).toBeDefined();
    });
  });
});
