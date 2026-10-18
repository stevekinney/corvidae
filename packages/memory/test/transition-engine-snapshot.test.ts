import { describe, expect, it } from 'bun:test';

import { RAW_READS } from '../src/evidence-projection-storage';
import { transitionDigest } from '../src/transition-proposal';
import { makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  createHarness,
  expectCommitted,
  makeWriteAuthority,
  NAMESPACE,
  TENANT,
} from './transition-test-support';

/**
 * A proposal is read once, at entry. A caller that keeps a reference to a
 * payload and changes it while the submission awaits storage must change
 * neither what is written nor the digest the receipt records.
 */

const e1 = makeInlineEvidence('e1');

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`the proposal snapshot (${label})`, () => {
    it('writes the payload as it was at entry, not as the caller changes it mid-flight', async () => {
      const inner = createHarness(makeBackend);
      await inner.storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        projections: [makeFact('p1', [e1])],
      });
      const payload = { statement: 'Original rebuilt.', entities: ['Ana'] };
      const proposal = {
        kind: 'revise-projection' as const,
        operationId: 'rebuild-1',
        tenantId: TENANT,
        authority: makeWriteAuthority(),
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'p1',
            expectedRevision: 1,
            change: {
              kind: 'rebuilt' as const,
              sources: [{ evidenceId: 'e1', digest: e1.digest }],
              payload,
            },
          },
        ],
      };
      const original = structuredClone(proposal);

      // The caller edits the payload while the engine awaits a storage read.
      const raw = inner.storage[RAW_READS];
      const storage = {
        ...inner.storage,
        [RAW_READS]: {
          ...raw,
          projection: async (...args: Parameters<typeof raw.projection>) => {
            payload.statement = 'Mutated mid-flight.';
            payload.entities.push('Mallory');
            return raw.projection(...args);
          },
        },
      };
      const harness = createHarness(makeBackend, {
        storage,
        clock: inner.clock,
        recorder: inner.recorder,
      });

      const { receipt } = expectCommitted(await harness.engine.submit(proposal));

      const stored = await inner.storage.getProjection(TENANT, NAMESPACE, 'p1');
      expect(stored?.payload).toEqual({ statement: 'Original rebuilt.', entities: ['Ana'] });
      expect(receipt.digest).toBe(transitionDigest(original));
    });
  });
}
