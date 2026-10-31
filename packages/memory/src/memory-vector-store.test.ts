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
  MemoryVectorProfileMissingError,
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
    await store.activeProfile(HASHING);
    expect(await store.createProfile(next)).toBe(true);
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

  it('refuses a vector for a profile it does not hold, so deletion can always find what it stores', async () => {
    const storage = new MemoryStorage();
    const store = createMemoryVectorStore(storage);
    const unregistered: MemoryEmbeddingProfile = { ...HASHING, generation: 7 };
    const refused = await rejectionOf(
      store.put(unregistered, { id: 'a', scope }, { version: 1, vector: new Float32Array(4) }),
    );
    expect(refused).toBeInstanceOf(MemoryVectorProfileMissingError);
    expect(await store.getMany(unregistered, scope, ['a'])).toEqual(new Map());
    expect(await store.listProfiles()).toEqual([]);
    const keys: string[] = [];
    for await (const [key] of storage.scan(DEFAULT_MEMORY_VECTOR_KEY_PREFIX)) keys.push(key);
    expect(keys).toEqual([]);
  });

  it('reads the active profile without storing one', async () => {
    const storage = new MemoryStorage();
    const store = createMemoryVectorStore(storage);
    expect(await store.getActiveProfile()).toBeUndefined();
    expect(await store.listProfiles()).toEqual([]);
    await store.activeProfile(HASHING);
    expect(await store.getActiveProfile()).toEqual(HASHING);
  });

  it('remembers that inline vectors were copied', async () => {
    const storage = new MemoryStorage();
    expect(await createMemoryVectorStore(storage).inlineVectorsCopied()).toBe(false);
    await createMemoryVectorStore(storage).markInlineVectorsCopied();
    expect(await createMemoryVectorStore(storage).inlineVectorsCopied()).toBe(true);
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

  it('queues embeds per profile, only into a profile it holds, and drops them on forget and on profile deletion', async () => {
    const storage = new MemoryStorage();
    const store = createMemoryVectorStore(storage);
    const next: MemoryEmbeddingProfile = { ...HASHING, generation: 2 };
    const missing: MemoryEmbeddingProfile = { ...HASHING, generation: 3 };
    await store.activeProfile(HASHING);
    await store.createProfile(next);
    const untenanted = { namespace: 'shared:notes' };

    expect(await store.enqueueEmbed(HASHING, { id: 'a', scope }, 100)).toBe(true);
    expect(await store.enqueueEmbed(HASHING, { id: 'a', scope }, 200)).toBe(true);
    expect(await store.enqueueEmbed(HASHING, { id: 'b', scope: untenanted }, 300)).toBe(true);
    expect(await store.enqueueEmbed(next, { id: 'a', scope }, 400)).toBe(true);
    expect(await store.enqueueEmbed(missing, { id: 'a', scope }, 500)).toBe(false);

    const queued = await store.listQueuedEmbeds(HASHING, 10);
    // Queuing twice keeps one entry, with the later time.
    expect(
      queued.toSorted((left, right) => left.reference.id.localeCompare(right.reference.id)),
    ).toEqual([
      { reference: { id: 'a', scope }, queuedAt: 200 },
      { reference: { id: 'b', scope: untenanted }, queuedAt: 300 },
    ]);
    expect(await store.listQueuedEmbeds(HASHING, 1)).toHaveLength(1);
    expect(await store.listQueuedEmbeds(missing, 10)).toEqual([]);

    await store.deleteMany([{ id: 'a', scope }]);
    expect(await store.listQueuedEmbeds(HASHING, 10)).toEqual([
      { reference: { id: 'b', scope: untenanted }, queuedAt: 300 },
    ]);
    expect(await store.listQueuedEmbeds(next, 10)).toEqual([]);

    await store.enqueueEmbed(next, { id: 'c', scope }, 600);
    await store.deleteProfile(next);
    expect(await store.listQueuedEmbeds(next, 10)).toEqual([]);
    await store.dequeueEmbed(HASHING, { id: 'b', scope: untenanted });
    expect(await store.listQueuedEmbeds(HASHING, 10)).toEqual([]);
  });

  it('lists queued embeds from past a cursor, wrapping to the front, each at most once', async () => {
    const store = createMemoryVectorStore(new MemoryStorage());
    await store.activeProfile(HASHING);
    for (const id of ['a', 'b', 'c']) {
      expect(await store.enqueueEmbed(HASHING, { id, scope }, 1)).toBe(true);
    }
    const ids = async (limit: number, after?: string): Promise<string[]> => {
      const listed = await store.listQueuedEmbeds(
        HASHING,
        limit,
        after === undefined ? undefined : { id: after, scope },
      );
      return listed.map((entry) => entry.reference.id);
    };

    expect(await ids(2)).toEqual(['a', 'b']);
    expect(await ids(2, 'b')).toEqual(['c', 'a']);
    expect(await ids(10, 'b')).toEqual(['c', 'a', 'b']);
    expect(await ids(10, 'c')).toEqual(['a', 'b', 'c']);
    // A cursor whose entry was dequeued still orders the rest.
    await store.dequeueEmbed(HASHING, { id: 'b', scope });
    expect(await ids(1, 'b')).toEqual(['c']);
    expect(await ids(10, 'b')).toEqual(['c', 'a']);
  });
});
