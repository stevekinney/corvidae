import { describe, expect, it } from 'bun:test';

import { consolidateProjections } from '../src/consolidate-projections';
import { rebuildDerivedIndexes } from '../src/derived-indexes';
import { createEvidenceProjectionKeys } from '../src/evidence-projection-keys';
import {
  decodeEmbeddingProfile,
  EMBEDDING_PROFILE_SCHEMA_VERSION,
  embeddingProfileOf,
  encodeEmbeddingProfile,
} from '../src/evidence-projection-schema';
import { EvidenceProjectionCommitError } from '../src/evidence-projection-storage';
import { createEvidenceProjectionStoreCore } from '../src/evidence-projection-store-core';
import { MemoryEvidenceValidationError } from '../src/evidence-schema';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import { createTransitionEngine } from '../src/transition-engine';
import { makeAuthority, makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import { recordBatches, TRANSITION_BACKENDS } from './transition-backends';
import {
  createBarrier,
  createHarness,
  createManualClock,
  createOrderedGates,
  createRecordingSink,
  expectCommitted,
  expectRefused,
  makeWriteAuthority,
  NAMESPACE,
  proposedFact,
  TENANT,
  type TransitionHarness,
} from './transition-test-support';

/**
 * The per-namespace embedding profile marker. A vector index takes one model and
 * one dimension, so the store writes the namespace's profile in the same batch as
 * any embedded record and conditions on it; two commits that would give a
 * namespace incompatible embeddings cannot both apply, whoever submits them.
 */

const keys = createEvidenceProjectionKeys();
const MARKER = keys.embeddingProfile(TENANT, NAMESPACE);
const e1 = makeInlineEvidence('e1');
const e2 = makeInlineEvidence('e2');
const source = (evidence: typeof e1) => ({ id: evidence.id, digest: evidence.digest });
const embedded = (id: string, evidence: typeof e1, vector: number[], model = 'm') =>
  makeFact(id, [evidence], { embedding: { model, vector } });
const authority = makeWriteAuthority();

function createEmbedded(operationId: string, id: string, vector: number[], model = 'm') {
  return {
    kind: 'create-projection' as const,
    operationId,
    tenantId: TENANT,
    authority,
    projections: [proposedFact(id, [source(e1)], { embedding: { model, vector } })],
  };
}

async function indexesBuild(harness: TransitionHarness): Promise<void> {
  const indexes = await rebuildDerivedIndexes({
    storage: harness.storage,
    tenantId: TENANT,
    namespace: NAMESPACE,
    authority: makeAuthority(),
  });
  expect(indexes.vector.entryCount).toBeGreaterThan(0);
}

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`two creations racing into an empty namespace (${label})`, () => {
    for (const first of [0, 1] as const) {
      it(`lets exactly one of two incompatible profiles commit, writer ${first} first, and the indexes still build`, async () => {
        const recorder = recordBatches();
        const storage = makeBackend(recorder.wrapApply);
        await storage.commit({ tenantId: TENANT, evidence: [e1] });
        const gates = createOrderedGates(2);
        const sinks = [createRecordingSink(), createRecordingSink()] as const;
        const clock = createManualClock();
        const engines = [0, 1].map((index) =>
          createTransitionEngine({
            storage,
            sink: sinks[index]!.sink,
            now: clock.now,
            hooks: { beforeBatch: gates.hold(index) },
          }),
        ) as [ReturnType<typeof createTransitionEngine>, ReturnType<typeof createTransitionEngine>];

        // Both validate against a namespace with no embeddings, so both pass the validator.
        const pending = [
          engines[0].submit(createEmbedded('operation-a', 'pa', [1, 0, 0])),
          engines[1].submit(createEmbedded('operation-b', 'pb', [1, 0])),
        ] as const;
        await gates.whenAllArrived;
        const loser = first === 0 ? 1 : 0;
        gates.release(first);
        const winnerResult = await pending[first];
        gates.release(loser);
        const loserResult = await pending[loser];

        expect(winnerResult.outcome).toBe('committed');
        const refused = expectRefused(loserResult, 'conflicted');
        expect(refused.reason).toBe('embedding-profile-conflict');
        expect(sinks[loser].kinds()).toEqual(['requested', 'validation-started', 'conflicted']);
        const winnerVector = first === 0 ? 3 : 2;
        expect(await storage.getEmbeddingProfile(TENANT, NAMESPACE)).toEqual(
          embeddingProfileOf({ model: 'm', vector: Array.from({ length: winnerVector }, () => 0) }),
        );
        expect(
          await storage.getProjection(TENANT, NAMESPACE, first === 0 ? 'pb' : 'pa'),
        ).toBeUndefined();
        const harness = { storage } as TransitionHarness;
        await indexesBuild(harness);
      });
    }

    it('lets both commit when they share a profile, one after the other, each bumping the marker', async () => {
      const recorder = recordBatches();
      const storage = makeBackend(recorder.wrapApply);
      await storage.commit({ tenantId: TENANT, evidence: [e1] });
      recorder.batches.length = 0;
      recorder.results.length = 0;
      const barrier = createBarrier(2);
      const sink = createRecordingSink();
      const clock = createManualClock();
      const engines = [0, 1].map(() =>
        createTransitionEngine({
          storage,
          sink: sink.sink,
          now: clock.now,
          hooks: { beforeBatch: () => barrier.arrive() },
        }),
      ) as [ReturnType<typeof createTransitionEngine>, ReturnType<typeof createTransitionEngine>];
      const pendingA = engines[0].submit(createEmbedded('operation-a', 'pa', [1, 0, 0]));
      const pendingB = engines[1].submit(createEmbedded('operation-b', 'pb', [0, 1, 0]));
      await barrier.whenFull;
      barrier.release();
      expectCommitted(await pendingA);
      expectCommitted(await pendingB);

      // Two embedded writers, two generations: the second to apply re-planned against the first's.
      expect(await storage.getEmbeddingProfile(TENANT, NAMESPACE)).toEqual(
        embeddingProfileOf({ model: 'm', vector: [0, 0, 0] }, 2),
      );
      for (const batch of recorder.batches) {
        expect(batch.conditions.filter((condition) => condition.key === MARKER)).toHaveLength(1);
      }
      // Each batch that applied put the marker, because every embedded write bumps its generation.
      const applied = recorder.batches.filter((_, index) => recorder.results[index]);
      expect(
        applied.filter((batch) => batch.operations.some((op) => op.key === MARKER)),
      ).toHaveLength(2);
    });
  });

  describe(`a direct commit that bypasses the engine (${label})`, () => {
    it('is refused when its embedding profile differs from the namespace marker, and writes nothing', async () => {
      const storage = makeBackend();
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1, e2],
        projections: [embedded('g1', e1, [1, 0, 0])],
      });
      const marker = await storage.getEmbeddingProfile(TENANT, NAMESPACE);
      const error = await rejectionOf(
        storage.commit({ tenantId: TENANT, projections: [embedded('g2', e2, [1, 0])] }),
      );
      expect(error).toBeInstanceOf(EvidenceProjectionCommitError);
      expect((error as EvidenceProjectionCommitError).code).toBe('embedding-profile-conflict');
      expect(await storage.getProjection(TENANT, NAMESPACE, 'g2')).toBeUndefined();
      expect(await storage.getEmbeddingProfile(TENANT, NAMESPACE)).toEqual(marker);
      const history = await storage.listProjectionHistory(TENANT, NAMESPACE, 'g2');
      expect(history).toHaveLength(0);
    });

    it('is refused for another model with the same dimension', async () => {
      const storage = makeBackend();
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1, e2],
        projections: [embedded('g1', e1, [1, 0, 0])],
      });
      const error = await rejectionOf(
        storage.commit({ tenantId: TENANT, projections: [embedded('g2', e2, [1, 0, 0], 'other')] }),
      );
      expect((error as EvidenceProjectionCommitError).code).toBe('embedding-profile-conflict');
    });

    it('refuses one commit that writes two profiles into a namespace', async () => {
      const storage = makeBackend();
      const error = await rejectionOf(
        storage.commit({
          tenantId: TENANT,
          evidence: [e1, e2],
          projections: [embedded('g1', e1, [1, 0, 0]), embedded('g2', e2, [1, 0])],
        }),
      );
      expect((error as EvidenceProjectionCommitError).code).toBe('invalid-commit');
    });

    it('keeps a different namespace independent', async () => {
      const storage = makeBackend();
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1, e2],
        projections: [embedded('g1', e1, [1, 0, 0])],
      });
      await storage.commit({
        tenantId: TENANT,
        projections: [
          makeFact('g2', [e2], { namespace: 'other', embedding: { model: 'x', vector: [1] } }),
        ],
      });
      expect(await storage.getEmbeddingProfile(TENANT, 'other')).toMatchObject({
        model: 'x',
        dimensions: 1,
      });
    });
  });

  describe(`changing a namespace's profile (${label})`, () => {
    async function seededWithTwoEmbedded() {
      const harness = createHarness(makeBackend);
      await harness.storage.commit({
        tenantId: TENANT,
        evidence: [e1, e2],
        projections: [embedded('g1', e1, [1, 0, 0]), embedded('g2', e2, [0, 1, 0])],
      });
      return harness;
    }
    const consolidate = (
      harness: TransitionHarness,
      outcome: 'supersede' | 'demote',
      vector: number[],
    ) =>
      consolidateProjections({
        engine: harness.engine,
        storage: harness.storage,
        authority,
        operationId: `consolidate-${outcome}`,
        namespace: NAMESPACE,
        candidates: [
          { id: 'g1', revision: 1 },
          { id: 'g2', revision: 1 },
        ],
        outcome,
        summarize: () => Promise.resolve('Summary'),
        summaryId: 's1',
        projectorRevision: 'consolidator:2',
        promptRevision: 'prompt:1',
        embed: () => Promise.resolve({ model: 'new-model', vector }),
      });

    it('replaces the marker by compare-and-swap when the commit retires every embedded record', async () => {
      const harness = await seededWithTwoEmbedded();
      expectCommitted(await consolidate(harness, 'supersede', [1, 0]));
      expect(await harness.storage.getEmbeddingProfile(TENANT, NAMESPACE)).toMatchObject({
        model: 'new-model',
        dimensions: 2,
      });
      await indexesBuild(harness);
    });

    it('refuses, and leaves the marker, when a candidate is only demoted', async () => {
      const harness = await seededWithTwoEmbedded();
      const before = await harness.storage.getEmbeddingProfile(TENANT, NAMESPACE);
      expect(expectRefused(await consolidate(harness, 'demote', [1, 0]), 'rejected').reason).toBe(
        'type-invariant-violated',
      );
      expect(await harness.storage.getEmbeddingProfile(TENANT, NAMESPACE)).toEqual(before);
    });

    it('keeps the marker when the namespace is left with no recallable embedded record, and a later create replaces it', async () => {
      const harness = await seededWithTwoEmbedded();
      for (const id of ['g1', 'g2']) {
        expectCommitted(
          await harness.engine.submit({
            kind: 'revise-projection',
            operationId: `revoke-${id}`,
            tenantId: TENANT,
            authority,
            revisions: [
              {
                namespace: NAMESPACE,
                id,
                expectedRevision: 1,
                change: { kind: 'revoked', reasonCode: 'withdrawn' },
              },
            ],
          }),
        );
      }
      expect(await harness.storage.getEmbeddingProfile(TENANT, NAMESPACE)).toMatchObject({
        model: 'm',
        dimensions: 3,
      });
      expectCommitted(
        await harness.engine.submit(createEmbedded('operation-new', 'pn', [1, 0], 'fresh')),
      );
      expect(await harness.storage.getEmbeddingProfile(TENANT, NAMESPACE)).toMatchObject({
        model: 'fresh',
        dimensions: 2,
      });
    });

    it('never touches the marker on a commit that only retires records', async () => {
      const recorder = recordBatches();
      const storage = makeBackend(recorder.wrapApply);
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        projections: [embedded('g1', e1, [1, 0, 0])],
      });
      recorder.batches.length = 0;
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
      const batch = recorder.batches[0]!;
      expect(batch.conditions.some((condition) => condition.key === MARKER)).toBe(false);
      expect(batch.operations.some((operation) => operation.key === MARKER)).toBe(false);
    });

    it('counts the marker toward the batch cap but not the in-memory bounds', async () => {
      const recorder = recordBatches();
      const storage = makeBackend(recorder.wrapApply);
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        projections: [embedded('g1', e1, [1, 0, 0])],
      });
      const batch = recorder.batches[0]!;
      // The marker is one condition and one put beside the record's own.
      expect(batch.conditions.filter((condition) => condition.key === MARKER)).toHaveLength(1);
      expect(batch.operations.filter((operation) => operation.key === MARKER)).toHaveLength(1);
      expect(batch.newProjectionRevisions).toBe(1);
      expect(batch.newEvidence).toBe(1);
    });
  });
}

