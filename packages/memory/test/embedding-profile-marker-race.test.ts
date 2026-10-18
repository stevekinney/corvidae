import { describe, expect, it } from 'bun:test';

import type { ApplyPlannedBatch, WrapApply } from '../src/evidence-projection-store-core';
import { createTransitionEngine } from '../src/transition-engine';
import { makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  createBarrier,
  createManualClock,
  createRecordingSink,
  makeWriteAuthority,
  NAMESPACE,
  proposedFact,
  TENANT,
} from './transition-test-support';

const e1 = makeInlineEvidence('e1');
const e2 = makeInlineEvidence('e2');

/** Parks the first two batches at one barrier, so both commits are planned before either applies. */
function parkFirstTwo(barrier: ReturnType<typeof createBarrier>): WrapApply {
  let parked = 0;
  return (apply: ApplyPlannedBatch) => async (batch) => {
    if (parked < 2) {
      parked += 1;
      await barrier.arrive();
    }
    return apply(batch);
  };
}

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`the embedding profile marker race, both planned before either applies (${label})`, () => {
    it('direct commits: exactly one of two incompatible profiles lands', async () => {
      const barrier2 = createBarrier(2);
      let seeded = false;
      const wrap: WrapApply = (apply) => {
        const parked = parkFirstTwo(barrier2)(apply);
        return async (batch) => (seeded ? parked(batch) : apply(batch));
      };
      const store = makeBackend(wrap);
      await store.commit({ tenantId: TENANT, evidence: [e1, e2] });
      seeded = true;
      const a = store.commit({
        tenantId: TENANT,
        projections: [makeFact('pa', [e1], { embedding: { model: 'm', vector: [1, 0, 0] } })],
      });
      const b = store.commit({
        tenantId: TENANT,
        projections: [makeFact('pb', [e2], { embedding: { model: 'm', vector: [1, 0] } })],
      });
      await barrier2.whenFull;
      barrier2.release();
      const settled = await Promise.allSettled([a, b]);
      expect(settled.map((entry) => entry.status).toSorted()).toEqual(['fulfilled', 'rejected']);
      const ids = [
        await store.getProjection(TENANT, NAMESPACE, 'pa'),
        await store.getProjection(TENANT, NAMESPACE, 'pb'),
      ].filter((record) => record !== undefined);
      expect(ids).toHaveLength(1);
    });

    it('engine submissions: exactly one commits, the other is conflicted', async () => {
      const barrier = createBarrier(2);
      let seeded = false;
      const wrap: WrapApply = (apply) => {
        const parked = parkFirstTwo(barrier)(apply);
        return async (batch) => (seeded ? parked(batch) : apply(batch));
      };
      const storage = makeBackend(wrap);
      await storage.commit({ tenantId: TENANT, evidence: [e1] });
      seeded = true;
      const clock = createManualClock();
      const engine = () =>
        createTransitionEngine({ storage, sink: createRecordingSink().sink, now: clock.now });
      const create = (operationId: string, id: string, vector: number[]) => ({
        kind: 'create-projection' as const,
        operationId,
        tenantId: TENANT,
        authority: makeWriteAuthority(),
        projections: [
          proposedFact(id, [{ id: 'e1', digest: e1.digest }], {
            embedding: { model: 'm', vector },
          }),
        ],
      });
      const pending = [
        engine().submit(create('op-a', 'pa', [1, 0, 0])),
        engine().submit(create('op-b', 'pb', [1, 0])),
      ];
      await barrier.whenFull;
      barrier.release();
      const results = await Promise.all(pending);
      expect(results.map((result) => result.outcome).toSorted()).toEqual([
        'committed',
        'conflicted',
      ]);
    });
  });
}
