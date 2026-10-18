import { describe, expect, it } from 'bun:test';

import { consolidateProjections } from '../src/consolidate-projections';
import { DerivedIndexConsistencyError, rebuildDerivedIndexes } from '../src/derived-indexes';
import type { EvidenceProjectionStorage } from '../src/evidence-projection-storage';
import type { ApplyPlannedBatch, WrapApply } from '../src/evidence-projection-store-core';
import {
  createTransitionEngine,
  TransitionIdentifierConflictError,
} from '../src/transition-engine';
import type { TransitionProposal } from '../src/transition-proposal';
import { makeAuthority, makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  appendProposal,
  correctionProposal,
  createBarrier,
  createManualClock,
  createOrderedGates,
  createRecordingSink,
  expectCommitted,
  makeWriteAuthority,
  NAMESPACE,
  seedCorrectionState,
  TENANT,
} from './transition-test-support';

/**
 * Two submissions meet at a named barrier and are released together, so the
 * interleaving is the test's choice and no sleep decides it.
 */

/** Parks every batch at `barrier` and records what each apply resolved to. */
function parkingWrapper(barrier: ReturnType<typeof createBarrier>) {
  const results: boolean[] = [];
  const wrapApply: WrapApply = (apply: ApplyPlannedBatch) => async (batch) => {
    await barrier.arrive();
    const applied = await apply(batch);
    results.push(applied);
    return applied;
  };
  return { wrapApply, results };
}