describe('a namespace whose embedded records predate the marker', () => {
  /** A core over a Map, so the marker can be removed the way an older store would never have had it. */
  function legacyCore() {
    const store = new Map<string, Uint8Array>();
    const same = (left: Uint8Array | null, right: Uint8Array | undefined) =>
      left === null
        ? right === undefined
        : right !== undefined &&
          left.length === right.length &&
          left.every((b, i) => b === right[i]);
    const core = createEvidenceProjectionStoreCore({
      keys,
      reader: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        async *keys(prefix) {
          for (const key of store.keys()) if (key.startsWith(prefix)) yield key;
        },
      },
      apply: (batch) => {
        if (!batch.conditions.every((c) => same(c.expectedValue, store.get(c.key)))) {
          return Promise.resolve(false);
        }
        for (const operation of batch.operations) store.set(operation.key, operation.value);
        return Promise.resolve(true);
      },
    });
    return { core, store };
  }

  it('is scanned once, and refused if a recallable record of another profile remains', async () => {
    const { core, store } = legacyCore();
    await core.commit({
      tenantId: TENANT,
      evidence: [e1, e2],
      projections: [embedded('g1', e1, [1, 0, 0])],
    });
    store.delete(MARKER);
    const error = await rejectionOf(
      core.commit({ tenantId: TENANT, projections: [embedded('g2', e2, [1, 0])] }),
    );
    expect((error as EvidenceProjectionCommitError).code).toBe('embedding-profile-conflict');
    expect(store.has(MARKER)).toBe(false);
  });

  it('gets its marker from the first commit that agrees with what it already holds', async () => {
    const { core, store } = legacyCore();
    await core.commit({
      tenantId: TENANT,
      evidence: [e1, e2],
      projections: [embedded('g1', e1, [1, 0, 0])],
    });
    store.delete(MARKER);
    await core.commit({ tenantId: TENANT, projections: [embedded('g2', e2, [0, 1, 0])] });
    expect(await core.getEmbeddingProfile(TENANT, NAMESPACE)).toMatchObject({ dimensions: 3 });
  });
});

