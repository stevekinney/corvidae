/**
 * COR-1898 part 1: governed memory keeps each record's vector in the vector store, under the
 * active embedding profile, and admission, recall, and deletion go through that profile.
 */
import { MemoryStorage } from '@lostgradient/storage';
import type { Embedder } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';

import { createEmbedderRegistry } from '../../src/embedder-registry';
import { createGovernedEmbedding } from '../../src/governance/governed-embedding';
import type { CreateGovernedMemoryOptions } from '../../src/governance/governed-memory-types';
import { collectionNamespace } from '../../src/governance/record-governance';
import { HASHING_EMBEDDER_DIMENSION } from '../../src/hashing-embedder';
import {
  createMemoryVectorStore,
  DEFAULT_MEMORY_VECTOR_KEY_PREFIX,
  type MemoryEmbeddingProfile,
  MemoryVectorDimensionError,
  type MemoryVectorReference,
  type MemoryVectorStore,
} from '../../src/memory-vector-store';
import { createTestEmbedders, TEST_EMBEDDER_ID } from '../../src/test/index';
import {
  createGovernedFixture,
  type GovernedBackend,
  type GovernedFixture,
  principalA,
  recordIdOf,
} from './governed-memory-harness';

const DIMENSION = 8;

/** One axis per word it knows (`alpha`, `beta`), and the last axis for any other text. */
function axis(index: number): number[] {
  return Array.from({ length: DIMENSION }, (_, position) => (position === index ? 1 : 0));
}

const keyword: Embedder = (texts) =>
  texts.map((text) =>
    text.includes('alpha') ? axis(0) : text.includes('beta') ? axis(1) : axis(7),
  );

const PROFILE: MemoryEmbeddingProfile = {
  embedderId: TEST_EMBEDDER_ID,
  dimension: DIMENSION,
  generation: 1,
};

function referenceTo(id: string): MemoryVectorReference {
  return {
    id,
    scope: {
      tenantId: principalA.tenantId,
      namespace: collectionNamespace('private', principalA.ownerId, 'notes'),
    },
  };
}

async function writeNote(fixture: GovernedFixture, content: string): Promise<string> {
  return recordIdOf(
    fixture.memory.write(principalA, content, { collection: 'notes', source: 'conversation' }),
  );
}

/** Every vector key the durable storage holds, in any profile. */
async function storedVectorKeys(fixture: GovernedFixture): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of fixture.durable.scan(`${DEFAULT_MEMORY_VECTOR_KEY_PREFIX}v:`)) {
    keys.push(key);
  }
  return keys;
}

/**
 * The fixture's vector store, whose first `put` runs `race` before it writes, so the race finishes
 * after the record is stored and before its vector is.
 */
function puttingAfter(
  fixture: GovernedFixture,
  race: (reference: MemoryVectorReference) => Promise<unknown>,
): Pick<CreateGovernedMemoryOptions, 'vectors'> {
  const vectors = createMemoryVectorStore(fixture.durable);
  let raced = false;
  const racing: MemoryVectorStore = {
    ...vectors,
    put: async (profile, reference, entry) => {
      if (!raced) {
        raced = true;
        await race(reference);
      }
      return vectors.put(profile, reference, entry);
    },
  };
  return { vectors: racing };
}

