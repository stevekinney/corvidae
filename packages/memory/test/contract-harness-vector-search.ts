import { beforeEach, describe, expect, it } from 'bun:test';
import type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage } from '../src/types';

export function registerVectorSearchContractTests(options: {
  storage: () => MemoryRecordStorage;
  scope: MemoryRecordScope;
  makeRecord: (id: string, overrides?: Partial<MemoryRecord>) => MemoryRecord;
}): void {
  const { storage: getStorage, scope: SCOPE, makeRecord } = options;
  describe('searchByVector', () => {
    it('ranks by cosine similarity, descending', async () => {
      await getStorage().put(makeRecord('exact', { vector: new Float32Array([1, 0]) }));
      await getStorage().put(makeRecord('ortho', { vector: new Float32Array([0, 1]) }));

      const hits = await getStorage().searchByVector([1, 0], SCOPE, { limit: 10 });
      expect(hits[0]!.id).toBe('exact');
      expect(hits[0]!.score).toBeCloseTo(1, 5);
      expect(hits[1]!.id).toBe('ortho');
    });

    it('applies the threshold filter', async () => {
      await getStorage().put(makeRecord('exact', { vector: new Float32Array([1, 0]) }));
      await getStorage().put(makeRecord('ortho', { vector: new Float32Array([0, 1]) }));

      const hits = await getStorage().searchByVector([1, 0], SCOPE, { limit: 10, threshold: 0.5 });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.id).toBe('exact');
    });

    it('retains negative-similarity records when no threshold is given', async () => {
      await getStorage().put(makeRecord('pos', { vector: new Float32Array([1, 0]) }));
      await getStorage().put(makeRecord('neg', { vector: new Float32Array([-1, 0]) }));

      const hits = await getStorage().searchByVector([1, 0], SCOPE, { limit: 10 });
      expect(hits).toHaveLength(2);
    });

    describe('deterministic exact-search fixture', () => {
      // Vectors chosen so cosine similarity against the query [1, 0] is exact:
      //   [1, 0] -> 1, [0, 1] -> 0, [-1, 0] -> -1, [0, 0] -> 0 (zero vector).
      // [0, 1] and [0, 0] tie at 0, so assertions key on id, never on the
      // positional order of the two zero-score hits.
      beforeEach(async () => {
        await getStorage().put(makeRecord('parallel', { vector: new Float32Array([1, 0]) }));
        await getStorage().put(makeRecord('orthogonal', { vector: new Float32Array([0, 1]) }));
        await getStorage().put(makeRecord('opposite', { vector: new Float32Array([-1, 0]) }));
        await getStorage().put(makeRecord('zero', { vector: new Float32Array([0, 0]) }));
      });

      it('scores each record by exact cosine similarity', async () => {
        const hits = await getStorage().searchByVector([1, 0], SCOPE, { limit: 10 });
        const scoreById = new Map(hits.map((hit) => [hit.id, hit.score]));

        expect(scoreById.get('parallel')).toBeCloseTo(1, 5);
        expect(scoreById.get('orthogonal')).toBeCloseTo(0, 5);
        expect(scoreById.get('opposite')).toBeCloseTo(-1, 5);
        expect(scoreById.get('zero')).toBeCloseTo(0, 5);
      });

      it('orders the parallel hit first and the opposite hit last', async () => {
        const hits = await getStorage().searchByVector([1, 0], SCOPE, { limit: 10 });
        expect(hits).toHaveLength(4);
        expect(hits[0]!.id).toBe('parallel');
        expect(hits[3]!.id).toBe('opposite');
        // Scores are sorted descending regardless of how the two zero-score
        // ties are ordered between them.
        const scores = hits.map((hit) => hit.score);
        const descending = [...scores].toSorted((a, b) => b - a);
        expect(scores).toEqual(descending);
      });

      it('drops sub-threshold and negative hits under a positive threshold', async () => {
        const hits = await getStorage().searchByVector([1, 0], SCOPE, {
          limit: 10,
          threshold: 0.5,
        });
        expect(hits.map((hit) => hit.id)).toEqual(['parallel']);
      });
    });
  });
}
