import { MemoryStorage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { consolidateProjections } from '../src/consolidate-projections';
import { createInMemoryEvidenceProjectionStorage } from '../src/create-in-memory-evidence-projection-storage';
import { createWeftEvidenceProjectionStorage } from '../src/create-weft-evidence-projection-storage';
import { rebuildDerivedIndexes } from '../src/derived-indexes';
import {
  type EvidenceProjectionStorage,
  ProjectionRevisionConflictError,
} from '../src/evidence-projection-storage';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import {
  FIXED_AT,
  makeAuthority,
  makeFact,
  makeInlineEvidence,
  NAMESPACE,
  TENANT,
} from './evidence-projection-fixtures';

/**
 * Consolidation creates a summary projection and retires or demotes the
 * projections it folded in, while keeping every earlier revision and the
 * lineage back to the source evidence. These tests never touch the in-place
 * `createConsolidationTask`.
 */

const NOW = FIXED_AT + 1_000;
const e1 = makeInlineEvidence('e1');
const e2 = makeInlineEvidence('e2');
const f1 = makeFact('f1', [e1], {
  confidence: 0.9,
  payload: { statement: 'Ana prefers green tea', entities: ['Ana'] },
});
const f2 = makeFact('f2', [e2], {
  confidence: 0.6,
  payload: { statement: 'Ana drinks tea at noon', entities: ['Ana'] },
});

const BACKENDS: ReadonlyArray<readonly [string, () => EvidenceProjectionStorage]> = [
  ['in-memory', () => createInMemoryEvidenceProjectionStorage()],
  ['weft', () => createWeftEvidenceProjectionStorage(new MemoryStorage())],
];

async function seeded(
  makeBackend: () => EvidenceProjectionStorage,
): Promise<EvidenceProjectionStorage> {
  const storage = makeBackend();
  await storage.commit({ tenantId: TENANT, evidence: [e1, e2], projections: [f1, f2] });
  return storage;
}

function consolidate(storage: EvidenceProjectionStorage, outcome: 'supersede' | 'demote') {
  return consolidateProjections({
    storage,
    tenantId: TENANT,
    namespace: NAMESPACE,
    candidates: [
      { id: 'f1', revision: 1 },
      { id: 'f2', revision: 1 },
    ],
    outcome,
    summarize: (texts) => Promise.resolve(`Summary: ${texts.join(' / ')}`),
    summaryId: 's1',
    projectorRevision: 'consolidator:1',
    policyRevision: 'policy:1',
    now: () => NOW,
  });
}

for (const [label, makeBackend] of BACKENDS) {
  describe(`consolidateProjections (${label})`, () => {
    it('supersedes the candidates with a summary that keeps their lineage', async () => {
      const storage = await seeded(makeBackend);
      const { summary } = await consolidate(storage, 'supersede');

      expect(summary.kind).toBe('summary');
      expect(summary.payload).toEqual({
        text: 'Summary: Ana prefers green tea / Ana drinks tea at noon',
        covers: [
          { id: 'f1', revision: 1 },
          { id: 'f2', revision: 1 },
        ],
      });
      expect(summary.sources).toEqual([
        { evidenceId: 'e1', digest: e1.digest },
        { evidenceId: 'e2', digest: e2.digest },
      ]);
      expect(summary.transition).toEqual({
        kind: 'created',
        at: NOW,
        supersedes: [
          { id: 'f1', revision: 1 },
          { id: 'f2', revision: 1 },
        ],
      });
      expect(summary.confidence).toBe(0.6);
      expect(await storage.getProjection(TENANT, NAMESPACE, 's1')).toEqual(summary);

      for (const id of ['f1', 'f2']) {
        const current = await storage.getProjection(TENANT, NAMESPACE, id);
        expect(current?.status).toBe('superseded');
        expect(current?.revision).toBe(2);
        expect(current?.transition).toEqual({
          kind: 'superseded',
          at: NOW,
          supersededBy: { id: 's1', revision: 1 },
        });
        expect(current?.validity.validUntil).toBe(NOW);
        const history = await storage.listProjectionHistory(TENANT, NAMESPACE, id);
        expect(history.map((record) => record.status)).toEqual(['active', 'superseded']);
        expect(history[0]?.sources).toEqual(current?.sources);
      }
    });

    it('removes the superseded candidates from retrieval and keeps the summary reachable', async () => {
      const storage = await seeded(makeBackend);
      await consolidate(storage, 'supersede');
      const indexes = await rebuildDerivedIndexes({
        storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        authority: makeAuthority(),
      });
      expect(indexes.lexical.query('tea', { limit: 10 }).map((hit) => hit.id)).toEqual(['s1']);
      expect(indexes.graph.query({ from: 'projection:s1' })).toEqual([
        { from: 'projection:s1', to: 'projection:f1', kind: 'covers' },
        { from: 'projection:s1', to: 'projection:f2', kind: 'covers' },
        { from: 'projection:s1', to: 'evidence:e1', kind: 'lineage' },
        { from: 'projection:s1', to: 'evidence:e2', kind: 'lineage' },
        { from: 'projection:s1', to: 'projection:f1', kind: 'projection-supersession' },
        { from: 'projection:s1', to: 'projection:f2', kind: 'projection-supersession' },
      ]);
    });

    it('[item 5] demotes without claiming to have replaced the candidates', async () => {
      const storage = await seeded(makeBackend);
      const { summary } = await consolidate(storage, 'demote');

      expect(summary.transition).toEqual({ kind: 'created', at: NOW });
      expect(summary.kind === 'summary' && summary.payload.covers).toHaveLength(2);
      const demoted = await storage.getProjection(TENANT, NAMESPACE, 'f1');
      expect(demoted?.status).toBe('demoted');
      expect(demoted?.validity.validUntil).toBeUndefined();

      const indexes = await rebuildDerivedIndexes({
        storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        authority: makeAuthority(),
      });
      expect(
        indexes.lexical
          .query('tea', { limit: 10 })
          .map((hit) => hit.id)
          .toSorted(),
      ).toEqual(['f1', 'f2', 's1']);
      expect(indexes.graph.query({ from: 'projection:f1' })).toContainEqual({
        from: 'projection:f1',
        to: 'projection:s1',
        kind: 'projection-demotion',
      });
      // [item 5] A demotion is not a supersession: no edge of that kind is emitted for it.
      const everyEdge = ['projection:f1', 'projection:f2', 'projection:s1'].flatMap((from) =>
        indexes.graph.query({ from }),
      );
      expect(everyEdge.map((edge) => edge.kind)).not.toContain('projection-supersession');
      expect(
        indexes.graph
          .query({ from: 'projection:s1' })
          .filter((edge) => edge.kind === 'projection-supersession'),
      ).toEqual([]);
    });

    it('refuses a stale candidate revision and writes nothing', async () => {
      const storage = await seeded(makeBackend);
      const error = await rejectionOf(
        consolidateProjections({
          storage,
          tenantId: TENANT,
          namespace: NAMESPACE,
          candidates: [{ id: 'f1', revision: 2 }],
          outcome: 'supersede',
          summarize: () => Promise.resolve('unused'),
          summaryId: 's1',
          projectorRevision: 'consolidator:1',
          policyRevision: 'policy:1',
          now: () => NOW,
        }),
      );
      expect(error).toBeInstanceOf(ProjectionRevisionConflictError);
      expect(await storage.getProjection(TENANT, NAMESPACE, 's1')).toBeUndefined();
      const untouched = await storage.getProjection(TENANT, NAMESPACE, 'f1');
      expect(untouched?.revision).toBe(1);
    });

    it('refuses to consolidate a projection that is already superseded', async () => {
      const storage = await seeded(makeBackend);
      await consolidate(storage, 'supersede');
      const error = await rejectionOf(consolidate(storage, 'supersede'));
      expect(error).toBeInstanceOf(ProjectionRevisionConflictError);
    });

    it('embeds the summary when an embedder is supplied', async () => {
      const storage = await seeded(makeBackend);
      const { summary } = await consolidateProjections({
        storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        candidates: [{ id: 'f1', revision: 1 }],
        outcome: 'demote',
        summarize: (texts) => Promise.resolve(texts.join('')),
        summaryId: 's2',
        projectorRevision: 'consolidator:1',
        policyRevision: 'policy:1',
        now: () => NOW,
        embed: () => Promise.resolve({ model: 'm', vector: [1, 0] }),
      });
      expect(summary.embedding).toEqual({ model: 'm', vector: [1, 0] });
    });
  });
}