function engineOver(
  storage: EvidenceProjectionStorage,
  options: {
    clock?: ReturnType<typeof createManualClock>;
    beforeBatch?: () => Promise<void>;
  } = {},
) {
  const recorder = createRecordingSink();
  const clock = options.clock ?? createManualClock();
  const engine = createTransitionEngine({
    storage,
    sink: recorder.sink,
    now: clock.now,
    ...(options.beforeBatch === undefined ? {} : { hooks: { beforeBatch: options.beforeBatch } }),
  });
  return { engine, recorder, clock };
}

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`concurrent identical submissions (${label})`, () => {
    for (const [variant, skew] of [
      ['under one clock', 0],
      ['under two clocks', 5_000],
    ] as const) {
      it(`yield exactly one commit and the same receipt ${variant}`, async () => {
        const barrier = createBarrier(2);
        const parking = parkingWrapper(barrier);
        const storage = makeBackend(parking.wrapApply);
        const first = engineOver(storage);
        const second = engineOver(storage, {
          clock: createManualClock(first.clock.current + skew),
        });

        const pendingFirst = first.engine.submit(appendProposal('operation-1'));
        const pendingSecond = second.engine.submit(appendProposal('operation-1'));
        await barrier.whenFull;
        barrier.release();
        const results = [expectCommitted(await pendingFirst), expectCommitted(await pendingSecond)];

        expect(results[0]!.receipt).toEqual(results[1]!.receipt);
        expect(results.map((result) => result.replayed)).toContain(true);
        expect(results.map((result) => result.replayed)).toContain(false);
        expect(parking.results.filter(Boolean)).toHaveLength(1);
        expect(await storage.listEvidence({ tenantId: TENANT })).toHaveLength(1);
        const loser = results[0]!.replayed ? first : second;
        expect(loser.recorder.kinds()).toEqual([
          'requested',
          'validation-started',
          'recovery-reconciled',
        ]);
      });
    }

    it('throws the typed identifier error in the submission that lost to a different proposal', async () => {
      const barrier = createBarrier(2);
      const parking = parkingWrapper(barrier);
      const storage = makeBackend(parking.wrapApply);
      const first = engineOver(storage);
      const second = engineOver(storage);

      const pendingFirst = first.engine.submit(appendProposal('operation-1', ['e1']));
      const pendingSecond = second.engine.submit(appendProposal('operation-1', ['e2']));
      await barrier.whenFull;
      barrier.release();
      const outcomes = await Promise.all([
        pendingFirst.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
        pendingSecond.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
      ]);
      const winners = outcomes.filter((outcome) => 'value' in outcome);
      const losers = outcomes.filter((outcome) => 'error' in outcome);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect((losers[0] as { error: unknown }).error).toBeInstanceOf(
        TransitionIdentifierConflictError,
      );
      expect(await storage.listEvidence({ tenantId: TENANT })).toHaveLength(1);
    });
  });

  describe(`concurrent writers on one projection (${label})`, () => {
    const e1 = makeInlineEvidence('e1');
    const e2 = makeInlineEvidence('e2');
    const p1 = makeFact('p1', [e1]);
    const authority = makeWriteAuthority();

    /** Both writers pass validation and the stale check, then meet before the batch. */
    async function pair() {
      const storage = makeBackend();
      await storage.commit({ tenantId: TENANT, evidence: [e1], projections: [p1] });
      const gates = createOrderedGates(2);
      return {
        storage,
        gates,
        writers: [
          engineOver(storage, { beforeBatch: gates.hold(0) }),
          engineOver(storage, { beforeBatch: gates.hold(1) }),
        ] as const,
      };
    }

    /** Releases the writers one at a time, `first` then the other, and returns their results by writer. */
    async function race<Result>(
      gates: ReturnType<typeof createOrderedGates>,
      pending: readonly [Promise<Result>, Promise<Result>],
      first: 0 | 1,
    ): Promise<[Result, Result]> {
      await gates.whenAllArrived;
      gates.release(first);
      const winner = await pending[first];
      gates.release(first === 0 ? 1 : 0);
      const loser = await pending[first === 0 ? 1 : 0];
      return first === 0 ? [winner, loser] : [loser, winner];
    }

    const revise = (operationId: string, change: unknown): TransitionProposal =>
      ({
        kind: 'revise-projection',
        operationId,
        tenantId: TENANT,
        authority,
        revisions: [{ namespace: NAMESPACE, id: 'p1', expectedRevision: 1, change }],
      }) as TransitionProposal;

    for (const first of [0, 1] as const) {
      it(`lets exactly one of two revisions of one projection commit, writer ${first} first, and the loser leaves no receipt`, async () => {
        const { storage, gates, writers } = await pair();
        const pending = [
          writers[0].engine.submit(revise('operation-a', { kind: 'revoked', reasonCode: 'a' })),
          writers[1].engine.submit(revise('operation-b', { kind: 'revoked', reasonCode: 'b' })),
        ] as const;
        const results = await race(gates, pending, first);

        const loser = first === 0 ? 1 : 0;
        expect(results[first].outcome).toBe('committed');
        expect(results[loser]).toMatchObject({
          outcome: 'conflicted',
          reason: 'revision-conflict',
        });
        const history = await storage.listProjectionHistory(TENANT, NAMESPACE, 'p1');
        expect(history.map((record) => record.revision)).toEqual([1, 2]);
        const operations = ['operation-a', 'operation-b'] as const;
        expect(await writers[first].engine.getReceipt(TENANT, operations[first])).toBeDefined();
        expect(await writers[loser].engine.getReceipt(TENANT, operations[loser])).toBeUndefined();
        expect(writers[loser].recorder.kinds()).toEqual([
          'requested',
          'validation-started',
          'conflicted',
        ]);
      });

      it(`lets exactly one of a revision and a supersession of one projection commit, writer ${first} first`, async () => {
        const { storage, gates, writers } = await pair();
        const pending = [
          writers[0].engine.submit(revise('operation-a', { kind: 'revoked', reasonCode: 'a' })),
          writers[1].engine.submit({ ...correctionProposal('operation-b'), authority }),
        ] as const;
        const results = await race(gates, pending, first);

        const loser = first === 0 ? 1 : 0;
        expect(results[first].outcome).toBe('committed');
        expect(results[loser].outcome).toBe('conflicted');
        const history = await storage.listProjectionHistory(TENANT, NAMESPACE, 'p1');
        expect(history.map((record) => record.revision)).toEqual([1, 2]);
        const supersessionWon = first === 1;
        expect((await storage.getProjection(TENANT, NAMESPACE, 'p2')) !== undefined).toBe(
          supersessionWon,
        );
        expect((await storage.getEvidenceSupersession(TENANT, 'e1')) !== undefined).toBe(
          supersessionWon,
        );
        expect((await writers[0].engine.getReceipt(TENANT, 'operation-a')) !== undefined).toBe(
          !supersessionWon,
        );
        expect((await writers[1].engine.getReceipt(TENANT, 'operation-b')) !== undefined).toBe(
          supersessionWon,
        );
      });

      it(`lets exactly one of a consolidation and a revision of one of its candidates commit, ${first === 0 ? 'the consolidation' : 'the revision'} first`, async () => {
        const storage = makeBackend();
        const f1 = makeFact('f1', [e1]);
        const f2 = makeFact('f2', [e2]);
        await storage.commit({ tenantId: TENANT, evidence: [e1, e2], projections: [f1, f2] });
        const gates = createOrderedGates(2);
        const consolidator = engineOver(storage, { beforeBatch: gates.hold(0) });
        const writer = engineOver(storage, { beforeBatch: gates.hold(1) });

        const pending = [
          consolidateProjections({
            engine: consolidator.engine,
            authority,
            operationId: 'consolidate-1',
            namespace: NAMESPACE,
            candidates: [
              { id: 'f1', revision: 1 },
              { id: 'f2', revision: 1 },
            ],
            outcome: 'supersede',
            summarize: () => Promise.resolve('Summary'),
            summaryId: 's1',
            projectorRevision: 'consolidator:1',
            promptRevision: 'prompt:1',
          }),
          writer.engine.submit({
            kind: 'revise-projection',
            operationId: 'write-1',
            tenantId: TENANT,
            authority,
            revisions: [
              {
                namespace: NAMESPACE,
                id: 'f1',
                expectedRevision: 1,
                change: { kind: 'revoked', reasonCode: 'withdrawn' },
              },
            ],
          }),
        ] as const;
        const [consolidation, write] = await race(gates, pending, first);

        const revisions = async (id: string) => {
          const history = await storage.listProjectionHistory(TENANT, NAMESPACE, id);
          return history.length;
        };
        if (first === 0) {
          expect(consolidation.outcome).toBe('committed');
          expect(write).toMatchObject({ outcome: 'conflicted' });
          // The summary gains revision 1, and every candidate gains one revision.
          expect(await revisions('s1')).toBe(1);
          expect(await revisions('f1')).toBe(2);
          expect(await revisions('f2')).toBe(2);
          expect(await writer.engine.getReceipt(TENANT, 'write-1')).toBeUndefined();
        } else {
          expect(write.outcome).toBe('committed');
          expect(consolidation).toMatchObject({ outcome: 'conflicted' });
          // Only the written candidate gains a revision, and no summary exists.
          expect(await revisions('f1')).toBe(2);
          expect(await revisions('f2')).toBe(1);
          expect(await storage.getProjection(TENANT, NAMESPACE, 's1')).toBeUndefined();
          expect(await consolidator.engine.getReceipt(TENANT, 'consolidate-1')).toBeUndefined();
        }
      });
    }
  });

  describe(`a supersession racing a derived index rebuild (${label})`, () => {
    it('returns the pre-commit or the post-commit indexes, never both projections, and converges', async () => {
      const storage = makeBackend();
      await seedCorrectionState(storage);
      const { engine } = engineOver(storage);

      // Park the rebuild after its first evidence read, then commit the correction under it.
      const parked = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let parkedOnce = false;
      const view: EvidenceProjectionStorage = {
        ...storage,
        listEvidence: async (filter) => {
          const evidence = await storage.listEvidence(filter);
          if (!parkedOnce) {
            parkedOnce = true;
            parked.resolve();
            await resume.promise;
          }
          return evidence;
        },
      };
      const rebuild = () =>
        rebuildDerivedIndexes({
          storage: view,
          tenantId: TENANT,
          namespace: NAMESPACE,
          authority: makeAuthority(),
        });

      const pendingRebuild = rebuild().then(
        (indexes) => ({ indexes }),
        (error: unknown) => ({ error }),
      );
      await parked.promise;
      expectCommitted(await engine.submit(correctionProposal('operation-1')));
      resume.resolve();
      const raced = await pendingRebuild;

      const idsOf = (indexes: Awaited<ReturnType<typeof rebuildDerivedIndexes>>) =>
        indexes.lexical.query('Statement', { limit: 10 }).map((hit) => hit.id);
      if ('error' in raced) {
        expect(raced.error).toBeInstanceOf(DerivedIndexConsistencyError);
      } else {
        const ids = idsOf(raced.indexes);
        // Exactly the pre-commit or the post-commit projection, never the old and the new together.
        expect([['p1'], ['p2']]).toContainEqual(ids);
      }
      const settled = await rebuildDerivedIndexes({
        storage,
        tenantId: TENANT,
        namespace: NAMESPACE,
        authority: makeAuthority(),
      });
      expect(idsOf(settled)).toEqual(['p2']);
      const next = await rebuild();
      expect(idsOf(next)).toEqual(['p2']);
    });
  });
}
