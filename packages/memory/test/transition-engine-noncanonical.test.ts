import { describe, expect, it } from 'bun:test';

import type { ApplyPlannedBatch, WrapApply } from '../src/evidence-projection-store-core';
import { makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  correctionProposal,
  createHarness,
  expectCommitted,
  makeWriteAuthority,
  NAMESPACE,
  proposedFact,
  TENANT,
} from './transition-test-support';

/**
 * Stored bytes the core did not write: valid, and decoding to the same record,
 * but not in the order the core writes keys. The read set records the bytes the
 * store returned, so such a record is guarded like any other and never makes
 * every transition that touches it conflict.
 */

const authority = makeWriteAuthority();
const e1 = makeInlineEvidence('e1');

/** Rewrites every put of the first batch with its keys reversed: same record, other bytes. */
function reorderFirstBatch(): WrapApply {
  let reordered = false;
  return (apply: ApplyPlannedBatch) => async (batch) => {
    if (reordered) return apply(batch);
    reordered = true;
    return apply({
      ...batch,
      operations: batch.operations.map((operation) => {
        const parsed = JSON.parse(new TextDecoder().decode(operation.value)) as Record<
          string,
          unknown
        >;
        const reversed = Object.fromEntries(Object.entries(parsed).toReversed());
        return { ...operation, value: new TextEncoder().encode(JSON.stringify(reversed)) };
      }),
    });
  };
}

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`records stored in non-canonical bytes (${label})`, () => {
    async function seeded() {
      const harness = createHarness(makeBackend, { wrapApply: reorderFirstBatch() });
      await harness.storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        projections: [makeFact('p1', [e1])],
      });
      // The records decode as they were written.
      expect(await harness.storage.getEvidence(TENANT, 'e1')).toEqual(e1);
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'p1')).toEqual(
        makeFact('p1', [e1]),
      );
      return harness;
    }

    it('lets a creation that cites the evidence commit', async () => {
      const harness = await seeded();
      const result = await harness.engine.submit({
        kind: 'create-projection',
        operationId: 'op-1',
        tenantId: TENANT,
        authority,
        projections: [proposedFact('p9', [{ id: 'e1', digest: e1.digest }])],
      });
      expect(result.outcome === 'committed' ? 'committed' : JSON.stringify(result)).toBe(
        'committed',
      );
    });

    it('lets a revision of the projection commit', async () => {
      const harness = await seeded();
      expectCommitted(
        await harness.engine.submit({
          kind: 'revise-projection',
          operationId: 'op-2',
          tenantId: TENANT,
          authority,
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p1',
              expectedRevision: 1,
              change: { kind: 'revoked', reasonCode: 'withdrawn' },
            },
          ],
        }),
      );
    });

    it('lets a correction that supersedes the evidence and the projection commit', async () => {
      const harness = await seeded();
      expectCommitted(await harness.engine.submit(correctionProposal('op-3')));
    });
  });
}
