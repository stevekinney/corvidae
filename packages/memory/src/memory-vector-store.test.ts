import { MemoryStorage } from '@lostgradient/storage';
import { WEFT_RESERVED_KEY_PREFIXES } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';

import { DEFAULT_MEMORY_KEY_PREFIX } from './create-weft-memory-record-storage';
import { DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX } from './governance/ledger';
import {
  createMemoryVectorStore,
  DEFAULT_MEMORY_VECTOR_KEY_PREFIX,
  type MemoryEmbeddingProfile,
  MemoryVectorDimensionError,
} from './memory-vector-store';

const HASHING: MemoryEmbeddingProfile = { embedderId: 'hashing', dimension: 4, generation: 1 };
const scope = { tenantId: 'tenant', namespace: 'private:owner:notes' };

describe('createMemoryVectorStore (COR-1898)', () => {
  it('keeps its prefix disjoint from the records’, the ledger’s, and Weft’s, in both directions', () => {
    for (const other of [
      DEFAULT_MEMORY_KEY_PREFIX,
      DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX,
      ...WEFT_RESERVED_KEY_PREFIXES,
    ]) {
      expect(DEFAULT_MEMORY_VECTOR_KEY_PREFIX.startsWith(other)).toBe(false);
      expect(other.startsWith(DEFAULT_MEMORY_VECTOR_KEY_PREFIX)).toBe(false);
    }
  });

  it('makes the first initial profile active and keeps it when another writer offers a different one', async () => {
    const storage = new MemoryStorage();
    const [first, second] = await Promise.all([
      createMemoryVectorStore(storage).activeProfile(HASHING),
      createMemoryVectorStore(storage).activeProfile({ ...HASHING, embedderId: 'other' }),
    ]);
    expect(second).toEqual(first);
    expect(
      await createMemoryVectorStore(storage).activeProfile({ ...HASHING, generation: 9 }),
    ).toEqual(first);
    expect(await createMemoryVectorStore(storage).listProfiles()).toEqual([first]);
  });

  it('holds one dimension per profile, and keeps profiles of one embedder apart by generation', async () => {
    const store = createMemoryVectorStore(new MemoryStorage());
    const next: MemoryEmbeddingProfile = { ...HASHING, generation: 2 };
    await store.put(
      HASHING,
      { id: 'a', scope },
      { version: 1, vector: new Float32Array([1, 0, 0, 0]) },
    );
    await store.put(
      next,
      { id: 'a', scope },
      { version: 3, vector: new Float32Array([0, 1, 0, 0]) },
    );
    expect(
      await rejectionOf(
        store.put(HASHING, { id: 'b', scope }, { version: 1, vector: new Float32Array([1, 0]) }),
      ),
    ).toBeInstanceOf(MemoryVectorDimensionError);
    expect(
      await rejectionOf(
        store.put(
          HASHING,
          { id: 'b', scope },
          { version: 1, vector: new Float32Array([1, 0, 0, NaN]) },
        ),
      ),
    ).toBeInstanceOf(MemoryVectorDimensionError);

    const first = await store.getMany(HASHING, scope, ['a', 'b']);
    expect([...first.keys()]).toEqual(['a']);
    expect(Array.from(first.get('a')!.vector)).toEqual([1, 0, 0, 0]);
    const second = await store.getMany(next, scope, ['a']);
    expect(second.get('a')!.version).toBe(3);
    expect(await store.getMany(HASHING, { ...scope, namespace: 'elsewhere' }, ['a'])).toEqual(
      new Map(),
    );
  });

  it('deletes a record’s vector from every profile and leaves other records alone', async () => {
    const store = createMemoryVectorStore(new MemoryStorage());
    const next: MemoryEmbeddingProfile = { ...HASHING, generation: 2 };
    await store.activeProfile(HASHING);
    expect(await store.createProfile(next)).toBe(true);
    for (const profile of [HASHING, next]) {
      for (const id of ['a', 'b']) {
        await store.put(profile, { id, scope }, { version: 1, vector: new Float32Array(4) });
      }
    }
    await store.deleteMany([{ id: 'a', scope }]);
    for (const profile of [HASHING, next]) {
      const left = await store.getMany(profile, scope, ['a', 'b']);
      expect([...left.keys()]).toEqual(['b']);
    }
  });

  it('refuses a profile it could not store', async () => {
    const store = createMemoryVectorStore(new MemoryStorage());
    expect(await rejectionOf(store.activeProfile({ ...HASHING, dimension: 0 }))).toBeInstanceOf(
      Error,
    );
    expect(await rejectionOf(store.createProfile({ ...HASHING, embedderId: '' }))).toBeInstanceOf(
      Error,
    );
    expect(() => createMemoryVectorStore(new MemoryStorage(), { keyPrefix: '' })).toThrow();
  });
});