describe('the embedding profile record', () => {
  const decode = (raw: unknown) => decodeEmbeddingProfile(raw);
  const profile = embeddingProfileOf({ model: 'm', vector: [1, 0] });

  it('round-trips through its canonical bytes', () => {
    const bytes = encodeEmbeddingProfile(profile);
    expect(decode(JSON.parse(new TextDecoder().decode(bytes)))).toEqual(profile);
    expect(profile).toEqual({
      schemaVersion: EMBEDDING_PROFILE_SCHEMA_VERSION,
      model: 'm',
      dimensions: 2,
      generation: 1,
    });
  });

  it('refuses a stray key as malformed and a later schema version as unsupported', () => {
    for (const [value, code] of [
      [{ ...profile, extra: true }, 'malformed'],
      [{ ...profile, schemaVersion: 2 }, 'unsupported-revision'],
      [{ ...profile, dimensions: 0 }, 'malformed'],
      [{ ...profile, generation: 0 }, 'malformed'],
      [{ ...profile, generation: undefined }, 'malformed'],
      [{ ...profile, model: '' }, 'malformed'],
    ] as const) {
      try {
        decode(value);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryEvidenceValidationError);
        expect((error as MemoryEvidenceValidationError).code).toBe(code);
      }
    }
  });

  it('is keyed in its own sub-family, which neither scan returns', () => {
    const marker = keys.embeddingProfile(TENANT, NAMESPACE);
    expect(marker.startsWith(keys.currentScan(TENANT, NAMESPACE))).toBe(false);
    expect(marker.startsWith(keys.historyScan(TENANT, NAMESPACE, 'embedding-profile'))).toBe(false);
    expect(marker.startsWith(keys.projectionPrefix)).toBe(true);
    expect(marker).toBe(`${keys.projectionPrefix}t:${TENANT}:n:${NAMESPACE}:m:embedding-profile`);
  });
});
