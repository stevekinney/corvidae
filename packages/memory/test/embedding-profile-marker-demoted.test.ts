import { describe, expect, it } from 'bun:test';

import { EvidenceProjectionCommitError } from '../src/evidence-projection-storage';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import { makeFact, makeInlineEvidence, NAMESPACE, TENANT } from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS } from './transition-backends';

const e1 = makeInlineEvidence('e1');
const e2 = makeInlineEvidence('e2');
const old = (id: string, evidence: typeof e1, vector: number[]) =>
  makeFact(id, [evidence], { embedding: { model: 'm', vector } });

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`the embedding profile marker: demotion keeps an embedding recallable (${label})`, () => {
    it('refuses a direct commit that demotes every old-profile record under a new profile', async () => {
      const storage = makeBackend();
      const g1 = old('g1', e1, [1, 0, 0]);
      const g2 = old('g2', e2, [0, 1, 0]);
      await storage.commit({ tenantId: TENANT, evidence: [e1, e2], projections: [g1, g2] });
      const demote = (record: typeof g1) => ({
        ...record,
        revision: 2,
        status: 'demoted' as const,
        transition: { kind: 'demoted' as const, at: 5, demotedBy: { id: 's1', revision: 1 } },
      });
      const summary = makeFact('s1', [e1, e2], { embedding: { model: 'new', vector: [1, 0] } });
      const error = await rejectionOf(
        storage.commit({ tenantId: TENANT, projections: [summary, demote(g1), demote(g2)] }),
      );
      expect((error as EvidenceProjectionCommitError).code).toBe('embedding-profile-conflict');
    });

    it('refuses a new profile while a stored demoted record of the old profile remains', async () => {
      const storage = makeBackend();
      const g1 = old('g1', e1, [1, 0, 0]);
      const anchor = makeFact('a1', [e2]);
      await storage.commit({ tenantId: TENANT, evidence: [e1, e2], projections: [g1, anchor] });
      await storage.commit({
        tenantId: TENANT,
        projections: [
          {
            ...g1,
            revision: 2,
            status: 'demoted',
            transition: { kind: 'demoted', at: 5, demotedBy: { id: 'a1', revision: 1 } },
          },
        ],
      });
      const error = await rejectionOf(
        storage.commit({
          tenantId: TENANT,
          projections: [makeFact('n1', [e2], { embedding: { model: 'new', vector: [1, 0] } })],
        }),
      );
      expect((error as EvidenceProjectionCommitError).code).toBe('embedding-profile-conflict');
      expect(await storage.getProjection(TENANT, NAMESPACE, 'n1')).toBeUndefined();
    });
  });
}
