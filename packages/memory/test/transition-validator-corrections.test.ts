import { describe, expect, it } from 'bun:test';

import type { TransitionRejectionReason } from '../src/transition-outcome';
import type { TransitionProposal } from '../src/transition-proposal';
import {
  FIXED_AT,
  makeFact,
  makeInlineEvidence,
  NAMESPACE,
  TENANT,
} from './evidence-projection-fixtures';
import { TRANSITION_BACKENDS, type MakeBackend } from './transition-backends';
import {
  CLOCK_START,
  correctionProposal,
  createHarness,
  expectCommitted,
  expectRefused,
  makeWriteAuthority,
  proposedFact,
  type TransitionHarness,
} from './transition-test-support';

/**
 * Behavior the review rounds pinned down: every check runs even when the
 * proposal is also stale, both sides of a supersession name each other, the
 * duration boundary is exclusive of the instant, shared evidence refuses a
 * write, and the encodability net catches what the schema alone would.
 */

const authority = makeWriteAuthority();
const base = { operationId: 'operation-1', tenantId: TENANT, authority };
const e1 = makeInlineEvidence('e1');
const ref = (evidence: typeof e1) => ({ id: evidence.id, digest: evidence.digest });
const source = (evidence: typeof e1) => ({ evidenceId: evidence.id, digest: evidence.digest });

async function seeded(
  makeBackend: MakeBackend,
  evidence: (typeof e1)[] = [e1],
  projections: ReturnType<typeof makeFact>[] = [makeFact('p1', [e1])],
): Promise<TransitionHarness> {
  const harness = createHarness(makeBackend);
  await harness.storage.commit({ tenantId: TENANT, evidence, projections });
  return harness;
}

function rebuild(
  expectedRevision: number,
  sources: Array<{ evidenceId: string; digest: string }>,
  payload: object,
  extra: Record<string, unknown> = {},
): TransitionProposal {
  return {
    ...base,
    kind: 'revise-projection',
    revisions: [
      {
        namespace: NAMESPACE,
        id: 'p1',
        expectedRevision,
        change: { kind: 'rebuilt', sources, payload },
        ...extra,
      },
    ],
  };
}

