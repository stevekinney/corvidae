import { beforeEach, describe, expect, it } from 'bun:test';
import { createMemory } from '../src/create-memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';
import type { TextSearchProvider } from '../src/text-search-provider';
import type { Memory } from '../src/types';
const DIMENSION = 64;
const FIXED_NOW = Date.parse('2026-01-01T00:00:00.000Z');
function createTestMemory(options?: { namespace?: string; deduplicationThreshold?: number }) {
  const storage = createInMemoryMemoryRecordStorage();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({ embedder, storage, dimension: DIMENSION, ...options });
  return { memory, storage, embedder };
}

describe('createMemory lifecycle', () => {
  let memory: Memory;
  let storage: ReturnType<typeof createInMemoryMemoryRecordStorage>;
  let embedder: ReturnType<typeof createMockEmbedder>;
  beforeEach(async () => {
    const test = createTestMemory();
    memory = test.memory;
    storage = test.storage;
    embedder = test.embedder;
    await memory.init();
  });
  describe('recall', () => {
    it('returns relevant results', async () => {
      await memory.remember('The capital of France is Paris');
      await memory.remember('TypeScript is a programming language');
      await memory.remember('Bun is a JavaScript runtime');

      const results = await memory.recall('programming languages');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBeTypeOf('string');
      expect(results[0]!.content).toBeTypeOf('string');
      expect(results[0]!.score).toBeTypeOf('number');
      expect(results[0]!.metadata).toBeDefined();
      expect(results[0]!.createdAt).toBeTypeOf('number');
    });

    it('returns results sorted by score descending', async () => {
      await memory.remember('Alpha');
      await memory.remember('Beta');
      await memory.remember('Gamma');

      const results = await memory.recall('Alpha');

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
      }
    });

    it('respects the limit option', async () => {
      await memory.remember('One');
      await memory.remember('Two');
      await memory.remember('Three');

      const results = await memory.recall('test', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('applies temporal decay when configured', async () => {
      // Store an entry with a very old timestamp by manually writing to storage.
      const vector = embedder(['old memory'])[0];
      const float32Vector = new Float32Array(vector ?? []);
      const oldTimestamp = FIXED_NOW - 30 * 24 * 60 * 60 * 1000; // 30 days ago

      await storage.put({
        id: 'old-entry',
        namespace: 'default',
        content: 'old memory',
        vector: float32Vector,
        metadata: { source: 'manual' },
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp,
        version: 1,
        status: 'active',
      });

      // Store a recent entry
      await memory.remember('fresh memory');

      const resultsWithoutDecay = await memory.recall('memory');
      const resultsWithDecay = await memory.recall('memory', {
        temporalDecay: { halfLifeMilliseconds: 7 * 24 * 60 * 60 * 1000 }, // 7-day half-life
      });

      // The old entry's score should be reduced with decay
      const oldWithoutDecay = resultsWithoutDecay.find((r) => r.id === 'old-entry');
      const oldWithDecay = resultsWithDecay.find((r) => r.id === 'old-entry');

      if (oldWithoutDecay && oldWithDecay) {
        expect(oldWithDecay.score).toBeLessThan(oldWithoutDecay.score);
      }
    });

    it('applies MMR diversity when configured', async () => {
      // Store several entries
      await memory.remember('JavaScript is a language');
      await memory.remember('TypeScript is a language');
      await memory.remember('Rust is a language');
      await memory.remember('Cooking pasta is fun');

      const results = await memory.recall('programming languages', {
        limit: 4,
        diversify: { lambda: 0.5 },
      });

      // MMR should return results — exact order depends on the algorithm
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(4);
    });

    it('scopes recall to namespace', async () => {
      await memory.remember('Default namespace entry');
      await memory.remember('Custom namespace entry', {
        namespace: 'custom',
      });

      const defaultResults = await memory.recall('entry');
      const customResults = await memory.recall('entry', {
        namespace: 'custom',
      });

      const defaultIds = defaultResults.map((r) => r.id);
      const customIds = customResults.map((r) => r.id);

      // They should not overlap
      for (const id of customIds) {
        expect(defaultIds).not.toContain(id);
      }
    });

    it('returns empty array for no matches', async () => {
      const results = await memory.recall('anything');
      expect(results).toEqual([]);
    });

    it('does not include vectors in search results', async () => {
      await memory.remember('Test entry');

      const results = await memory.recall('test');

      for (const result of results) {
        expect(Object.hasOwn(result, 'vector')).toBe(false);
      }
    });
  });

  describe('forget', () => {
    it('removes an entry by id', async () => {
      const entry = await memory.remember('To be forgotten');

      await memory.forget(entry.id);

      const count = await memory.count();
      expect(count).toBe(0);
    });

    it('does not affect other entries', async () => {
      const first = await memory.remember('Keep this');
      const second = await memory.remember('Remove this');

      await memory.forget(second.id);

      const count = await memory.count();
      expect(count).toBe(1);

      const results = await memory.recall('Keep this');
      expect(results.some((r) => r.id === first.id)).toBe(true);
    });

    it('does not strip the text index when the scoped delete removed nothing', async () => {
      // Regression: textSearchProvider.remove(id) is keyed by bare id while
      // storage.delete is scope-keyed. A wrong-namespace forget must NOT evict the
      // index entry of the record still living under its real namespace.
      const removeCalls: string[] = [];
      const textSearchProvider: TextSearchProvider = {
        async init() {},
        async close() {},
        async index() {},
        async remove(id: string) {
          removeCalls.push(id);
        },
        async clear() {},
        async search() {
          return new Map<string, number>();
        },
      };
      const indexedStorage = createInMemoryMemoryRecordStorage();
      const indexedMemory = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage: indexedStorage,
        dimension: DIMENSION,
        namespace: 'real',
        textSearchProvider,
      });
      await indexedMemory.init();

      const entry = await indexedMemory.remember('Indexed memory');

      // Wrong namespace: nothing is deleted, and the index entry must survive.
      await indexedMemory.forget(entry.id, 'wrong');
      expect(removeCalls).toEqual([]);
      expect(await indexedStorage.get(entry.id, { namespace: 'real' })).toBeDefined();

      // Right namespace: the record is removed and the index entry is evicted once.
      await indexedMemory.forget(entry.id, 'real');
      expect(removeCalls).toEqual([entry.id]);
      expect(await indexedStorage.get(entry.id, { namespace: 'real' })).toBeUndefined();
    });
  });

  describe('forgetAll', () => {
    it('clears all entries in the default namespace', async () => {
      await memory.remember('Entry one');
      await memory.remember('Entry two');
      await memory.remember('Entry three');

      await memory.forgetAll();

      const count = await memory.count();
      expect(count).toBe(0);
    });

    it('clears only the specified namespace', async () => {
      await memory.remember('Default entry');
      await memory.remember('Custom entry', { namespace: 'custom' });

      await memory.forgetAll('custom');

      const defaultCount = await memory.count();
      const customCount = await memory.count('custom');

      expect(defaultCount).toBe(1);
      expect(customCount).toBe(0);
    });

    it('handles empty namespace gracefully', async () => {
      await memory.forgetAll('nonexistent');
      // Should not throw
    });
  });

  describe('count', () => {
    it('returns zero for empty memory', async () => {
      const count = await memory.count();
      expect(count).toBe(0);
    });

    it('returns the correct count after remember', async () => {
      await memory.remember('One');
      await memory.remember('Two');
      await memory.remember('Three');

      const count = await memory.count();
      expect(count).toBe(3);
    });

    it('counts only entries in the specified namespace', async () => {
      await memory.remember('Default one');
      await memory.remember('Default two');
      await memory.remember('Custom one', { namespace: 'custom' });

      const defaultCount = await memory.count();
      const customCount = await memory.count('custom');

      expect(defaultCount).toBe(2);
      expect(customCount).toBe(1);
    });

    it('decrements after forget', async () => {
      const entry = await memory.remember('Will be forgotten');
      await memory.remember('Will remain');

      await memory.forget(entry.id);

      const count = await memory.count();
      expect(count).toBe(1);
    });
  });
});
