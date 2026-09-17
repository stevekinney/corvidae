import { beforeEach, describe, expect, it } from 'bun:test';
import { createMemory } from '../src/create-memory';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';
import type { Memory } from '../src/types';

const DIMENSION = 64;
function createTestMemory(options?: { namespace?: string; deduplicationThreshold?: number }) {
  const storage = createInMemoryMemoryRecordStorage();
  const embedder = createMockEmbedder(DIMENSION);
  const memory = createMemory({ embedder, storage, dimension: DIMENSION, ...options });
  return { memory, storage, embedder };
}

describe('createMemory scoping and options', () => {
  let memory: Memory;
  let storage: ReturnType<typeof createInMemoryMemoryRecordStorage>;
  beforeEach(async () => {
    const test = createTestMemory();
    memory = test.memory;
    storage = test.storage;
    await memory.init();
  });

  describe('namespace scoping', () => {
    it('isolates entries between namespaces', async () => {
      await memory.remember('Entry in A', { namespace: 'namespace-a' });
      await memory.remember('Entry in B', { namespace: 'namespace-b' });

      expect(await memory.count('namespace-a')).toBe(1);
      expect(await memory.count('namespace-b')).toBe(1);
      expect(await memory.count()).toBe(0);
    });
  });

  describe('Float32Array conversion', () => {
    it('stores vectors as Float32Array in storage', async () => {
      const entry = await memory.remember('Test Float32Array');

      const stored = await storage.get(entry.id, { namespace: 'default' });
      expect(stored!.vector).toBeInstanceOf(Float32Array);
    });

    it('returns vectors as number[] in MemoryEntry', async () => {
      const entry = await memory.remember('Test number array');

      expect(Array.isArray(entry.vector)).toBe(true);
      expect(entry.vector).toHaveLength(DIMENSION);
      for (const value of entry.vector) {
        expect(value).toBeTypeOf('number');
      }
    });

    it('round-trips vectors correctly', async () => {
      const entry = await memory.remember('Round trip test');

      const stored = await storage.get(entry.id, { namespace: 'default' });
      const roundTripped = Array.from(stored!.vector);

      // Float32 has limited precision compared to Float64 (number),
      // so we compare with tolerance
      for (let i = 0; i < entry.vector.length; i++) {
        expect(roundTripped[i] ?? 0).toBeCloseTo(entry.vector[i] ?? 0, 5);
      }
    });
  });
});

describe('init and close', () => {
  it('initializes storage on init', async () => {
    const testStorage = createInMemoryMemoryRecordStorage();
    const testMemory = createMemory({
      embedder: createMockEmbedder(DIMENSION),
      storage: testStorage,
    });

    // Should not throw
    await testMemory.init();
  });

  it('closes storage on close', async () => {
    const testStorage = createInMemoryMemoryRecordStorage();
    const testMemory = createMemory({
      embedder: createMockEmbedder(DIMENSION),
      storage: testStorage,
    });

    await testMemory.init();
    // Should not throw
    await testMemory.close();
  });
});

describe('default search options', () => {
  it('applies defaultSearchOptions when recall is called without options', async () => {
    const testStorage = createInMemoryMemoryRecordStorage();
    const testMemory = createMemory({
      embedder: createMockEmbedder(DIMENSION),
      storage: testStorage,
      defaultSearchOptions: { limit: 1 },
    });
    await testMemory.init();

    await testMemory.remember('One');
    await testMemory.remember('Two');
    await testMemory.remember('Three');

    const results = await testMemory.recall('test');
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('allows overriding defaultSearchOptions per call', async () => {
    const testStorage = createInMemoryMemoryRecordStorage();
    const testMemory = createMemory({
      embedder: createMockEmbedder(DIMENSION),
      storage: testStorage,
      defaultSearchOptions: { limit: 1 },
    });
    await testMemory.init();

    await testMemory.remember('One');
    await testMemory.remember('Two');
    await testMemory.remember('Three');

    const results = await testMemory.recall('test', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
