import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import { beforeEach, describe, expect, it } from 'bun:test';

import { createToolResultCache } from '../../src/idempotency/create-tool-result-cache';
import type { ToolResultCache } from '../../src/idempotency/types';

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

  describe('cache entry decoding', () => {
    it('deletes malformed entries on read', async () => {
      await store.set('malformed-key', JSON.stringify({ status: 'completed' }));

      expect(await cache.getState('malformed-key')).toBeUndefined();
      expect(await store.get('malformed-key')).toBeNull();
    });

    it('deletes non-object entries on read', async () => {
      await store.set('array-key', JSON.stringify([]));

      expect(await cache.getState('array-key')).toBeUndefined();
      expect(await store.get('array-key')).toBeNull();
    });

    it('deletes invalid JSON entries on read', async () => {
      await store.set('invalid-json-key', '{');

      expect(await cache.getState('invalid-json-key')).toBeUndefined();
      expect(await store.get('invalid-json-key')).toBeNull();
    });
  });
});
