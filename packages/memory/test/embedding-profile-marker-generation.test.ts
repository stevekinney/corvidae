import { describe, expect, it } from 'bun:test';

import { consolidateProjections } from '../src/consolidate-projections';
import { rebuildDerivedIndexes } from '../src/derived-indexes';
import type { ApplyPlannedBatch, WrapApply } from '../src/evidence-projection-store-core';
import { createTransitionEngine } from '../src/transition-engine';
import { makeAuthority, makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  createBarrier,
  createManualClock,
  createRecordingSink,
  expectCommitted,
  expectRefused,
  makeWriteAuthority,
  NAMESPACE,
  proposedFact,
  TENANT,
} from './transition-test-support';

/**
 * The marker carries a generation that every embedded write bumps, so two
 * commits that write embedded records into one namespace cannot both apply
 * against the same marker. Conditioning on a key serializes only against commits
 * that write it; a same-profile creation that merely conditioned on the marker
 * could land between a migration's scan and its apply.
 */

const authority = makeWriteAuthority();
const e1 = makeInlineEvidence('e1');
const e2 = makeInlineEvidence('e2');
const e3 = makeInlineEvidence('e3');
const embedded = (id: string, evidence: typeof e1, vector: number[], model = 'a') =>
  makeFact(id, [evidence], { embedding: { model, vector } });

const engineOver = (storage: Parameters<typeof createTransitionEngine>[0]['storage']) =>
  createTransitionEngine({
    storage,
    sink: createRecordingSink().sink,
    now: createManualClock().now,
  });

const createEmbedded = (operationId: string, id: string, evidenceId: string, digest: string) => ({
  kind: 'create-projection' as const,
  operationId,
  tenantId: TENANT,
  authority,
  projections: [
    proposedFact(id, [{ id: evidenceId, digest }], {
      embedding: { model: 'a', vector: [1, 0, 0] },
    }),
  ],
});

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`the marker generation (${label})`, () => {
    it('does not let a same-profile creation land between a migration and its apply', async () => {
      const parked = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let parkNext = false;
      const wrap: WrapApply = (apply: ApplyPlannedBatch) => async (batch) => {
        if (parkNext) {
          parkNext = false;
          parked.resolve();
          await resume.promise;
        }
        return apply(batch);
      };
      const storage = makeBackend(wrap);
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1, e2, e3],
        projections: [embedded('g1', e1, [1, 0, 0]), embedded('g2', e2, [0, 1, 0])],
      });

      // The migration: a consolidation that supersedes every embedded record with a summary of
      // another profile. It validates and scans the namespace, then parks at its apply.
      parkNext = true;
      const migration = consolidateProjections({
        engine: engineOver(storage),
        authority,
        operationId: 'migrate',
        namespace: NAMESPACE,
        candidates: [
          { id: 'g1', revision: 1 },
          { id: 'g2', revision: 1 },
        ],
        outcome: 'supersede',
        summarize: () => Promise.resolve('Summary'),
        summaryId: 's1',
        projectorRevision: 'consolidator:2',
        promptRevision: 'prompt:1',
        embed: () => Promise.resolve({ model: 'b', vector: [1, 0] }),
      });
      await parked.promise;
      // A creation with the old profile lands while the migration is parked.
      expectCommitted(
        await engineOver(storage).submit(createEmbedded('late', 'g3', 'e3', e3.digest)),
      );
      resume.resolve();

      // The migration re-plans against what is there, and finds a recallable old-profile record.
      expectRefused(await migration, 'conflicted');
      const marker = await storage.getEmbeddingProfile(TENANT, NAMESPACE);
      expect(marker).toMatchObject({ model: 'a', dimensions: 3 });
      expect(await storage.getProjection(TENANT, NAMESPACE, 's1')).toBeUndefined();
      const indexes = await rebuildDerivedIndexes({
        storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        authority: makeAuthority(),
      });
      expect(indexes.vector.entryCount).toBe(3);
    });

    it('serializes two same-profile creations: the second to apply loses its batch and re-plans', async () => {
      const barrier = createBarrier(2);
      const outcomes: boolean[] = [];
      let seeded = false;
      const wrap: WrapApply = (apply: ApplyPlannedBatch) => async (batch) => {
        if (!seeded) return apply(batch);
        if (outcomes.length === 0) await barrier.arrive();
        const applied = await apply(batch);
        outcomes.push(applied);
        return applied;
      };
      const storage = makeBackend(wrap);
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1, e2, e3],
        projections: [embedded('g1', e1, [1, 0, 0])],
      });
      seeded = true;
      const before = await storage.getEmbeddingProfile(TENANT, NAMESPACE);
      const generationBefore = before?.generation;

      const pending = [
        engineOver(storage).submit(createEmbedded('op-a', 'pa', 'e2', e2.digest)),
        engineOver(storage).submit(createEmbedded('op-b', 'pb', 'e3', e3.digest)),
      ];
      await barrier.whenFull;
      barrier.release();
      const results = await Promise.all(pending);

      // Both were planned against the same marker, so one lost its first batch and re-planned.
      expect(outcomes.filter((applied) => !applied)).toHaveLength(1);
      expect(results.map((result) => result.outcome)).toEqual(['committed', 'committed']);
      const after = await storage.getEmbeddingProfile(TENANT, NAMESPACE);
      expect(generationBefore).toBe(1);
      expect(after?.generation).toBe(3);
    });

    it('leaves the generation alone on a commit that only retires records', async () => {
      const storage = makeBackend();
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        projections: [embedded('g1', e1, [1, 0, 0])],
      });
      const g1 = await storage.getProjection(TENANT, NAMESPACE, 'g1');
      await storage.commit({
        tenantId: TENANT,
        projections: [
          {
            ...g1!,
            revision: 2,
            status: 'revoked',
            transition: { kind: 'revoked', at: 5, reasonCode: 'x' },
          },
        ],
      });
      const marker = await storage.getEmbeddingProfile(TENANT, NAMESPACE);
      expect(marker?.generation).toBe(1);
    });

    it('bumps the generation on a rebuild that keeps an embedding', async () => {
      const storage = makeBackend();
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        projections: [embedded('g1', e1, [1, 0, 0])],
      });
      const g1 = await storage.getProjection(TENANT, NAMESPACE, 'g1');
      await storage.commit({
        tenantId: TENANT,
        projections: [
          {
            ...g1!,
            revision: 2,
            transition: { kind: 'rebuilt', at: 5, rebuiltFromRevision: 1 },
          },
        ],
      });
      const marker = await storage.getEmbeddingProfile(TENANT, NAMESPACE);
      expect(marker?.generation).toBe(2);
    });
  });
}