for (const backend of ['in-memory', 'weft'] as const satisfies readonly GovernedBackend[]) {
  describe(`governed memory through the active embedding profile (${backend})`, () => {
    async function fixtureWith(embedder: Embedder = keyword): Promise<GovernedFixture> {
      return createGovernedFixture(backend, {
        governed: createTestEmbedders(embedder, DIMENSION),
      });
    }

    it('stores an admitted record’s vector in the active profile, never on the record', async () => {
      const fixture = await fixtureWith();
      const id = await writeNote(fixture, 'alpha note');
      const vectors = createMemoryVectorStore(fixture.durable);
      const reference = referenceTo(id);

      const stored = await vectors.getMany(PROFILE, reference.scope, [id]);
      expect(Array.from(stored.get(id)!.vector)).toEqual(axis(0));
      expect(stored.get(id)!.version).toBe(1);
      const record = await fixture.storage.get(id, reference.scope);
      expect(record!.vector.length).toBe(0);
      expect(await fixture.memory.embedding.status()).toEqual({
        active: { embedder: TEST_EMBEDDER_ID, dimension: DIMENSION },
      });
    });

    it('recalls by the active profile’s vectors, not by what the embedder would make now', async () => {
      const fixture = await fixtureWith();
      const alpha = await writeNote(fixture, 'alpha note');
      const beta = await writeNote(fixture, 'beta note');
      const vectors = createMemoryVectorStore(fixture.durable);
      // The profile now says the beta note is about alpha, and the alpha note about nothing.
      await vectors.put(PROFILE, referenceTo(beta), {
        version: 1,
        vector: new Float32Array(axis(0)),
      });
      await vectors.put(PROFILE, referenceTo(alpha), {
        version: 1,
        vector: new Float32Array(axis(7)),
      });

      const bundle = await fixture.memory.recallForModel(principalA, 'alpha', {
        collection: 'notes',
      });
      const semantic = new Map(
        bundle.candidates.map((candidate) => [candidate.recordId, candidate.scores?.semantic]),
      );
      expect(semantic.get(beta)).toBeCloseTo(1);
      expect(semantic.get(alpha)).toBeCloseTo(0);

      const hits = await fixture.memory.search(principalA, 'alpha', { collection: 'notes' });
      expect(hits[0]?.record.id).toBe(beta);
    });

    it('scores a record its profile holds no vector for by its text alone', async () => {
      const fixture = await fixtureWith();
      const alpha = await writeNote(fixture, 'alpha note');
      const vectors = createMemoryVectorStore(fixture.durable);
      await vectors.deleteMany([referenceTo(alpha)]);

      const bundle = await fixture.memory.recallForModel(principalA, 'alpha', {
        collection: 'notes',
      });
      const candidate = bundle.candidates.find((item) => item.recordId === alpha);
      expect(candidate?.scores?.semantic).toBe(0);
    });

    it('deletes a forgotten record’s vector from every profile', async () => {
      const fixture = await fixtureWith();
      const id = await writeNote(fixture, 'alpha note');
      const vectors = createMemoryVectorStore(fixture.durable);
      const reference = referenceTo(id);
      // A second profile, as a later embedding would make, that also holds the record.
      const other: MemoryEmbeddingProfile = { ...PROFILE, generation: 2 };
      expect(await vectors.createProfile(other)).toBe(true);
      expect(await vectors.createProfile(other)).toBe(false);
      await vectors.put(other, reference, { version: 1, vector: new Float32Array(axis(0)) });

      const deleted = await fixture.memory.delete(principalA, { id, collection: 'notes' });
      expect(deleted.status).toBe('applied');
      expect(await vectors.getMany(PROFILE, reference.scope, [id])).toEqual(new Map());
      expect(await vectors.getMany(other, reference.scope, [id])).toEqual(new Map());
    });

    it('refuses a vector of another dimension than the profile’s, storing nothing', async () => {
      const short: Embedder = (texts) => texts.map(() => [1, 0, 0, 0]);
      const fixture = await fixtureWith(short);
      const scope = referenceTo('unused').scope;

      const write = fixture.memory.write(principalA, 'alpha note', {
        collection: 'notes',
        source: 'conversation',
      });
      expect(
        await write.then(
          () => undefined,
          (error: unknown) => error,
        ),
      ).toBeInstanceOf(MemoryVectorDimensionError);
      expect(await fixture.storage.count(scope)).toBe(0);
      const vectors = createMemoryVectorStore(fixture.durable);
      expect(
        await rejectionOf(
          vectors.put(PROFILE, referenceTo('direct'), {
            version: 1,
            vector: new Float32Array([1, 0, 0, 0]),
          }),
        ),
      ).toBeInstanceOf(MemoryVectorDimensionError);
      expect(await vectors.getMany(PROFILE, scope, ['direct'])).toEqual(new Map());
    });

    it('keeps the stored active profile, and queues admissions, when a restart registers its embedder with another dimension', async () => {
      const fixture = await fixtureWith();
      await writeNote(fixture, 'alpha note');
      const restarted = fixture.restart(
        createTestEmbedders(
          (texts) => texts.map(() => Array.from({ length: HASHING_EMBEDDER_DIMENSION }, () => 1)),
          HASHING_EMBEDDER_DIMENSION,
        ),
      );
      // The profile's embedder is unavailable (COR-1898 part 2b): nothing embeds with a model of
      // another dimension, the admission is stored, and its embed waits in the queue.
      await recordIdOf(
        restarted.write(principalA, 'beta note', { collection: 'notes', source: 'conversation' }),
      );
      expect(await restarted.embedding.status()).toEqual({
        active: { embedder: TEST_EMBEDDER_ID, dimension: DIMENSION },
        problem: 'embedder-unavailable',
      });
      expect(await storedVectorKeys(fixture)).toHaveLength(1);
      const queued: string[] = [];
      for await (const [key] of fixture.durable.scan(`${DEFAULT_MEMORY_VECTOR_KEY_PREFIX}q:`)) {
        queued.push(key);
      }
      expect(queued).toHaveLength(1);
    });

    it('leaves no vector behind for a record deleted while its vector was being written', async () => {
      const fixture = await fixtureWith();
      const writing = fixture.restart(
        puttingAfter(fixture, async (reference) => {
          const deleted = await fixture.memory.delete(principalA, {
            id: reference.id,
            collection: 'notes',
          });
          expect(deleted.status).toBe('applied');
        }),
      );

      const receipt = await writing.write(principalA, 'alpha note', {
        collection: 'notes',
        source: 'conversation',
      });
      expect(receipt.status).toBe('admitted');
      expect(await storedVectorKeys(fixture)).toEqual([]);
    });

    it('leaves no vector behind for a promoted copy whose source was deleted while it was written', async () => {
      const fixture = await fixtureWith();
      const source = await writeNote(fixture, 'alpha note');
      const promoting = fixture.restart(
        puttingAfter(fixture, async () => {
          const deleted = await fixture.memory.delete(principalA, {
            id: source,
            collection: 'notes',
          });
          expect(deleted.status).toBe('applied');
        }),
      );

      const promoted = await promoting.promote(principalA, { id: source, collection: 'notes' });
      expect(promoted.status).not.toBe('applied');
      expect(await fixture.storage.list(referenceTo(source).scope)).toEqual([]);
      expect(await fixture.ledger.listPendingDerivations({})).toEqual([]);
      expect(await storedVectorKeys(fixture)).toEqual([]);
    });

    it('compares a provenance-expanded source from another collection with the other candidates', async () => {
      const fixture = await fixtureWith();
      const source = await recordIdOf(
        fixture.memory.write(principalA, 'alpha source', {
          collection: 'archive',
          source: 'conversation',
        }),
      );
      await recordIdOf(
        fixture.memory.write(principalA, 'beta summary', {
          collection: 'notes',
          source: 'conversation',
          derivedFrom: { kind: 'summary', sources: [{ id: source, collection: 'archive' }] },
        }),
      );
      const claim = await writeNote(fixture, 'alpha claim');

      const bundle = await fixture.memory.recallForModel(principalA, 'beta', {
        collection: 'notes',
        plan: {
          minimumScore: 0.5,
          stages: ['semantic', 'rank-fusion', 'provenance-expansion', 'counterevidence'],
        },
      });
      expect(bundle.evidence.map((item) => item.id)).toContain(source);
      expect(bundle.contradictions).toContainEqual({
        recordId: claim,
        contradicts: source,
        kind: 'conflicting-candidate',
      });
    });

    it('copies a vector a record held inline before profiles into the initial profile, once', async () => {
      const fixture = await fixtureWith();
      const alpha = await writeNote(fixture, 'alpha note');
      const beta = await writeNote(fixture, 'beta note');
      const vectors = createMemoryVectorStore(fixture.durable);
      // The shape a store had before COR-1898: vectors on the records, none in any profile, and no
      // mark that they were ever copied. The beta note's profile vector stays, as one embedded since.
      await vectors.deleteMany([referenceTo(alpha)]);
      await vectors.put(PROFILE, referenceTo(beta), {
        version: 1,
        vector: new Float32Array(axis(7)),
      });
      for (const [id, inline] of [
        [alpha, axis(0)],
        [beta, axis(1)],
      ] as const) {
        const record = await fixture.storage.get(id, referenceTo(id).scope);
        await fixture.storage.put({ ...record!, vector: new Float32Array(inline) });
      }
      await fixture.durable.delete(`${DEFAULT_MEMORY_VECTOR_KEY_PREFIX}inline-vectors-copied`);

      const restarted = fixture.restart();
      await restarted.init();

      const stored = await vectors.getMany(PROFILE, referenceTo(alpha).scope, [alpha, beta]);
      expect(Array.from(stored.get(alpha)!.vector)).toEqual(axis(0));
      expect(stored.get(alpha)!.version).toBe(1);
      expect(Array.from(stored.get(beta)!.vector)).toEqual(axis(7));
      const bundle = await restarted.recallForModel(principalA, 'alpha', { collection: 'notes' });
      const semantic = bundle.candidates.find((candidate) => candidate.recordId === alpha);
      expect(semantic?.scores?.semantic).toBeCloseTo(1);

      let puts = 0;
      const counting: MemoryVectorStore = {
        ...vectors,
        put: async (...input) => {
          puts += 1;
          return vectors.put(...input);
        },
      };
      await vectors.deleteMany([referenceTo(alpha)]);
      await fixture.restart({ vectors: counting }).init();
      expect(puts).toBe(0);
    });

    it('reports each registered id’s availability', async () => {
      const fixture = await createGovernedFixture(backend, {
        governed: {
          initialEmbedder: 'hashing',
          embedders: createEmbedderRegistry([
            {
              id: 'remote',
              embedder: keyword,
              dimension: DIMENSION,
              availability: () => 'needs-setup',
            },
          ]),
        },
      });
      expect(fixture.memory.embedding.availability('hashing')).toBe('available');
      expect(fixture.memory.embedding.availability('remote')).toBe('needs-setup');
      expect(fixture.memory.embedding.availability('missing')).toBe('not-loaded');
      expect(await fixture.memory.embedding.status()).toEqual({
        active: { embedder: 'hashing', dimension: HASHING_EMBEDDER_DIMENSION },
      });
    });
  });
}

describe('governed embedding status', () => {
  it('reports the initial profile of a store with none, without storing it', async () => {
    const vectors = createMemoryVectorStore(new MemoryStorage());
    const embedding = createGovernedEmbedding({
      registry: createTestEmbedders(keyword, DIMENSION).embedders,
      vectors,
      initialEmbedder: TEST_EMBEDDER_ID,
    });
    expect(await embedding.status()).toEqual({
      active: { embedder: TEST_EMBEDDER_ID, dimension: DIMENSION },
    });
    expect(await vectors.getActiveProfile()).toBeUndefined();
    expect(await vectors.listProfiles()).toEqual([]);
  });
});
