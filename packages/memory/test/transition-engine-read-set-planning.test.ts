import { describe, expect, it } from 'bun:test';

import type { ApplyPlannedBatch, WrapApply } from '../src/evidence-projection-store-core';
import { createTransitionEngine } from '../src/transition-engine';
import type { TransitionProposal } from '../src/transition-proposal';
import { makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
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

const authority = makeWriteAuthority();
const e1 = makeInlineEvidence('e1');
const engineOver = (storage: Parameters<typeof createTransitionEngine>[0]['storage']) =>
  createTransitionEngine({
    storage,
    sink: createRecordingSink().sink,
    now: createManualClock().now,
  });

const supersedeBy = (operationId: string, id: string, successor: string): TransitionProposal => ({
  kind: 'revise-projection',
  operationId,
  tenantId: TENANT,
  authority,
  revisions: [
    {
      namespace: NAMESPACE,
      id,
      expectedRevision: 1,
      change: { kind: 'superseded', supersededBy: { id: successor, revision: 1 } },
    },
  ],
});

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`the read set against writers that land after planning (${label})`, () => {
    it('Q1: a successor revoked between planning and apply (inside the store boundary) still conflicts', async () => {
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
      const p1 = makeFact('p1', [e1]);
      const p3 = makeFact('p3', [e1], { payload: { statement: 'Successor.', entities: [] } });
      await storage.commit({ tenantId: TENANT, evidence: [e1], projections: [p1, p3] });
      parkNext = true;
      const pending = engineOver(storage).submit(supersedeBy('supersede-p1', 'p1', 'p3'));
      await parked.promise;
      expectCommitted(
        await engineOver(storage).submit({
          kind: 'revise-projection',
          operationId: 'revoke-p3',
          tenantId: TENANT,
          authority,
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p3',
              expectedRevision: 1,
              change: { kind: 'revoked', reasonCode: 'x' },
            },
          ],
        }),
      );
      resume.resolve();
      expectRefused(await pending, 'conflicted');
      const untouched = await storage.getProjection(TENANT, NAMESPACE, 'p1');
      expect(untouched?.revision).toBe(1);
    });

    it('Q2a: two independent creations citing the same evidence, both planned before either applies, both commit', async () => {
      const barrier = createBarrier(2);
      let seeded = false;
      const wrap: WrapApply = (apply: ApplyPlannedBatch) => async (batch) => {
        if (seeded) await barrier.arrive();
        return apply(batch);
      };
      const storage = makeBackend(wrap);
      await storage.commit({ tenantId: TENANT, evidence: [e1] });
      seeded = true;
      const create = (operationId: string, id: string): TransitionProposal => ({
        kind: 'create-projection',
        operationId,
        tenantId: TENANT,
        authority,
        projections: [proposedFact(id, [{ id: 'e1', digest: e1.digest }])],
      });
      const pending = [
        engineOver(storage).submit(create('op-a', 'pa')),
        engineOver(storage).submit(create('op-b', 'pb')),
      ];
      await barrier.whenFull;
      barrier.release();
      const results = await Promise.all(pending);
      expect(results.map((result) => result.outcome)).toEqual(['committed', 'committed']);
    });

    it('Q2b: two supersessions of different projections by one shared successor, concurrently, both commit', async () => {
      const barrier = createBarrier(2);
      let seeded = false;
      const wrap: WrapApply = (apply: ApplyPlannedBatch) => async (batch) => {
        if (seeded) await barrier.arrive();
        return apply(batch);
      };
      const storage = makeBackend(wrap);
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        projections: [
          makeFact('p1', [e1]),
          makeFact('p2', [e1], { payload: { statement: 'Two.', entities: [] } }),
          makeFact('p3', [e1], { payload: { statement: 'Successor.', entities: [] } }),
        ],
      });
      seeded = true;
      const pending = [
        engineOver(storage).submit(supersedeBy('op-a', 'p1', 'p3')),
        engineOver(storage).submit(supersedeBy('op-b', 'p2', 'p3')),
      ];
      await barrier.whenFull;
      barrier.release();
      const results = await Promise.all(pending);
      expect(results.map((result) => result.outcome)).toEqual(['committed', 'committed']);
    });
  });
}