async function expectRejected(
  harness: TransitionHarness,
  proposal: TransitionProposal,
  reason: TransitionRejectionReason,
  detailIncludes?: string,
): Promise<void> {
  const result = expectRefused(await harness.engine.submit(proposal), 'rejected');
  expect(result.reason).toBe(reason);
  if (detailIncludes !== undefined) expect(result.detail).toContain(detailIncludes);
  expect(await harness.engine.getReceipt(TENANT, proposal.operationId)).toBeUndefined();
}

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`an invalid proposal that is also stale (${label})`, () => {
    it('is rejected for check 4, prior state', async () => {
      const harness = await seeded(makeBackend);
      await expectRejected(
        harness,
        {
          ...base,
          kind: 'revise-projection',
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p1',
              expectedRevision: 7,
              change: { kind: 'superseded', supersededBy: { id: 'ghost', revision: 1 } },
            },
          ],
        },
        'prior-state-not-preserved',
      );
    });

    it('is rejected for check 5, temporal', async () => {
      const harness = await seeded(makeBackend);
      harness.clock.set(FIXED_AT - 1);
      await expectRejected(
        harness,
        {
          ...base,
          kind: 'revise-projection',
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p1',
              expectedRevision: 7,
              change: { kind: 'revoked', reasonCode: 'withdrawn' },
            },
          ],
        },
        'temporal-inconsistency',
      );
    });

    it('is rejected for check 6, retention', async () => {
      const expiring = makeInlineEvidence('e5', {
        retention: { kind: 'duration', milliseconds: 1_000 },
      });
      const harness = await seeded(makeBackend, [e1, expiring]);
      await expectRejected(
        harness,
        rebuild(7, [source(expiring)], { statement: 's', entities: [] }),
        'retention-expired',
      );
    });

    it('is rejected for check 7, type invariants', async () => {
      const harness = await seeded(makeBackend);
      await expectRejected(
        harness,
        rebuild(7, [source(e1)], { statement: 's', entities: ['Ana', 'Ana'] }),
        'type-invariant-violated',
        'fact.entities-distinct',
      );
    });

    it('is rejected for a consolidation whose stale candidate leaves an incompatible embedding', async () => {
      const e2 = makeInlineEvidence('e2');
      const e3 = makeInlineEvidence('e3');
      const embedded = (id: string, evidence: typeof e1, vector: number[]) =>
        makeFact(id, [evidence], { embedding: { model: 'm', vector } });
      const harness = await seeded(
        makeBackend,
        [e1, e2, e3],
        [
          embedded('g1', e1, [1, 0, 0]),
          embedded('g2', e2, [0, 1, 0]),
          embedded('g3', e3, [0, 0, 1]),
        ],
      );
      await expectRejected(
        harness,
        {
          ...base,
          kind: 'consolidate',
          namespace: NAMESPACE,
          candidates: [
            { id: 'g1', revision: 7 },
            { id: 'g2', revision: 1 },
          ],
          outcome: 'supersede',
          summary: { id: 's1', text: 'Summary', embedding: { model: 'm', vector: [1, 0] } },
          projectorRevision: 'consolidator:1',
          promptRevision: 'prompt:1',
        },
        'type-invariant-violated',
        'embedding.fits-namespace',
      );
    });

    it('is conflicted once it is valid', async () => {
      const harness = await seeded(makeBackend);
      const result = expectRefused(
        await harness.engine.submit(rebuild(7, [source(e1)], { statement: 's', entities: [] })),
        'conflicted',
      );
      expect(result.reason).toBe('stale-revision');
    });
  });

  describe(`both sides of a supersession name each other (${label})`, () => {
    it('refuses a retirement that names a different successor than the projection that supersedes it', async () => {
      const harness = await seeded(
        makeBackend,
        [e1],
        [
          makeFact('p1', [e1]),
          makeFact('p3', [e1], { payload: { statement: 'Another.', entities: [] } }),
        ],
      );
      const proposal = correctionProposal('operation-1');
      await expectRejected(
        harness,
        {
          ...proposal,
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p1',
              expectedRevision: 1,
              change: { kind: 'superseded', supersededBy: { id: 'p3', revision: 1 } },
            },
          ],
        },
        'prior-state-not-preserved',
        'p1',
      );
      const untouched = await harness.storage.getProjection(TENANT, NAMESPACE, 'p1');
      expect(untouched?.revision).toBe(1);
    });

    it('refuses a created successor that does not list the revision retired into it', async () => {
      const harness = await seeded(makeBackend);
      const proposal = correctionProposal('operation-1');
      await expectRejected(
        harness,
        { ...proposal, projections: [proposedFact('p2', [ref(makeInlineEvidence('e2'))])] },
        'prior-state-not-preserved',
        'does not list',
      );
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'p2')).toBeUndefined();
      expect(await harness.storage.getEvidence(TENANT, 'e2')).toBeUndefined();
    });

    it('refuses a created successor that lists a revision the proposal does not retire into it', async () => {
      const harness = await seeded(
        makeBackend,
        [e1],
        [
          makeFact('p1', [e1]),
          makeFact('p4', [e1], { payload: { statement: 'Bystander.', entities: [] } }),
        ],
      );
      const proposal = correctionProposal('operation-1');
      const [p2] = proposal.projections ?? [];
      await expectRejected(
        harness,
        {
          ...proposal,
          projections: [
            {
              ...p2!,
              supersedes: [
                { id: 'p1', revision: 1 },
                { id: 'p4', revision: 1 },
              ],
            },
          ],
        },
        'prior-state-not-preserved',
        'p4',
      );
      const bystander = await harness.storage.getProjection(TENANT, NAMESPACE, 'p4');
      expect(bystander?.revision).toBe(1);
    });

    it('accepts the correction when both sides agree', async () => {
      const harness = await seeded(makeBackend);
      expectCommitted(await harness.engine.submit(correctionProposal('operation-1')));
    });
  });

  describe(`temporal windows (${label})`, () => {
    it('refuses a created projection that ends before the clock as temporal-inconsistency, like a revision', async () => {
      const harness = await seeded(makeBackend);
      await expectRejected(
        harness,
        {
          ...base,
          kind: 'create-projection',
          projections: [{ ...proposedFact('p2', [ref(e1)]), validity: { validUntil: FIXED_AT } }],
        },
        'temporal-inconsistency',
        'not after it begins',
      );
    });
  });

  describe(`the encodability net (${label})`, () => {
    it('refuses as malformed, before any batch, a record the schema rejects but the checks did not name', async () => {
      let reachedBatch = false;
      const harness = createHarness(makeBackend, {
        hooks: {
          beforeBatch: () => {
            reachedBatch = true;
          },
        },
      });
      await harness.storage.commit({
        tenantId: TENANT,
        evidence: [e1],
        projections: [makeFact('p1', [e1])],
      });
      // Two sources naming one evidence record: covered and faithful, but not distinct.
      await expectRejected(
        harness,
        rebuild(1, [source(e1), source(e1)], { statement: 's', entities: [] }),
        'malformed',
      );
      expect(reachedBatch).toBe(false);
    });
  });

  describe(`the duration retention boundary (${label})`, () => {
    const expiring = makeInlineEvidence('e5', {
      retention: { kind: 'duration', milliseconds: 1_000 },
    });

    it('is expired exactly when writtenAt plus the duration equals the instant', async () => {
      const harness = await seeded(makeBackend, [e1, expiring]);
      harness.clock.set(expiring.writtenAt + 1_000);
      await expectRejected(
        harness,
        { ...base, kind: 'create-projection', projections: [proposedFact('p2', [ref(expiring)])] },
        'retention-expired',
      );
    });

    it('is not expired one instant before', async () => {
      const harness = await seeded(makeBackend, [e1, expiring]);
      harness.clock.set(expiring.writtenAt + 999);
      expectCommitted(
        await harness.engine.submit({
          ...base,
          kind: 'create-projection',
          projections: [proposedFact('p2', [ref(expiring)])],
        }),
      );
    });
  });

  describe(`shared evidence (${label})`, () => {
    const shared = makeInlineEvidence('es', {
      authorizationScope: { visibility: 'shared', sharedWith: [] },
    });
    const sharedFact = () => makeFact('ps', [shared]);

    it('refuses every write-class transition on a projection that rests on it', async () => {
      const harness = await seeded(makeBackend, [shared], [sharedFact()]);
      const changes = [
        { kind: 'demoted', demotedBy: { id: 'ps', revision: 1 } },
        { kind: 'rebuilt', sources: [source(shared)], payload: { statement: 's', entities: [] } },
      ] as const;
      for (const change of changes) {
        const result = expectRefused(
          await harness.engine.submit({
            ...base,
            kind: 'revise-projection',
            revisions: [{ namespace: NAMESPACE, id: 'ps', expectedRevision: 1, change }],
          } as TransitionProposal),
          'rejected',
        );
        expect(result.reason).toBe('unauthorized');
        expect(result.detail).toContain('shared-write-requires-promotion');
      }
      await expectRejected(
        harness,
        { ...base, kind: 'create-projection', projections: [proposedFact('p2', [ref(shared)])] },
        'unauthorized',
        'shared-write-requires-promotion',
      );
    });

    it('lets the owner revoke it, because revocation is the control operation, not a write', async () => {
      const harness = await seeded(makeBackend, [shared], [sharedFact()]);
      expectCommitted(
        await harness.engine.submit({
          ...base,
          kind: 'revise-projection',
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'ps',
              expectedRevision: 1,
              change: { kind: 'revoked', reasonCode: 'withdrawn' },
            },
          ],
        }),
      );
    });
  });

  describe(`a successful rebuild (${label})`, () => {
    it('stamps the revision from the clock and keeps what a rebuild does not change', async () => {
      const harness = await seeded(makeBackend);
      const { receipt } = expectCommitted(
        await harness.engine.submit(
          rebuild(1, [source(e1)], { statement: 'Rebuilt.', entities: [] }),
        ),
      );
      const after = await harness.storage.getProjection(TENANT, NAMESPACE, 'p1');
      expect(after).toMatchObject({
        revision: 2,
        status: 'active',
        policyRevision: 'authorization:1',
        transition: { kind: 'rebuilt', at: CLOCK_START, rebuiltFromRevision: 1 },
        payload: { statement: 'Rebuilt.', entities: [] },
      });
      expect(receipt.projections).toMatchObject([
        { id: 'p1', revision: 2, transition: 'rebuilt', outcome: 'written' },
      ]);
    });
  });
}
