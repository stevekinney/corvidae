import { describe, expect, it } from 'bun:test';

import { FIXED_AT, makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  createHarness,
  expectRefused,
  makeWriteAuthority,
  NAMESPACE,
  TENANT,
} from './transition-test-support';

/**
 * A successor a revision references is held to the same invariants whether the
 * proposal creates it or finds it stored: active afterwards, and not valid from
 * before the projection it replaces.
 */

const e1 = makeInlineEvidence('e1');
const authority = makeWriteAuthority();

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`an existing successor (${label})`, () => {
    for (const kind of ['superseded', 'demoted'] as const) {
      it(`must not be valid from before the projection it ${kind === 'superseded' ? 'supersedes' : 'demotes'}`, async () => {
        const harness = createHarness(makeBackend);
        await harness.storage.commit({
          tenantId: TENANT,
          evidence: [e1],
          projections: [
            makeFact('p1', [e1], { validity: { validFrom: FIXED_AT + 200 } }),
            makeFact('p3', [e1], {
              payload: { statement: 'Older successor.', entities: [] },
              validity: { validFrom: FIXED_AT + 100 },
            }),
          ],
        });
        const change =
          kind === 'superseded'
            ? { kind, supersededBy: { id: 'p3', revision: 1 } }
            : { kind, demotedBy: { id: 'p3', revision: 1 } };
        const result = expectRefused(
          await harness.engine.submit({
            kind: 'revise-projection',
            operationId: 'operation-1',
            tenantId: TENANT,
            authority,
            revisions: [{ namespace: NAMESPACE, id: 'p1', expectedRevision: 1, change }],
          } as never),
          'rejected',
        );
        expect(result.reason).toBe('temporal-inconsistency');
        const untouched = await harness.storage.getProjection(TENANT, NAMESPACE, 'p1');
        expect(untouched?.revision).toBe(1);
        expect(await harness.engine.getReceipt(TENANT, 'operation-1')).toBeUndefined();
      });
    }

    it('commits when it is valid from the same instant or later', async () => {
      const harness = createHarness(makeBackend);
      await harness.storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        projections: [
          makeFact('p1', [e1], { validity: { validFrom: FIXED_AT + 100 } }),
          makeFact('p3', [e1], {
            payload: { statement: 'Same instant.', entities: [] },
            validity: { validFrom: FIXED_AT + 100 },
          }),
        ],
      });
      const result = await harness.engine.submit({
        kind: 'revise-projection',
        operationId: 'operation-1',
        tenantId: TENANT,
        authority,
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'p1',
            expectedRevision: 1,
            change: { kind: 'superseded', supersededBy: { id: 'p3', revision: 1 } },
          },
        ],
      });
      expect(result.outcome).toBe('committed');
    });
  });
}
