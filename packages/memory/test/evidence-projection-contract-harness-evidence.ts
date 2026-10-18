import { beforeEach, describe, expect, it } from 'bun:test';

import {
  EvidenceImmutableError,
  EvidenceProjectionCommitError,
  type EvidenceProjectionStorage,
} from '../src/evidence-projection-storage';
import type { EvidenceRecord } from '../src/evidence-schema';
import { MemoryEvidenceValidationError } from '../src/evidence-schema';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import { makeInlineEvidence, OWNER, TENANT } from './evidence-projection-fixtures';

export function registerEvidenceContractTests(options: {
  makeBackend: () => EvidenceProjectionStorage;
}): void {
  let storage: EvidenceProjectionStorage;
  beforeEach(async () => {
    storage = options.makeBackend();
    await storage.init();
  });

  describe('evidence is append-only', () => {
    it('appends a record, reads it back, and reports an identical replay as a duplicate', async () => {
      const record = makeInlineEvidence('e1');
      expect(await storage.appendEvidence(record)).toBe('appended');
      expect(await storage.getEvidence(TENANT, 'e1')).toEqual(record);
      expect(await storage.appendEvidence(record)).toBe('duplicate');
    });

    it('treats key order as irrelevant: the canonical encoding decides identity', async () => {
      const record = makeInlineEvidence('e1');
      await storage.appendEvidence(record);
      const reordered = Object.fromEntries(
        Object.entries(record).toReversed(),
      ) as unknown as EvidenceRecord;
      expect(Object.keys(reordered)[0]).not.toBe(Object.keys(record)[0]);
      expect(await storage.appendEvidence(reordered)).toBe('duplicate');
    });

    it('refuses a different record under an existing id and leaves the stored one untouched', async () => {
      const original = makeInlineEvidence('e1');
      await storage.appendEvidence(original);
      const error = await rejectionOf(
        storage.appendEvidence(makeInlineEvidence('e1', { text: 'Rewritten content.' })),
      );
      expect(error).toBeInstanceOf(EvidenceImmutableError);
      expect(await storage.getEvidence(TENANT, 'e1')).toEqual(original);
    });

    it('rejects an unknown field as malformed instead of storing it', async () => {
      const withExtra = {
        ...makeInlineEvidence('e1'),
        surprise: true,
      } as unknown as EvidenceRecord;
      const error = await rejectionOf(storage.appendEvidence(withExtra));
      expect(error).toBeInstanceOf(MemoryEvidenceValidationError);
      expect((error as MemoryEvidenceValidationError).code).toBe('malformed');
      expect(await storage.getEvidence(TENANT, 'e1')).toBeUndefined();
    });

    it('lists evidence by owner', async () => {
      await storage.appendEvidence(makeInlineEvidence('e1'));
      await storage.appendEvidence(makeInlineEvidence('e2', { ownerId: 'owner-2' }));
      const mine = await storage.listEvidence({ tenantId: TENANT, ownerId: OWNER });
      expect(mine.map((record) => record.id)).toEqual(['e1']);
      expect(await storage.listEvidence({ tenantId: TENANT })).toHaveLength(2);
    });

    it('rejects an empty commit', async () => {
      const error = await rejectionOf(storage.commit({ tenantId: TENANT }));
      expect(error).toBeInstanceOf(EvidenceProjectionCommitError);
      expect((error as EvidenceProjectionCommitError).code).toBe('invalid-commit');
    });
  });
}
