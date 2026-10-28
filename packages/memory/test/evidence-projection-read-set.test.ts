import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createEvidenceProjectionKeys } from '../src/evidence-projection-keys';
import {
  EvidenceProjectionBatchLimitError,
  EvidenceProjectionCommitError,
  ProjectionRevisionConflictError,
} from '../src/evidence-projection-storage';
import { MAX_COMMIT_BATCH_OPERATIONS } from '../src/evidence-projection-store-core';
import { encodeEvidenceRecord } from '../src/evidence-schema';
import { makeInlineEvidence, TENANT } from './evidence-projection-fixtures';
import { recordBatches, TRANSITION_BACKENDS } from './transition-backends';

/**
 * The read set on `commit()`: keys the caller read, with the bytes it saw, each
 * a condition of the batch. The store never interprets them.
 */

const keys = createEvidenceProjectionKeys();
const e1 = makeInlineEvidence('e1');
const e2 = makeInlineEvidence('e2');

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`commit read set (${label})`, () => {
    it('applies when every key still holds what the caller saw, and conditions the batch on each', async () => {
      const recorder = recordBatches();
      const storage = makeBackend(recorder.wrapApply);
      await storage.commit({ tenantId: TENANT, evidence: [e1] });
      recorder.batches.length = 0;
      const seen = keys.evidence(TENANT, 'e1');
      const absent = keys.evidence(TENANT, 'ghost');
      await storage.commit({
        tenantId: TENANT,
        evidence: [e2],
        readSet: [
          { key: seen, value: encodeEvidenceRecord(e1) },
          { key: absent, value: undefined },
        ],
      });
      const conditions = recorder.batches[0]!.conditions;
      expect(conditions).toContainEqual({ key: seen, expectedValue: encodeEvidenceRecord(e1) });
      expect(conditions).toContainEqual({ key: absent, expectedValue: null });
      expect(await storage.getEvidence(TENANT, 'e2')).toBeDefined();
    });

    it('refuses as a conflict, writing nothing, when a key changed since the caller read it', async () => {
      const storage = makeBackend();
      await storage.commit({ tenantId: TENANT, evidence: [e1] });
      const error = await rejectionOf(
        storage.commit({
          tenantId: TENANT,
          evidence: [e2],
          readSet: [{ key: keys.evidence(TENANT, 'e1'), value: new Uint8Array([1, 2, 3]) }],
        }),
      );
      expect(error).toBeInstanceOf(ProjectionRevisionConflictError);
      expect(await storage.getEvidence(TENANT, 'e2')).toBeUndefined();
    });

    it('refuses as a conflict a key the caller saw absent that has since appeared', async () => {
      const storage = makeBackend();
      await storage.commit({ tenantId: TENANT, evidence: [e1] });
      const error = await rejectionOf(
        storage.commit({
          tenantId: TENANT,
          evidence: [e2],
          readSet: [{ key: keys.evidence(TENANT, 'e1'), value: undefined }],
        }),
      );
      expect(error).toBeInstanceOf(ProjectionRevisionConflictError);
    });

    it('refuses an empty key as an invalid commit', async () => {
      const error = await rejectionOf(
        makeBackend().commit({
          tenantId: TENANT,
          evidence: [e1],
          readSet: [{ key: '', value: undefined }],
        }),
      );
      expect((error as EvidenceProjectionCommitError).code).toBe('invalid-commit');
    });

    it('counts the read set toward the batch cap', async () => {
      const storage = makeBackend();
      const readSet = Array.from({ length: MAX_COMMIT_BATCH_OPERATIONS }, (_, index) => ({
        key: keys.evidence(TENANT, `unread-${index}`),
        value: undefined,
      }));
      const error = await rejectionOf(
        storage.commit({ tenantId: TENANT, evidence: [e1], readSet }),
      );
      expect(error).toBeInstanceOf(EvidenceProjectionBatchLimitError);
      expect(await storage.getEvidence(TENANT, 'e1')).toBeUndefined();
    });
  });
}
