import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createInMemoryEvidenceProjectionStorage } from '../src/create-in-memory-evidence-projection-storage';
import { createEvidenceProjectionKeys } from '../src/evidence-projection-keys';
import type { EvidenceProjectionStorage } from '../src/evidence-projection-storage';
import {
  EvidenceProjectionBatchLimitError,
  EvidenceProjectionCommitError,
} from '../src/evidence-projection-storage';
import { MAX_COMMIT_BATCH_OPERATIONS } from '../src/evidence-projection-store-core';
import { makeFact, makeInlineEvidence, NAMESPACE, TENANT } from './evidence-projection-fixtures';
import { failFirstBatch, recordBatches, TRANSITION_BACKENDS } from './transition-backends';

/**
 * The receipt put on `commit()`: an opaque `{ key, build }` receipt written in the same
 * batch as the records and conditioned on its key being absent. The store never
 * reads the bytes `build` returns, so these tests use raw bytes.
 */

const KEY = 'app:test:receipt:one';
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const e1 = makeInlineEvidence('e1');

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`commit receipt (${label})`, () => {
    it('puts the receipt in the same batch that is handed to apply', async () => {
      const recorder = recordBatches();
      const storage = makeBackend(recorder.wrapApply);
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        receipt: { key: KEY, build: () => bytes('receipt') },
      });
      expect(recorder.batches).toHaveLength(1);
      const batch = recorder.batches[0]!;
      expect(batch.operations.map((operation) => operation.key)).toContain(KEY);
      expect(batch.conditions).toContainEqual({ key: KEY, expectedValue: null });
      expect(await storage.getReceipt(KEY)).toEqual(bytes('receipt'));
    });

    it('returns null for a receipt key nothing wrote', async () => {
      expect(await makeBackend().getReceipt(KEY)).toBeNull();
    });

    it('writes neither the commit nor the receipt when apply fails before applying', async () => {
      const fault = failFirstBatch('before');
      const storage = makeBackend(fault.wrapApply);
      const request = {
        tenantId: TENANT,
        evidence: [e1],
        receipt: { key: KEY, build: () => bytes('receipt') },
      };
      expect((await rejectionOf(storage.commit(request))) as Error).toBeInstanceOf(Error);
      expect(await storage.getEvidence(TENANT, 'e1')).toBeUndefined();
      expect(await storage.getReceipt(KEY)).toBeNull();
      // A retry commits both.
      await storage.commit(request);
      expect(await storage.getEvidence(TENANT, 'e1')).toEqual(e1);
      expect(await storage.getReceipt(KEY)).toEqual(bytes('receipt'));
    });

    it('writes both when apply applies and then throws', async () => {
      const fault = failFirstBatch('after');
      const storage = makeBackend(fault.wrapApply);
      await rejectionOf(
        storage.commit({
          tenantId: TENANT,
          evidence: [e1],
          receipt: { key: KEY, build: () => bytes('receipt') },
        }),
      );
      expect(await storage.getEvidence(TENANT, 'e1')).toEqual(e1);
      expect(await storage.getReceipt(KEY)).toEqual(bytes('receipt'));
    });

    it('refuses an existing receipt key with receipt-exists and applies nothing', async () => {
      const recorder = recordBatches();
      const storage = makeBackend(recorder.wrapApply);
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        receipt: { key: KEY, build: () => bytes('first') },
      });
      const error = await rejectionOf(
        storage.commit({
          tenantId: TENANT,
          evidence: [makeInlineEvidence('e2')],
          receipt: { key: KEY, build: () => bytes('second') },
        }),
      );
      expect(error).toBeInstanceOf(EvidenceProjectionCommitError);
      expect((error as EvidenceProjectionCommitError).code).toBe('receipt-exists');
      // It was refused while planning: no second batch was handed to apply, and no attempt burned.
      expect(recorder.batches).toHaveLength(1);
      expect(await storage.getEvidence(TENANT, 'e2')).toBeUndefined();
      expect(await storage.getReceipt(KEY)).toEqual(bytes('first'));
    });

    it('still writes the receipt when every record is a duplicate', async () => {
      const recorder = recordBatches();
      const storage = makeBackend(recorder.wrapApply);
      await storage.commit({ tenantId: TENANT, evidence: [e1] });
      const result = await storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        receipt: { key: KEY, build: () => bytes('receipt') },
      });
      expect(result.evidence).toEqual([{ id: 'e1', outcome: 'duplicate' }]);
      expect(recorder.batches).toHaveLength(2);
      expect(await storage.getReceipt(KEY)).toEqual(bytes('receipt'));
    });

    it('keeps the all-duplicate fast path when no receipt is attached', async () => {
      const recorder = recordBatches();
      const storage = makeBackend(recorder.wrapApply);
      await storage.commit({ tenantId: TENANT, evidence: [e1] });
      await storage.commit({ tenantId: TENANT, evidence: [e1] });
      expect(recorder.batches).toHaveLength(1);
    });

    it('refuses a commit that has only a receipt, and an empty key or value', async () => {
      const storage = makeBackend();
      for (const request of [
        { tenantId: TENANT, receipt: { key: KEY, build: () => bytes('r') } },
        { tenantId: TENANT, evidence: [e1], receipt: { key: '', build: () => bytes('r') } },
        { tenantId: TENANT, evidence: [e1], receipt: { key: KEY, build: () => new Uint8Array() } },
      ]) {
        const error = await rejectionOf(storage.commit(request));
        expect((error as EvidenceProjectionCommitError).code).toBe('invalid-commit');
      }
    });

    it('builds the receipt from the outcomes of the attempt that carries it, once per attempt', async () => {
      let storage: EvidenceProjectionStorage | undefined;
      let interposed = false;
      storage = makeBackend((apply) => async (batch) => {
        if (!interposed) {
          interposed = true;
          // Another writer appends the same record after this attempt was planned.
          await storage?.appendEvidence(e1);
        }
        return apply(batch);
      });
      const seen: string[][] = [];
      await storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        receipt: {
          key: KEY,
          build: (outcomes) => {
            seen.push(outcomes.evidence.map((entry) => `${entry.id}:${entry.outcome}`));
            return bytes(seen.at(-1)!.join());
          },
        },
      });
      expect(seen).toEqual([['e1:appended'], ['e1:duplicate']]);
      expect(await storage.getReceipt(KEY)).toEqual(bytes('e1:duplicate'));
    });

    it('refuses a receipt key that is also a record key in the same batch', async () => {
      const storage = makeBackend();
      const keys = createEvidenceProjectionKeys();
      for (const key of [
        keys.evidence(TENANT, 'e1'),
        keys.current(TENANT, NAMESPACE, 'p1'),
        keys.supersession(TENANT, 'e0'),
        keys.history(TENANT, NAMESPACE, 'p1', 1),
        `${keys.evidencePrefix}t:elsewhere:e:anything`,
      ]) {
        const error = await rejectionOf(
          storage.commit({
            tenantId: TENANT,
            evidence: [e1],
            projections: [makeFact('p1', [e1])],
            receipt: { key, build: () => bytes('receipt') },
          }),
        );
        expect((error as EvidenceProjectionCommitError).code).toBe('invalid-commit');
      }
      expect(await storage.getEvidence(TENANT, 'e1')).toBeUndefined();
    });

    it('counts the receipt toward the batch cap', async () => {
      const storage = makeBackend();
      // One put per evidence record plus the receipt: the receipt is the operation past the cap.
      const evidence = Array.from({ length: MAX_COMMIT_BATCH_OPERATIONS }, (_, index) =>
        makeInlineEvidence(`cap-${index}`),
      );
      const error = await rejectionOf(
        storage.commit({
          tenantId: TENANT,
          evidence,
          receipt: { key: KEY, build: () => bytes('receipt') },
        }),
      );
      expect(error).toBeInstanceOf(EvidenceProjectionBatchLimitError);
      expect(await storage.getReceipt(KEY)).toBeNull();
    });
  });
}

describe('commit receipt (in-memory bounds)', () => {
  it('does not count the receipt toward maxEvidence or maxProjectionRevisions', async () => {
    const storage = createInMemoryEvidenceProjectionStorage({
      maxEvidence: 1,
      maxProjectionRevisions: 1,
    });
    const projection = makeFact('p1', [e1]);
    await storage.commit({
      tenantId: TENANT,
      evidence: [e1],
      projections: [projection],
      receipt: { key: KEY, build: () => bytes('receipt') },
    });
    expect(await storage.getProjection(TENANT, NAMESPACE, 'p1')).toEqual(projection);
  });
});
