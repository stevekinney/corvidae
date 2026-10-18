import { beforeEach, describe, expect, it } from 'bun:test';

import { rebuildDerivedIndexes } from '../src/derived-indexes';
import type { EvidenceProjectionStorage } from '../src/evidence-projection-storage';
import { MemoryEvidenceValidationError } from '../src/evidence-schema';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import {
  makeAuthority,
  makeFact,
  makeInlineEvidence,
  NAMESPACE,
  OTHER_TENANT,
  TENANT,
} from './evidence-projection-fixtures';

export function registerTenantIsolationContractTests(options: {
  makeBackend: () => EvidenceProjectionStorage;
}): void {
  let storage: EvidenceProjectionStorage;
  beforeEach(async () => {
    storage = options.makeBackend();
    await storage.init();
  });

  describe('tenant isolation', () => {
    it('keeps identical ids in two tenants apart on every read', async () => {
      const mine = makeInlineEvidence('e1', { text: 'Mine.' });
      const theirs = makeInlineEvidence('e1', { text: 'Theirs.', tenantId: OTHER_TENANT });
      await storage.commit({
        tenantId: TENANT,
        evidence: [mine],
        projections: [makeFact('p1', [mine])],
      });
      await storage.commit({
        tenantId: OTHER_TENANT,
        evidence: [theirs],
        projections: [makeFact('p1', [theirs], { tenantId: OTHER_TENANT })],
      });

      expect(await storage.getEvidence(TENANT, 'e1')).toEqual(mine);
      expect(await storage.getEvidence(OTHER_TENANT, 'e1')).toEqual(theirs);
      const listed = await storage.listEvidence({ tenantId: TENANT });
      expect(listed.map((record) => record.id)).toEqual(['e1']);
      const theirProjection = await storage.getProjection(OTHER_TENANT, NAMESPACE, 'p1');
      expect(theirProjection?.tenantId).toBe(OTHER_TENANT);
      expect(
        await storage.listProjections({ tenantId: TENANT, namespace: NAMESPACE }),
      ).toHaveLength(1);
      const indexes = await rebuildDerivedIndexes({
        storage,
        tenantId: OTHER_TENANT,
        namespace: NAMESPACE,
        authority: makeAuthority({ tenantId: OTHER_TENANT }),
      });
      expect(indexes.lexical.query('Statement', { limit: 5 })).toHaveLength(1);
    });

    it('does not see another tenant through a read', async () => {
      await storage.appendEvidence(makeInlineEvidence('e1'));
      expect(await storage.getEvidence(OTHER_TENANT, 'e1')).toBeUndefined();
      expect(await storage.listEvidence({ tenantId: OTHER_TENANT })).toEqual([]);
    });

    it('refuses a commit that mixes tenants', async () => {
      const error = await rejectionOf(
        storage.commit({
          tenantId: TENANT,
          evidence: [
            makeInlineEvidence('e1'),
            makeInlineEvidence('e2', { tenantId: OTHER_TENANT }),
          ],
        }),
      );
      expect(error).toBeInstanceOf(MemoryEvidenceValidationError);
      expect((error as MemoryEvidenceValidationError).code).toBe('cross-tenant');
      expect(await storage.getEvidence(TENANT, 'e1')).toBeUndefined();
    });
  });
}
