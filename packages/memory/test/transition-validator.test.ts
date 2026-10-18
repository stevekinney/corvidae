import { describe, expect, it } from 'bun:test';

import { digestOfText } from '../src/evidence-schema';
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
  appendProposal,
  createHarness,
  expectCommitted,
  expectRefused,
  makeWriteAuthority,
  proposedEvidence,
  proposedFact,
  type TransitionHarness,
} from './transition-test-support';

/**
 * One proposal per validator check, each violating only that check, on both
 * backends. A refusal is `rejected` with the check's reason code, writes
 * nothing, leaves no receipt, and emits exactly requested, validation-started,
 * rejected.
 */

const authority = makeWriteAuthority();
const base = { operationId: 'operation-1', tenantId: TENANT, authority };
const e1 = makeInlineEvidence('e1');
const e2 = makeInlineEvidence('e2');
const ref = (evidence: typeof e1) => ({ id: evidence.id, digest: evidence.digest });

async function seeded(
  makeBackend: MakeBackend,
  options: { evidence?: (typeof e1)[]; projections?: ReturnType<typeof makeFact>[] } = {},
): Promise<TransitionHarness> {
  const harness = createHarness(makeBackend);
  const evidence = options.evidence ?? [e1, e2];
  await harness.storage.commit({
    tenantId: TENANT,
    evidence,
    projections: options.projections ?? [makeFact('p1', [e1])],
  });
  return harness;
}

async function expectRejected(
  harness: TransitionHarness,
  proposal: TransitionProposal,
  reason: TransitionRejectionReason,
  detailStartsWith?: string,
): Promise<void> {
  const result = expectRefused(await harness.engine.submit(proposal), 'rejected');
  expect(result.reason).toBe(reason);
  if (detailStartsWith !== undefined) expect(result.detail).toContain(detailStartsWith);
  expect(harness.recorder.kinds()).toEqual(['requested', 'validation-started', 'rejected']);
  expect(await harness.engine.getReceipt(TENANT, proposal.operationId)).toBeUndefined();
}

