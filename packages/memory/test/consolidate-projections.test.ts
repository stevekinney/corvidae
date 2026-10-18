import { describe, expect, it } from 'bun:test';

import { consolidateProjections } from '../src/consolidate-projections';
import { rebuildDerivedIndexes } from '../src/derived-indexes';
import {
  EvidenceProjectionCommitError,
  type EvidenceProjectionStorage,
} from '../src/evidence-projection-storage';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import { makeAuthority, makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS, type MakeBackend } from './transition-backends';
import {
  CLOCK_START,
  createHarness,
  expectCommitted,
  expectRefused,
  makeWriteAuthority,
  NAMESPACE,
  TENANT,
  type TransitionHarness,
} from './transition-test-support';

/**
 * Consolidation creates a summary projection and retires or demotes the
 * projections it folded in, while keeping every earlier revision and the
 * lineage back to the source evidence. It submits one `consolidate` proposal
 * through the transition engine; these tests never touch the in-place
 * `createConsolidationTask`.
 */

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

const authority = makeWriteAuthority();
const BOTH = [
  { id: 'f1', revision: 1 },
  { id: 'f2', revision: 1 },
];

async function seeded(makeBackend: MakeBackend): Promise<TransitionHarness> {
  const harness = createHarness(makeBackend);
  await harness.storage.commit({ tenantId: TENANT, evidence: [e1, e2], projections: [f1, f2] });
  return harness;
}

