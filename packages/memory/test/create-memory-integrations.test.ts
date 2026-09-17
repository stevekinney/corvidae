import { beforeEach, describe, expect, it } from 'bun:test';
import { createMemory } from '../src/create-memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';
import type { TextSearchProvider } from '../src/text-search-provider';
import type { Memory } from '../src/types';

const DIMENSION = 64;
function createTestMemory(options?: { namespace?: string; deduplicationThreshold?: number }) {
  const storage = createInMemoryMemoryRecordStorage();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({ embedder, storage, dimension: DIMENSION, ...options });
  return { memory, storage, embedder };
}

describe('createMemory integrations', () => {
  let memory: Memory;
  beforeEach(async () => {
    memory = createTestMemory().memory;
    await memory.init();
  });
  describe('text search and cache integrations', () => {
    it('re-indexes duplicate entries through the text search provider', async () => {
      const textSearchIndexCalls: Array<{ id: string; content: string; namespace: string }> = [];
      const textSearchProvider = {
        async init() {},
        async close() {},
        async index(id: string, content: string, namespace: string) {
          textSearchIndexCalls.push({ id, content, namespace });
        },
        async remove() {},
        async clear() {},
        async search() {
          return new Map<string, number>();
        },
      } satisfies TextSearchProvider;

      const textSearchMemory = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage: createInMemoryMemoryRecordStorage(),
        dimension: DIMENSION,
        textSearchProvider,
      });
      await textSearchMemory.init();

      const firstEntry = await textSearchMemory.remember('duplicate content for indexing');
      const secondEntry = await textSearchMemory.remember('duplicate content for indexing');

      expect(secondEntry.id).toBe(firstEntry.id);
      expect(textSearchIndexCalls).toEqual([
        {
          id: firstEntry.id,
          content: 'duplicate content for indexing',
          namespace: 'default',
        },
        {
          id: firstEntry.id,
          content: 'duplicate content for indexing',
          namespace: 'default',
        },
      ]);

      await textSearchMemory.close();
    });

    it('routes recall scoring, forget, and forgetAll through the text search provider', async () => {
      const removedIds: string[] = [];
      const clearedNamespaces: Array<string | undefined> = [];
      // The provider scores documents by entry id; recall() maps those scores
      // onto the hybrid candidates so we can prove the provider-driven branch
      // contributes to ranking instead of the in-memory BM25 fallback.
      const scoreById = new Map<string, number>();
      const textSearchProvider = {
        async init() {},
        async close() {},
        async index() {},
        async remove(id: string) {
          removedIds.push(id);
        },
        async clear(namespace?: string) {
          clearedNamespaces.push(namespace);
        },
        async search() {
          return new Map(scoreById);
        },
      } satisfies TextSearchProvider;

      const providerMemory = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage: createInMemoryMemoryRecordStorage(),
        dimension: DIMENSION,
        textSearchProvider,
      });
      await providerMemory.init();

      const target = await providerMemory.remember('provider scored memory');
      await providerMemory.remember('unscored memory');

      // Give the target a strong provider-side text score so it ranks first.
      scoreById.set(target.id, 0.9);

      const results = await providerMemory.recall('provider scored memory');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.id).toBe(target.id);

      await providerMemory.forget(target.id);
      expect(removedIds).toEqual([target.id]);

      await providerMemory.forgetAll();
      expect(clearedNamespaces).toEqual(['default']);

      await providerMemory.close();
    });

    it('indexes rememberOnce hits through the text search provider using stored content', async () => {
      const textSearchIndexCalls: Array<{ id: string; content: string; namespace: string }> = [];
      const textSearchProvider = {
        async init() {},
        async close() {},
        async index(id: string, content: string, namespace: string) {
          textSearchIndexCalls.push({ id, content, namespace });
        },
        async remove() {},
        async clear() {},
        async search() {
          return new Map<string, number>();
        },
      } satisfies TextSearchProvider;

      const textSearchMemory = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage: createInMemoryMemoryRecordStorage(),
        dimension: DIMENSION,
        textSearchProvider,
      });
      await textSearchMemory.init();

      const firstEntry = await textSearchMemory.rememberOnce('keyed content for indexing', {
        namespace: 'indexed-once',
        source: 'experiential',
        dedupeKey: 'indexed-key',
      });
      const secondEntry = await textSearchMemory.rememberOnce('different keyed content', {
        namespace: 'indexed-once',
        source: 'experiential',
        dedupeKey: 'indexed-key',
      });

      expect(secondEntry.id).toBe(firstEntry.id);
      expect(textSearchIndexCalls).toEqual([
        {
          id: firstEntry.id,
          content: 'keyed content for indexing',
          namespace: 'indexed-once',
        },
        {
          id: firstEntry.id,
          content: 'keyed content for indexing',
          namespace: 'indexed-once',
        },
      ]);

      await textSearchMemory.close();
    });

    it('repairs rememberOnce text search indexing after a failed initial index', async () => {
      const textSearchIndexCalls: Array<{ id: string; content: string; namespace: string }> = [];
      let failNextIndex = true;
      const textSearchProvider = {
        async init() {},
        async close() {},
        async index(id: string, content: string, namespace: string) {
          if (failNextIndex) {
            failNextIndex = false;
            throw new Error('temporary text index failure');
          }
          textSearchIndexCalls.push({ id, content, namespace });
        },
        async remove() {},
        async clear() {},
        async search() {
          return new Map<string, number>();
        },
      } satisfies TextSearchProvider;

      const textSearchMemory = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage: createInMemoryMemoryRecordStorage(),
        dimension: DIMENSION,
        textSearchProvider,
      });
      await textSearchMemory.init();

      await Promise.resolve(
        expect(
          textSearchMemory.rememberOnce('keyed content for indexing', {
            namespace: 'indexed-once',
            source: 'experiential',
            dedupeKey: 'repair-index-key',
          }),
        ).rejects.toThrow(/temporary text index failure/),
      );
      const secondEntry = await textSearchMemory.rememberOnce('different keyed content', {
        namespace: 'indexed-once',
        source: 'experiential',
        dedupeKey: 'repair-index-key',
      });

      expect(secondEntry.content).toBe('keyed content for indexing');
      expect(textSearchIndexCalls).toEqual([
        {
          id: secondEntry.id,
          content: 'keyed content for indexing',
          namespace: 'indexed-once',
        },
      ]);

      await textSearchMemory.close();
    });

    it('applies temporal decay and MMR in vector-only recall mode', async () => {
      await memory.remember('alpha reference memory');
      await memory.remember('beta reference memory');
      await memory.remember('gamma reference memory');

      const results = await memory.recall('reference memory', {
        vectorOnly: true,
        limit: 2,
        temporalDecay: { halfLifeMilliseconds: 7 * 24 * 60 * 60 * 1000 },
        diversify: { lambda: 0.5 },
      });

      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.content).toContain('reference memory');
      }
    });

    it('clears the embedder cache for the forgotten namespace when supported', async () => {
      const clearedNamespaces: string[] = [];
      const embedderWithNamespaceClear = Object.assign(createMockEmbedder(DIMENSION), {
        async clearNamespace(namespace: string) {
          clearedNamespaces.push(namespace);
        },
      });

      const cachedMemory = createMemory({
        embedder: embedderWithNamespaceClear,
        storage: createInMemoryMemoryRecordStorage(),
        dimension: DIMENSION,
      });
      await cachedMemory.init();

      await cachedMemory.remember('default namespace entry');
      await cachedMemory.remember('custom namespace entry', { namespace: 'project-alpha' });

      await cachedMemory.forgetAll('project-alpha');

      expect(clearedNamespaces).toEqual(['project-alpha']);

      await cachedMemory.close();
    });
  });
});
