import { createManualRuntimeServices } from '@corvidae/lifecycle';
import { beforeEach, describe, expect, it } from 'bun:test';

import { createMemory } from '../src/create-memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';
import type { Memory, MemoryRecordStorage } from '../src/types';

const DIMENSION = 64;
// Fixed instant standing in for "now" when synthesizing an old timestamp below — only its
// distance from the offset matters, never the real clock.

function createTestMemory(options?: { namespace?: string; deduplicationThreshold?: number }) {
  const storage = createInMemoryMemoryRecordStorage();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({
    embedder,
    storage,
    dimension: DIMENSION,
    ...(options?.namespace !== undefined ? { namespace: options.namespace } : {}),
    ...(options?.deduplicationThreshold !== undefined
      ? { deduplicationThreshold: options.deduplicationThreshold }
      : {}),
  });
  return { memory, storage, embedder };
}

describe('createMemory', () => {
  let memory: Memory;
  let storage: MemoryRecordStorage;
  let embedder: ReturnType<typeof createMockEmbedder>;

  beforeEach(async () => {
    const test = createTestMemory();
    memory = test.memory;
    storage = test.storage;
    embedder = test.embedder;
    await memory.init();
  });

  describe('remember', () => {
    it('stores and returns a MemoryEntry', async () => {
      const entry = await memory.remember('The capital of France is Paris');

      expect(entry.id).toBeTypeOf('string');
      expect(entry.content).toBe('The capital of France is Paris');
      expect(entry.vector).toHaveLength(DIMENSION);
      expect(entry.metadata.namespace).toBe('default');
      expect(entry.metadata.source).toBe('manual');
      expect(entry.createdAt).toBeTypeOf('number');
      expect(entry.updatedAt).toBeTypeOf('number');
    });

    it('derives id, createdAt, and updatedAt from an injected manual runtime rather than the real clock', async () => {
      const runtime = createManualRuntimeServices({ origin: '2026-02-02T00:00:00.000Z' });
      const runtimeStorage = createInMemoryMemoryRecordStorage();
      const runtimeEmbedder = createMockEmbedder(DIMENSION);
      const runtimeMemory = createMemory({
        embedder: runtimeEmbedder,
        storage: runtimeStorage,
        dimension: DIMENSION,
        runtime,
      });
      await runtimeMemory.init();

      const entry = await runtimeMemory.remember('Runtime-controlled entry');

      expect(entry.id).toBe(`${runtime.identifierPrefix}-memory-1`);
      expect(entry.createdAt).toBe(Date.parse('2026-02-02T00:00:00.000Z'));
      expect(entry.updatedAt).toBe(Date.parse('2026-02-02T00:00:00.000Z'));
    });

    it('stores the entry in the underlying storage', async () => {
      const entry = await memory.remember('Hello, world');

      const stored = await storage.get(entry.id, { namespace: 'default' });
      expect(stored).toBeDefined();
      expect(stored!.id).toBe(entry.id);
      expect(stored!.vector).toBeInstanceOf(Float32Array);
    });

    it('preserves provided metadata', async () => {
      const entry = await memory.remember('Remember this', {
        source: 'tool',
        tags: ['important'],
        importance: 0.9,
        conversationId: 'conv-1',
        agentId: 'agent-1',
      });

      expect(entry.metadata.source).toBe('tool');
      expect(entry.metadata.tags).toEqual(['important']);
      expect(entry.metadata.importance).toBe(0.9);
      expect(entry.metadata.conversationId).toBe('conv-1');
      expect(entry.metadata.agentId).toBe('agent-1');
    });

    it('uses the configured default namespace', async () => {
      const { memory: namespacedMemory } = createTestMemory({
        namespace: 'project-alpha',
      });
      await namespacedMemory.init();

      const entry = await namespacedMemory.remember('Namespaced memory');
      expect(entry.metadata.namespace).toBe('project-alpha');
    });

    it('allows overriding namespace via metadata', async () => {
      const entry = await memory.remember('Override namespace', {
        namespace: 'custom',
      });
      expect(entry.metadata.namespace).toBe('custom');
    });

    it('rejects an empty namespace override', async () => {
      // The contract requires a non-empty namespace; an empty string would
      // otherwise be persisted as a real but unreachable-by-default scope.
      await Promise.resolve(
        expect(memory.remember('Empty namespace', { namespace: '' })).rejects.toThrow(
          /namespace must be a non-empty string/,
        ),
      );
    });
  });

  describe('rememberOnce', () => {
    it('stores only one record for divergent content with the same dedupe key', async () => {
      const first = await memory.rememberOnce('original content', {
        namespace: 'once',
        source: 'experiential',
        dedupeKey: 'run-1:0',
      });
      const second = await memory.rememberOnce('different regenerated content', {
        namespace: 'once',
        source: 'experiential',
        dedupeKey: 'run-1:0',
      });

      expect(second.id).toBe(first.id);
      expect(second.content).toBe('original content');
      expect(await memory.count('once')).toBe(1);
    });

    it('rejects an empty dedupe key', async () => {
      await Promise.resolve(
        expect(
          memory.rememberOnce('missing key', {
            source: 'manual',
            dedupeKey: '',
          }),
        ).rejects.toThrow(/dedupeKey must be a non-empty string/),
      );
    });

    it('rejects a non-string dedupe key at the public boundary', async () => {
      await Promise.resolve(
        expect(
          Reflect.apply(memory.rememberOnce, memory, [
            'invalid key',
            {
              source: 'manual',
              dedupeKey: undefined,
            },
          ]),
        ).rejects.toThrow(/dedupeKey must be a non-empty string/),
      );
      await Promise.resolve(
        expect(
          Reflect.apply(memory.rememberOnce, memory, [
            'invalid key',
            {
              source: 'manual',
              dedupeKey: 123,
            },
          ]),
        ).rejects.toThrow(/dedupeKey must be a non-empty string/),
      );
    });

    it('requires a namespace when requireNamespace is true', async () => {
      const strict = createMemory({
        embedder: createMockEmbedder(DIMENSION),
        storage: createInMemoryMemoryRecordStorage(),
        requireNamespace: true,
      });
      await strict.init();

      await Promise.resolve(
        expect(
          strict.rememberOnce('strict namespace', {
            source: 'manual',
            dedupeKey: 'strict-key',
          }),
        ).rejects.toThrow(/Namespace is required/),
      );

      await strict.close();
    });

    it('throws when the configured storage does not support putOnce', async () => {
      const {
        getByDedupeKey: _getByDedupeKey,
        putOnce: _putOnce,
        ...storageWithoutPutOnce
      } = createInMemoryMemoryRecordStorage();
      const unsupportedStorage: MemoryRecordStorage = {
        ...storageWithoutPutOnce,
      };
      const unsupported = createMemory({
        embedder,
        storage: unsupportedStorage,
      });
      await unsupported.init();

      await Promise.resolve(
        expect(
          unsupported.rememberOnce('unsupported storage', {
            source: 'manual',
            dedupeKey: 'unsupported-key',
          }),
        ).rejects.toThrow(/rememberOnce requires storage\.putOnce support/),
      );
    });
  });

  describe('deduplication', () => {
    it('prevents near-duplicate entries', async () => {
      const first = await memory.remember('The capital of France is Paris');
      const second = await memory.remember('The capital of France is Paris');

      expect(second.id).toBe(first.id);
      const totalCount = await storage.count({ namespace: 'default' });
      expect(totalCount).toBe(1);
    });

    it('allows different content through', async () => {
      await memory.remember('The capital of France is Paris');
      await memory.remember('TypeScript is a programming language');

      const totalCount = await storage.count({ namespace: 'default' });
      expect(totalCount).toBe(2);
    });

    it('respects deduplication threshold', async () => {
      // With a very low threshold (0.0), everything deduplicates against the first entry
      const { memory: looseMemory } = createTestMemory({
        deduplicationThreshold: 0.0,
      });
      await looseMemory.init();

      await looseMemory.remember('Hello');
      await looseMemory.remember('Completely different text');

      // Both should be treated as duplicates at threshold 0.0
      const count = await looseMemory.count();
      expect(count).toBe(1);
    });

    it('does not deduplicate when similarity is below threshold', async () => {
      // With threshold of 0.9999, Float32 precision loss prevents
      // even identical text from being deduplicated
      const { memory: strictMemory } = createTestMemory({
        deduplicationThreshold: 0.9999,
      });
      await strictMemory.init();

      await strictMemory.remember('Hello');
      await strictMemory.remember('Completely unrelated topic about cooking');

      // Dissimilar content should not deduplicate
      const count = await strictMemory.count();
      expect(count).toBe(2);
    });
  });
});
