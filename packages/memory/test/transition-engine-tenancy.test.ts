import { describe, expect, it } from 'bun:test';

import type { TransitionProposal } from '../src/transition-proposal';
import { createTransitionKeys } from '../src/transition-receipt';
import { makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  appendProposal,
  createHarness,
  expectCommitted,
  expectRefused,
  makeWriteAuthority,
  NAMESPACE,
  OWNER,
  proposedEvidence,
  seedCorrectionState,
  TENANT,
} from './transition-test-support';

/**
 * Black-box fixtures with two principals and two tenants. They go through the
 * public engine only, over both backends.
 */

const OTHER_TENANT = 'tenant-b';
const intruder = makeWriteAuthority({ ownerId: 'owner-2', principalId: 'user-2' });

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`two principals (${label})`, () => {
    it("cannot revise another principal's private projection", async () => {
      const harness = createHarness(makeBackend);
      await seedCorrectionState(harness.storage);
      const result = expectRefused(
        await harness.engine.submit({
          kind: 'revise-projection',
          operationId: 'operation-1',
          tenantId: TENANT,
          authority: intruder,
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p1',
              expectedRevision: 1,
              change: { kind: 'revoked', reasonCode: 'mine now' },
            },
          ],
        }),
        'rejected',
      );
      expect(result.reason).toBe('unauthorized');
      const untouched = await harness.storage.getProjection(TENANT, NAMESPACE, 'p1');
      expect(untouched?.revision).toBe(1);
    });

    it("cannot supersede another principal's private projection by retiring it for its own", async () => {
      const harness = createHarness(makeBackend);
      await seedCorrectionState(harness.storage);
      const result = expectRefused(
        await harness.engine.submit({
          kind: 'revise-projection',
          operationId: 'operation-1',
          tenantId: TENANT,
          authority: intruder,
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p1',
              expectedRevision: 1,
              change: { kind: 'superseded', supersededBy: { id: 'p1', revision: 1 } },
            },
          ],
        }),
        'rejected',
      );
      expect(result.reason).toBe('unauthorized');
      const untouched = await harness.storage.getProjection(TENANT, NAMESPACE, 'p1');
      expect(untouched?.status).toBe('active');
    });

    it("cannot supersede another principal's private evidence, even with evidence of its own", async () => {
      const harness = createHarness(makeBackend);
      await seedCorrectionState(harness.storage);
      const result = expectRefused(
        await harness.engine.submit({
          kind: 'correct-evidence',
          operationId: 'operation-1',
          tenantId: TENANT,
          authority: intruder,
          successor: proposedEvidence('e2', { ownerId: 'owner-2', supersedes: ['e1'] }),
        }),
        'rejected',
      );
      expect(result.reason).toBe('unauthorized');
      expect(result.detail).toContain('e1');
      expect(await harness.storage.getEvidenceSupersession(TENANT, 'e1')).toBeUndefined();
      expect(await harness.storage.getEvidence(TENANT, 'e2')).toBeUndefined();
    });

    it('cannot write evidence on behalf of another owner it holds no authority for', async () => {
      const harness = createHarness(makeBackend);
      const result = expectRefused(
        await harness.engine.submit(
          appendProposal('operation-1', ['e5'], makeWriteAuthority({ ownerId: 'owner-2' })),
        ),
        'rejected',
      );
      expect(result.reason).toBe('unauthorized');
      expect(result.detail).toContain('not-owner');
    });

    it('lets the owner do the same thing', async () => {
      const harness = createHarness(makeBackend);
      await seedCorrectionState(harness.storage);
      expectCommitted(
        await harness.engine.submit({
          kind: 'correct-evidence',
          operationId: 'operation-1',
          tenantId: TENANT,
          authority: makeWriteAuthority({ ownerId: OWNER }),
          successor: proposedEvidence('e2', { supersedes: ['e1'] }),
        }),
      );
    });
  });

  describe(`two tenants (${label})`, () => {
    it("does not return tenant B's receipt for tenant A's id", async () => {
      const harness = createHarness(makeBackend);
      const authorityB = makeWriteAuthority({ tenantId: OTHER_TENANT });
      expectCommitted(
        await harness.engine.submit({
          ...appendProposal('operation-1', ['e1'], authorityB),
          evidence: [proposedEvidence('e1', { tenantId: OTHER_TENANT })],
        }),
      );
      expect(await harness.engine.getReceipt(OTHER_TENANT, 'operation-1')).toBeDefined();
      expect(await harness.engine.getReceipt(TENANT, 'operation-1')).toBeUndefined();
      const foreignKey = createTransitionKeys().receipt(TENANT, 'operation-1');
      expect(await harness.storage.getReceipt(foreignKey)).toBeNull();
    });

    it('keeps an operation id reused across tenants independent in each', async () => {
      const harness = createHarness(makeBackend);
      const authorityB = makeWriteAuthority({ tenantId: OTHER_TENANT });
      const forA = appendProposal('operation-1', ['e1']);
      const forB: TransitionProposal = {
        ...appendProposal('operation-1', ['e1'], authorityB),
        evidence: [proposedEvidence('e1', { tenantId: OTHER_TENANT, text: 'Another tenant.' })],
      };
      const a = expectCommitted(await harness.engine.submit(forA));
      const b = expectCommitted(await harness.engine.submit(forB));
      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(false);
      expect(a.receipt.digest).not.toBe(b.receipt.digest);
      expect(a.receipt.tenantId).toBe(TENANT);
      expect(b.receipt.tenantId).toBe(OTHER_TENANT);

      // Each tenant's id replays its own receipt, and neither collides with the other.
      expect(expectCommitted(await harness.engine.submit(forA)).receipt).toEqual(a.receipt);
      expect(expectCommitted(await harness.engine.submit(forB)).receipt).toEqual(b.receipt);
      expect(await harness.engine.getReceipt(TENANT, 'operation-1')).toEqual(a.receipt);
      expect(await harness.engine.getReceipt(OTHER_TENANT, 'operation-1')).toEqual(b.receipt);
    });

    it("cannot revise another tenant's projection by naming its id", async () => {
      const harness = createHarness(makeBackend);
      await seedCorrectionState(harness.storage);
      const authorityB = makeWriteAuthority({ tenantId: OTHER_TENANT });
      const result = expectRefused(
        await harness.engine.submit({
          kind: 'revise-projection',
          operationId: 'operation-1',
          tenantId: OTHER_TENANT,
          authority: authorityB,
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p1',
              expectedRevision: 1,
              change: { kind: 'revoked', reasonCode: 'cross-tenant' },
            },
          ],
        }),
        'conflicted',
      );
      expect(result.reason).toBe('stale-revision');
      const untouched = await harness.storage.getProjection(TENANT, NAMESPACE, 'p1');
      expect(untouched?.revision).toBe(1);
    });

    it('does not let a projection rest on evidence of another tenant', async () => {
      const harness = createHarness(makeBackend);
      await harness.storage.commit({
        tenantId: TENANT,
        evidence: [makeInlineEvidence('e1')],
        projections: [makeFact('p1', [makeInlineEvidence('e1')])],
      });
      const authorityB = makeWriteAuthority({ tenantId: OTHER_TENANT });
      const stolen = makeFact('p9', [makeInlineEvidence('e1')]);
      const { sources, payload, confidence, projectorRevision } = stolen;
      const result = expectRefused(
        await harness.engine.submit({
          kind: 'create-projection',
          operationId: 'operation-1',
          tenantId: OTHER_TENANT,
          authority: authorityB,
          projections: [
            {
              id: 'p9',
              tenantId: OTHER_TENANT,
              namespace: NAMESPACE,
              kind: 'fact',
              projectorRevision,
              sources,
              confidence,
              payload: payload as { statement: string; entities: string[] },
            },
          ],
        }),
        'rejected',
      );
      expect(result.reason).toBe('evidence-not-covered');
    });
  });
}