function consolidate(
  harness: TransitionHarness,
  outcome: 'supersede' | 'demote',
  overrides: Partial<Parameters<typeof consolidateProjections>[0]> = {},
) {
  return consolidateProjections({
    engine: harness.engine,
    storage: harness.storage,
    authority,
    operationId: 'consolidate-1',
    namespace: NAMESPACE,
    candidates: BOTH,
    outcome,
    summarize: (texts) => Promise.resolve(`Summary: ${texts.join(' / ')}`),
    summaryId: 's1',
    projectorRevision: 'consolidator:1',
    promptRevision: 'prompt:1',
    ...overrides,
  });
}

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`consolidateProjections (${label})`, () => {
    it('supersedes the candidates with a summary that keeps their lineage', async () => {
      const { storage, ...harness } = await seeded(makeBackend);
      expectCommitted(await consolidate({ storage, ...harness }, 'supersede'));

      const summary = await storage.getProjection(TENANT, NAMESPACE, 's1');
      expect(summary?.kind).toBe('summary');
      expect(summary?.kind === 'summary' && summary.payload).toEqual({
        text: 'Summary: Ana prefers green tea / Ana drinks tea at noon',
        covers: BOTH,
      });
      expect(summary?.sources).toEqual([
        { evidenceId: 'e1', digest: e1.digest },
        { evidenceId: 'e2', digest: e2.digest },
      ]);
      expect(summary?.transition).toEqual({
        kind: 'created',
        at: CLOCK_START,
        supersedes: BOTH,
      });
      expect(summary?.confidence).toBe(0.6);
      expect(summary?.policyRevision).toBe('authorization:1');

      for (const id of ['f1', 'f2']) {
        const current = await storage.getProjection(TENANT, NAMESPACE, id);
        expect(current?.status).toBe('superseded');
        expect(current?.revision).toBe(2);
        expect(current?.transition).toEqual({
          kind: 'superseded',
          at: CLOCK_START,
          supersededBy: { id: 's1', revision: 1 },
        });
        expect(current?.validity.validUntil).toBe(CLOCK_START);
        const history = await storage.listProjectionHistory(TENANT, NAMESPACE, id);
        expect(history.map((record) => record.status)).toEqual(['active', 'superseded']);
        expect(history[0]?.sources).toEqual(current?.sources);
      }
    });

    it('records the candidates, revisions, validation, output, and outcome on its receipt', async () => {
      const harness = await seeded(makeBackend);
      const result = expectCommitted(await consolidate(harness, 'supersede'));
      const { receipt } = result;

      expect(receipt.kind).toBe('consolidate');
      expect(receipt.outcome).toBe('committed');
      expect(receipt.validation.checks).toEqual([
        'candidate-count',
        'authorization',
        'coverage',
        'faithfulness',
        'prior-state',
        'temporal',
        'retention',
        'type-invariants',
      ]);
      const record = receipt.consolidation;
      expect(record?.outcome).toBe('supersede');
      expect(record?.projectorRevision).toBe('consolidator:1');
      expect(record?.promptRevision).toBe('prompt:1');
      expect(record?.candidates.map(({ id, revision }) => ({ id, revision }))).toEqual(BOTH);
      expect(
        record?.candidates.every((candidate) => candidate.recordDigest.startsWith('sha256:')),
      ).toBe(true);
      expect(record?.summary.id).toBe('s1');
      expect(record?.summary.textDigest.startsWith('sha256:')).toBe(true);
      expect(record?.retired).toEqual([
        { id: 'f1', revision: 2, transition: 'superseded' },
        { id: 'f2', revision: 2, transition: 'superseded' },
      ]);
      expect(receipt.projections.map((entry) => `${entry.id}@${entry.revision}`)).toEqual([
        's1@1',
        'f1@2',
        'f2@2',
      ]);
      // The receipt holds references and digests, never the summary's text.
      expect(JSON.stringify(receipt)).not.toContain('Ana');
      expect(await harness.engine.getReceipt(TENANT, 'consolidate-1')).toEqual(receipt);
    });

    it('removes the superseded candidates from retrieval and keeps the summary reachable', async () => {
      const harness = await seeded(makeBackend);
      expectCommitted(await consolidate(harness, 'supersede'));
      const indexes = await rebuildDerivedIndexes({
        storage: harness.storage,
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
      const harness = await seeded(makeBackend);
      const { receipt } = expectCommitted(await consolidate(harness, 'demote'));
      const { storage } = harness;

      const summary = await storage.getProjection(TENANT, NAMESPACE, 's1');
      expect(summary?.transition).toEqual({ kind: 'created', at: CLOCK_START });
      expect(summary?.kind === 'summary' && summary.payload.covers).toHaveLength(2);
      // The receipt makes the same claim: no projection supersedes anything.
      expect(receipt.projections.every((entry) => entry.supersedes === undefined)).toBe(true);
      expect(receipt.projections.filter((entry) => entry.demotedBy !== undefined)).toHaveLength(2);
      expect(receipt.consolidation?.retired.map((entry) => entry.transition)).toEqual([
        'demoted',
        'demoted',
      ]);
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
    });

    it('rejects fewer than two candidates and writes nothing', async () => {
      const harness = await seeded(makeBackend);
      for (const candidates of [[], [{ id: 'f1', revision: 1 }]]) {
        const result = expectRefused(
          await consolidate(harness, 'supersede', { candidates }),
          'rejected',
        );
        expect(result.reason).toBe('consolidation-requires-two-candidates');
      }
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 's1')).toBeUndefined();
      expect((await harness.storage.getProjection(TENANT, NAMESPACE, 'f1'))?.revision).toBe(1);
    });

    it('conflicts on a candidate that is no longer current, and writes nothing', async () => {
      const harness = await seeded(makeBackend);
      expectCommitted(await consolidate(harness, 'supersede'));
      const again = expectRefused(
        await consolidate(harness, 'supersede', { operationId: 'consolidate-2', summaryId: 's2' }),
        'conflicted',
      );
      expect(again.reason).toBe('stale-revision');
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 's2')).toBeUndefined();
      expect(await harness.engine.getReceipt(TENANT, 'consolidate-2')).toBeUndefined();
    });

    it('throws for a candidate revision that never existed, before summarizing', async () => {
      const harness = await seeded(makeBackend);
      let summarized = false;
      const error = await rejectionOf(
        consolidate(harness, 'supersede', {
          candidates: [{ id: 'f1', revision: 2 }, ...BOTH.slice(1)],
          summarize: () => {
            summarized = true;
            return Promise.resolve('unused');
          },
        }),
      );
      expect(error).toBeInstanceOf(EvidenceProjectionCommitError);
      expect((error as EvidenceProjectionCommitError).code).toBe('projection-not-found');
      expect(summarized).toBe(false);
    });

    it('returns canceled with no events and no engine call when aborted before submission', async () => {
      const harness = await seeded(makeBackend);
      const controller = new AbortController();
      const result = await consolidate(harness, 'supersede', {
        signal: controller.signal,
        summarize: (texts) => {
          controller.abort();
          return Promise.resolve(texts.join());
        },
      });
      expect(result).toEqual({ outcome: 'canceled' });
      expect(harness.recorder.events).toEqual([]);
      expect(harness.clock.reads).toBe(0);
      expect(await harness.engine.getReceipt(TENANT, 'consolidate-1')).toBeUndefined();
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 's1')).toBeUndefined();
    });

    it('embeds the summary when an embedder is supplied', async () => {
      const harness = await seeded(makeBackend);
      expectCommitted(
        await consolidate(harness, 'demote', {
          summaryId: 's2',
          embed: () => Promise.resolve({ model: 'm', vector: [1, 0] }),
        }),
      );
      const summary = await harness.storage.getProjection(TENANT, NAMESPACE, 's2');
      expect(summary?.embedding).toEqual({ model: 'm', vector: [1, 0] });
    });
  });

  describe(`consolidateProjections embeddings (${label})`, () => {
    const e3 = makeInlineEvidence('e3');
    const embedded = (id: string, evidence: typeof e1, vector: number[]) =>
      makeFact(id, [evidence], {
        payload: { statement: `Statement ${id}`, entities: [] },
        embedding: { model: 'm', vector },
      });
    const g1 = embedded('g1', e1, [1, 0, 0]);
    const g2 = embedded('g2', e2, [0, 1, 0]);
    const g3 = embedded('g3', e3, [0, 0, 1]);
    const CANDIDATES = [
      { id: 'g1', revision: 1 },
      { id: 'g2', revision: 1 },
    ];

    async function withEmbeddings(): Promise<TransitionHarness> {
      const harness = createHarness(makeBackend);
      await harness.storage.commit({
        tenantId: TENANT,
        evidence: [e1, e2, e3],
        projections: [g1, g2, g3],
      });
      return harness;
    }

    function consolidateWith(
      harness: TransitionHarness,
      outcome: 'supersede' | 'demote',
      embedding: { model: string; vector: number[] },
    ) {
      return consolidate(harness, outcome, {
        candidates: CANDIDATES,
        summarize: () => Promise.resolve('A summary'),
        summaryId: 's3',
        embed: () => Promise.resolve(embedding),
      });
    }

    async function stillBuilds(harness: TransitionHarness): Promise<void> {
      const indexes = await rebuildDerivedIndexes({
        storage: harness.storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        authority: makeAuthority(),
      });
      expect(indexes.vector.entryCount).toBeGreaterThan(0);
    }

    async function expectUntouched(storage: EvidenceProjectionStorage): Promise<void> {
      expect(await storage.getProjection(TENANT, NAMESPACE, 's3')).toBeUndefined();
      expect((await storage.getProjection(TENANT, NAMESPACE, 'g1'))?.status).toBe('active');
    }

    it('[c2 item 8] refuses a demotion summary whose embedding has another dimension', async () => {
      const harness = await withEmbeddings();
      const result = expectRefused(
        await consolidateWith(harness, 'demote', { model: 'm', vector: [1, 0] }),
        'rejected',
      );
      expect(result.reason).toBe('type-invariant-violated');
      expect(result.detail).toStartWith('embedding.fits-namespace');
      expect(result.detail).toContain('dimensions');
      await expectUntouched(harness.storage);
      await stillBuilds(harness);
    });

    it('[c2 item 8] refuses a demotion summary whose embedding comes from another model', async () => {
      const harness = await withEmbeddings();
      const result = expectRefused(
        await consolidateWith(harness, 'demote', { model: 'other', vector: [1, 0, 0] }),
        'rejected',
      );
      expect(result.reason).toBe('type-invariant-violated');
      expect(result.detail).toContain('model');
      await expectUntouched(harness.storage);
      await stillBuilds(harness);
    });

    it('[c2 item 8] refuses a superseding summary that mismatches the projections that remain', async () => {
      const harness = await withEmbeddings();
      const result = expectRefused(
        await consolidateWith(harness, 'supersede', { model: 'm', vector: [1, 0] }),
        'rejected',
      );
      expect(result.reason).toBe('type-invariant-violated');
      await expectUntouched(harness.storage);
      await stillBuilds(harness);
    });

    it('[c2 item 8] accepts an embedding of the same model and dimension', async () => {
      const harness = await withEmbeddings();
      expectCommitted(await consolidateWith(harness, 'demote', { model: 'm', vector: [0, 0, 1] }));
      const summary = await harness.storage.getProjection(TENANT, NAMESPACE, 's3');
      expect(summary?.embedding?.vector).toEqual([0, 0, 1]);
      await stillBuilds(harness);
    });
  });

  describe(`superseding every embedded projection (${label})`, () => {
    it('accepts a summary whose embedding differs only from the candidates it retires', async () => {
      const harness = createHarness(makeBackend);
      const old1 = makeFact('g1', [e1], { embedding: { model: 'old-model', vector: [1, 0, 0] } });
      const old2 = makeFact('g2', [e2], { embedding: { model: 'old-model', vector: [0, 1, 0] } });
      await harness.storage.commit({
        tenantId: TENANT,
        evidence: [e1, e2],
        projections: [old1, old2],
      });
      expectCommitted(
        await consolidate(harness, 'supersede', {
          candidates: [
            { id: 'g1', revision: 1 },
            { id: 'g2', revision: 1 },
          ],
          summarize: () => Promise.resolve('Migrated'),
          projectorRevision: 'consolidator:2',
          embed: () => Promise.resolve({ model: 'new-model', vector: [1, 0] }),
        }),
      );
      const summary = await harness.storage.getProjection(TENANT, NAMESPACE, 's1');
      expect(summary?.embedding?.model).toBe('new-model');
      const indexes = await rebuildDerivedIndexes({
        storage: harness.storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        authority: makeAuthority(),
      });
      expect(indexes.vector.model).toBe('new-model');
    });
  });
}