function createProposal(
  ...projections: Array<ReturnType<typeof proposedFact>>
): TransitionProposal {
  return { ...base, kind: 'create-projection', projections };
}

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`transition validator (${label})`, () => {
    it('check 1 refuses a proposal whose authority lacks the capability', async () => {
      const harness = await seeded(makeBackend);
      const readOnly = makeWriteAuthority({ capabilities: ['memory:search'] });
      await expectRejected(
        harness,
        appendProposal('operation-1', ['e3'], readOnly),
        'unauthorized',
        'missing-capability',
      );
      expect(await harness.storage.getEvidence(TENANT, 'e3')).toBeUndefined();
    });

    it('check 1 refuses an authority whose capabilities its delegation chain never granted', async () => {
      const harness = await seeded(makeBackend);
      const forged = {
        ...authority,
        delegationChain: [{ principal: authority.principal, capabilities: [] }],
      };
      await expectRejected(
        harness,
        { ...appendProposal('operation-1', ['e3']), authority: forged },
        'unauthorized',
        'exceeds its delegation chain',
      );
    });

    it("check 1 refuses a projection built on another owner's private evidence", async () => {
      const harness = await seeded(makeBackend);
      const stranger = makeWriteAuthority({ ownerId: 'owner-2' });
      await expectRejected(
        harness,
        { ...createProposal(proposedFact('p2', [ref(e1)])), authority: stranger },
        'unauthorized',
        'not-owner',
      );
    });

    it('check 1 passes a missing source on to coverage', async () => {
      const harness = await seeded(makeBackend);
      const stranger = makeWriteAuthority({ ownerId: 'owner-2' });
      await expectRejected(
        harness,
        {
          ...createProposal(proposedFact('p2', [{ id: 'ghost', digest: digestOfText('ghost') }])),
          authority: stranger,
        },
        'evidence-not-covered',
      );
    });

    it('check 2 refuses a source that names no stored or proposed evidence', async () => {
      const harness = await seeded(makeBackend);
      await expectRejected(
        harness,
        createProposal(proposedFact('p2', [{ id: 'ghost', digest: digestOfText('ghost') }])),
        'evidence-not-covered',
        'ghost',
      );
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'p2')).toBeUndefined();
    });

    it('check 2 accepts a source that is evidence in the same proposal', async () => {
      const harness = await seeded(makeBackend);
      const fresh = makeInlineEvidence('e9');
      const result = await harness.engine.submit({
        ...base,
        kind: 'correct-evidence',
        successor: proposedEvidence('e9', { supersedes: ['e2'] }),
        projections: [proposedFact('p9', [ref(fresh)])],
      });
      expectCommitted(result);
    });

    it('check 3 refuses a source whose digest is not its evidence digest', async () => {
      const harness = await seeded(makeBackend);
      await expectRejected(
        harness,
        createProposal(proposedFact('p2', [{ id: 'e1', digest: digestOfText('something else') }])),
        'source-digest-mismatch',
        'e1',
      );
    });

    it('check 4 refuses a retirement whose successor is not active afterwards', async () => {
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
              expectedRevision: 1,
              change: { kind: 'superseded', supersededBy: { id: 'ghost', revision: 1 } },
            },
          ],
        },
        'prior-state-not-preserved',
        'not active after the proposal',
      );
      const untouched = await harness.storage.getProjection(TENANT, NAMESPACE, 'p1');
      expect(untouched?.revision).toBe(1);
    });

    it('check 4 refuses a created projection that supersedes what the proposal does not', async () => {
      const harness = await seeded(makeBackend);
      await expectRejected(
        harness,
        createProposal({
          ...proposedFact('p2', [ref(e2)]),
          supersedes: [{ id: 'p1', revision: 1 }],
        }),
        'prior-state-not-preserved',
        'does not supersede',
      );
    });

    it('check 4 refuses a correction that supersedes evidence already superseded', async () => {
      const harness = await seeded(makeBackend);
      expectCommitted(
        await harness.engine.submit({
          ...base,
          operationId: 'operation-0',
          kind: 'correct-evidence',
          successor: proposedEvidence('e3', { supersedes: ['e2'] }),
        }),
      );
      harness.recorder.clear();
      await expectRejected(
        harness,
        {
          ...base,
          kind: 'correct-evidence',
          successor: proposedEvidence('e4', { supersedes: ['e2'] }),
        },
        'prior-state-not-preserved',
        'already superseded',
      );
    });

    it('check 4 refuses a correction that supersedes evidence nobody stored', async () => {
      const harness = await seeded(makeBackend);
      await expectRejected(
        harness,
        {
          ...base,
          kind: 'correct-evidence',
          successor: proposedEvidence('e3', { supersedes: ['ghost'] }),
        },
        'prior-state-not-preserved',
        'not stored',
      );
    });

    it('check 5 refuses a revision stamped before the revision it follows', async () => {
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
              expectedRevision: 1,
              change: { kind: 'revoked', reasonCode: 'withdrawn' },
            },
          ],
        },
        'temporal-inconsistency',
        'before the revision it follows',
      );
    });

    it('check 5 refuses a validity window that ends before it begins', async () => {
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
              expectedRevision: 1,
              change: { kind: 'revoked', reasonCode: 'withdrawn' },
              validity: { validUntil: FIXED_AT },
            },
          ],
        },
        'temporal-inconsistency',
        'not after it begins',
      );
    });

    it('check 5 refuses a successor valid from before the projection it supersedes', async () => {
      const harness = await seeded(makeBackend);
      await expectRejected(
        harness,
        {
          ...base,
          kind: 'correct-evidence',
          successor: proposedEvidence('e3', { supersedes: ['e2'] }),
          projections: [
            {
              ...proposedFact('p2', [ref(makeInlineEvidence('e3'))]),
              validity: { validFrom: FIXED_AT - 10 },
              supersedes: [{ id: 'p1', revision: 1 }],
            },
          ],
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p1',
              expectedRevision: 1,
              change: { kind: 'superseded', supersededBy: { id: 'p2', revision: 1 } },
            },
          ],
        },
        'temporal-inconsistency',
        'before the',
      );
    });

    it('check 6 refuses a projection built on evidence past its duration retention', async () => {
      const expiring = makeInlineEvidence('e5', {
        retention: { kind: 'duration', milliseconds: 1_000 },
      });
      const harness = await seeded(makeBackend, { evidence: [e1, expiring] });
      await expectRejected(
        harness,
        createProposal(proposedFact('p2', [ref(expiring)])),
        'retention-expired',
        'e5',
      );
    });

    it('check 6 checks only the duration rule', async () => {
      const lasting = makeInlineEvidence('e6', { retention: { kind: 'run-lifetime' } });
      const harness = await seeded(makeBackend, { evidence: [e1, lasting] });
      expectCommitted(
        await harness.engine.submit(createProposal(proposedFact('p2', [ref(lasting)]))),
      );
    });

    const invariants: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      [
        'fact.entities-distinct',
        { kind: 'fact', payload: { statement: 's', entities: ['Ana', 'Ana'] } },
      ],
      [
        'episode.recall-not-before-occurrence',
        {
          kind: 'episode',
          payload: { summary: 's', occurredFrom: CLOCK_AFTER },
        },
      ],
      [
        'procedure.steps-distinct',
        { kind: 'procedure', payload: { title: 'Brew', steps: ['Boil', 'Boil'] } },
      ],
      [
        'procedure.steps-distinct',
        { kind: 'procedure', payload: { title: 'Brew', steps: ['Brew'] } },
      ],
      [
        'preference.subject-differs',
        { kind: 'preference', payload: { subject: 'tea', statement: 'tea' } },
      ],
      [
        'summary.sources-cover',
        {
          kind: 'summary',
          payload: {
            text: 's',
            covers: [
              { id: 'p1', revision: 1 },
              { id: 'p1', revision: 1 },
            ],
          },
        },
      ],
      [
        'summary.sources-cover',
        { kind: 'summary', payload: { text: 's', covers: [{ id: 'p1', revision: 1 }] } },
      ],
      [
        'chunk.chain-ends-in-chunk',
        {
          kind: 'chunk',
          payload: {
            text: 'chunk text',
            ordinal: 0,
            startLine: 0,
            endLine: 1,
            steps: [
              {
                step: 'extract',
                producer: { kind: 'tool', id: 'extractor' },
                inputDigest: e1.digest,
                outputDigest: digestOfText('chunk text'),
              },
            ],
          },
        },
      ],
    ];
    it.each(invariants)('check 7 refuses a %s violation', async (name, overrides) => {
      const harness = await seeded(makeBackend);
      const sources = name === 'summary.sources-cover' ? [ref(e2)] : [ref(e1)];
      await expectRejected(
        harness,
        createProposal(proposedFact('p2', sources, overrides)),
        'type-invariant-violated',
        name,
      );
      expect(await harness.storage.getProjection(TENANT, NAMESPACE, 'p2')).toBeUndefined();
    });

    it('check 7 refuses two chunks of one evidence record that share an ordinal', async () => {
      const harness = await seeded(makeBackend);
      const chunk = (id: string) =>
        proposedFact(id, [ref(e1)], {
          kind: 'chunk',
          payload: {
            text: `text of ${id}`,
            ordinal: 0,
            startLine: 0,
            endLine: 1,
            steps: [
              {
                step: 'chunk',
                producer: { kind: 'tool', id: 'chunker' },
                inputDigest: e1.digest,
                outputDigest: digestOfText(`text of ${id}`),
              },
            ],
          },
        });
      await expectRejected(
        harness,
        createProposal(chunk('c1'), chunk('c2')),
        'type-invariant-violated',
        'chunk.ordinal-distinct',
      );
    });

    it('refuses a rebuilt payload that fits no payload of the stored kind as malformed', async () => {
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
              expectedRevision: 1,
              change: {
                kind: 'rebuilt',
                sources: [{ evidenceId: 'e1', digest: e1.digest }],
                payload: { title: 'not a fact', steps: ['x'] },
              },
            },
          ],
        },
        'malformed',
      );
    });

    it('rejects, rather than conflicts, a proposal that is both invalid and stale', async () => {
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
              change: {
                kind: 'rebuilt',
                sources: [{ evidenceId: 'ghost', digest: digestOfText('ghost') }],
                payload: { statement: 's', entities: [] },
              },
            },
          ],
        },
        'evidence-not-covered',
      );
    });

    it('stops at the first failing check, in order', async () => {
      const harness = await seeded(makeBackend);
      // Unauthorized and uncovered at once: authorization is check 1.
      await expectRejected(
        harness,
        {
          ...createProposal(proposedFact('p2', [{ id: 'ghost', digest: digestOfText('ghost') }])),
          authority: makeWriteAuthority({ capabilities: ['memory:search'] }),
        },
        'unauthorized',
      );
    });

    it('records the checks that ran, in order, on a committed receipt', async () => {
      const harness = await seeded(makeBackend);
      const { receipt } = expectCommitted(
        await harness.engine.submit(createProposal(proposedFact('p2', [ref(e1)]))),
      );
      expect(receipt.validation).toEqual({
        checks: [
          'authorization',
          'coverage',
          'faithfulness',
          'prior-state',
          'temporal',
          'retention',
          'type-invariants',
        ],
        policyRevision: 'authorization:1',
      });
    });
  });
}

const CLOCK_AFTER = FIXED_AT + 10_000_000;
