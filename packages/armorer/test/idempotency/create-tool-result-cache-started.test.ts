import { createManualRuntimeServices, type ManualRuntimeServices } from '@corvidae/lifecycle';
import { beforeEach, describe, expect, it } from 'bun:test';

import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import type { CachedToolResult, ToolResultCache } from '../../src/idempotency/types';

/**
 * Minimal in-memory KeyValueStore for testing without depending on the storage package.
 */
function createTestStore() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix: string) =>
      [...map.keys()].filter((key) => key.startsWith(prefix)).toSorted(),
    _map: map,
  };
}

describe('createToolResultCache', () => {
  let store: ReturnType<typeof createTestStore>;
  let cache: ToolResultCache;
  let runtime: ManualRuntimeServices;

  beforeEach(() => {
    store = createTestStore();
    runtime = createManualRuntimeServices();
    cache = createToolResultCache({ store, defaultTTL: 60_000, now: runtime.clock.now });
  });

  describe('started executions', () => {
    it('stores and retrieves a started state separately from completed results', async () => {
      await cache.claimStarted('started-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: runtime.clock.now(),
        ttl: 60_000,
      });

      expect(await cache.get('started-key')).toBeUndefined();
      expect(await cache.getState('started-key')).toEqual({
        status: 'started',
        toolName: 'charge-card',
        startedAt: expect.any(Number),
        ttl: 60_000,
      });
    });

    it('returns an existing entry when claiming an already completed key', async () => {
      const completed: CachedToolResult = {
        result: { ok: true },
        toolName: 'charge-card',
        executedAt: runtime.clock.now(),
        ttl: 60_000,
      };
      await cache.set('completed-key', completed);

      expect(
        await cache.claimStarted('completed-key', {
          status: 'started',
          toolName: 'charge-card',
          startedAt: runtime.clock.now(),
          ttl: 60_000,
        }),
      ).toMatchObject({ outcome: 'existing', entry: { ...completed, status: 'completed' } });
    });

    it('serializes concurrent claims for the same key within a cache instance', async () => {
      const firstClaim = cache.claimStarted('racing-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: runtime.clock.now(),
        ttl: 60_000,
      });
      const secondClaim = cache.claimStarted('racing-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: runtime.clock.now(),
        ttl: 60_000,
      });

      const results = await Promise.all([firstClaim, secondClaim]);

      expect(results.filter((result) => result.outcome === 'claimed')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'existing')).toHaveLength(1);
      expect(await cache.getState('racing-key')).toEqual(
        expect.objectContaining({
          status: 'started',
          toolName: 'charge-card',
        }),
      );
    });

    it('continues serializing claims after an earlier claim fails', async () => {
      const map = new Map<string, string>();
      let writes = 0;
      const failingCache = createToolResultCache({
        store: {
          get: async (key: string) => map.get(key) ?? null,
          set: async (key: string, value: string) => {
            writes++;
            if (writes === 1) {
              throw new Error('write failed');
            }
            map.set(key, value);
          },
          delete: async (key: string) => {
            map.delete(key);
          },
          list: async (prefix: string) =>
            [...map.keys()].filter((key) => key.startsWith(prefix)).toSorted(),
        },
        defaultTTL: 60_000,
        now: runtime.clock.now,
      });

      const firstClaim = failingCache
        .claimStarted('recover-key', {
          status: 'started',
          toolName: 'charge-card',
          startedAt: runtime.clock.now(),
          ttl: 60_000,
        })
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
      const secondClaim = failingCache.claimStarted('recover-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: runtime.clock.now(),
        ttl: 60_000,
      });

      expect(await firstClaim).toBe('write failed');
      expect(await secondClaim).toEqual({ outcome: 'claimed' });
      expect(await failingCache.getState('recover-key')).toEqual(
        expect.objectContaining({
          status: 'started',
          toolName: 'charge-card',
        }),
      );
    });

    it('preserves stale started state as an unknown outcome', async () => {
      await cache.claimStarted('expired-started-key', {
        status: 'started',
        toolName: 'charge-card',
        startedAt: runtime.clock.now() - 120_000,
        ttl: 60_000,
      });

      expect(await cache.getState('expired-started-key')).toEqual(
        expect.objectContaining({ status: 'started', toolName: 'charge-card' }),
      );
      expect(await store.get('expired-started-key')).not.toBeNull();
    });

    it('reads legacy completed entries without a status field', async () => {
      await store.set(
        'legacy-key',
        JSON.stringify({
          result: 'legacy-result',
          toolName: 'legacy-tool',
          executedAt: runtime.clock.now(),
          ttl: 60_000,
        }),
      );

      expect(await cache.get('legacy-key')).toEqual({
        status: 'completed',
        result: 'legacy-result',
        toolName: 'legacy-tool',
        executedAt: expect.any(Number),
        ttl: 60_000,
      });
    });

    it('reads legacy started entries without an attempt fence', async () => {
      await store.set(
        'legacy-started-key',
        JSON.stringify({
          status: 'started',
          toolName: 'legacy-charge',
          startedAt: 1_000,
          ttl: 60_000,
        }),
      );

      expect(await cache.get('legacy-started-key')).toBeUndefined();
      expect(await cache.getState('legacy-started-key')).toEqual({
        status: 'started',
        toolName: 'legacy-charge',
        startedAt: 1_000,
        ttl: 60_000,
      });
    });

    it('replaces only matching legacy started entries with a new fenced attempt', async () => {
      await store.set(
        'legacy-started-key',
        JSON.stringify({
          status: 'started',
          toolName: 'legacy-charge',
          startedAt: 1_000,
          ttl: 60_000,
        }),
      );

      expect(
        await cache.replaceLegacyStarted(
          'legacy-started-key',
          { toolName: 'legacy-charge', startedAt: 999 },
          {
            status: 'started',
            toolName: 'legacy-charge',
            startedAt: 2_000,
            ttl: 60_000,
            attemptId: 'replacement-attempt',
          },
          2_000,
        ),
      ).toBe(false);
      expect(
        await cache.replaceLegacyStarted(
          'legacy-started-key',
          { toolName: 'legacy-charge', startedAt: 1_000 },
          {
            status: 'started',
            toolName: 'legacy-charge',
            startedAt: 2_000,
            ttl: 60_000,
          },
          2_000,
        ),
      ).toBe(false);
      expect(
        await cache.replaceLegacyStarted(
          'legacy-started-key',
          { toolName: 'legacy-charge', startedAt: 1_000 },
          {
            status: 'started',
            toolName: 'legacy-charge',
            startedAt: 2_000,
            ttl: 60_000,
            attemptId: 'replacement-attempt',
          },
          2_000,
        ),
      ).toBe(true);

      expect(await cache.getState('legacy-started-key')).toEqual(
        expect.objectContaining({
          status: 'started',
          toolName: 'legacy-charge',
          startedAt: 2_000,
          attemptId: 'replacement-attempt',
        }),
      );
    });

    it('does not replace fenced or actively leased entries through the legacy path', async () => {
      await cache.claimStarted('fenced-key', {
        status: 'started',
        toolName: 'charge',
        startedAt: 1_000,
        ttl: 60_000,
        attemptId: 'current-attempt',
      });
      await store.set(
        'active-legacy-key',
        JSON.stringify({
          status: 'started',
          toolName: 'legacy-charge',
          startedAt: 1_000,
          ttl: 60_000,
          leaseExpiresAt: 3_000,
        }),
      );

      expect(
        await cache.replaceLegacyStarted(
          'fenced-key',
          { toolName: 'charge', startedAt: 1_000 },
          {
            status: 'started',
            toolName: 'charge',
            startedAt: 2_000,
            ttl: 60_000,
            attemptId: 'replacement-attempt',
          },
          2_000,
        ),
      ).toBe(false);
      expect(
        await cache.replaceLegacyStarted(
          'active-legacy-key',
          { toolName: 'legacy-charge', startedAt: 1_000 },
          {
            status: 'started',
            toolName: 'legacy-charge',
            startedAt: 2_000,
            ttl: 60_000,
            attemptId: 'replacement-attempt',
          },
          2_000,
        ),
      ).toBe(false);

      expect(await cache.getState('fenced-key')).toEqual(
        expect.objectContaining({ attemptId: 'current-attempt' }),
      );
      expect(await cache.getState('active-legacy-key')).toEqual(
        expect.objectContaining({ leaseExpiresAt: 3_000 }),
      );
    });
  });
});
