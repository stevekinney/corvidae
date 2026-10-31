/**
 * COR-1898 part 1: governed memory keeps each record's vector in the vector store, under the
 * active embedding profile, and admission, recall, and deletion go through that profile.
 */
import type { Embedder } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';

import { createEmbedderRegistry, EmbedderRegistryError } from '../../src/embedder-registry';
import { collectionNamespace } from '../../src/governance/record-governance';
import { HASHING_EMBEDDER_DIMENSION } from '../../src/hashing-embedder';
import {
  createMemoryVectorStore,
  type MemoryEmbeddingProfile,
  MemoryVectorDimensionError,
  type MemoryVectorReference,
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

    it('keeps the stored active profile when a restart registers its embedder with another dimension', async () => {
      const fixture = await fixtureWith();
      await writeNote(fixture, 'alpha note');
      const restarted = fixture.restart(
        createTestEmbedders(
          (texts) => texts.map(() => Array.from({ length: HASHING_EMBEDDER_DIMENSION }, () => 1)),
          HASHING_EMBEDDER_DIMENSION,
        ),
      );
      const write = restarted.write(principalA, 'beta note', {
        collection: 'notes',
        source: 'conversation',
      });
      expect(
        await write.then(
          () => undefined,
          (error: unknown) => error,
        ),
      ).toBeInstanceOf(EmbedderRegistryError);
      expect(await restarted.embedding.status()).toEqual({
        active: { embedder: TEST_EMBEDDER_ID, dimension: DIMENSION },
      });
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
