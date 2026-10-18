import { describe, expect, it } from 'bun:test';

import {
  MemoryTransitionProposalError,
  parseTransitionProposal,
  TRANSITION_PROPOSAL_KINDS,
  transitionDigest,
  type TransitionProposal,
} from '../src/transition-proposal';
import { FIXED_AT, makeFact, makeInlineEvidence } from './evidence-projection-fixtures';
import {
  appendProposal,
  makeWriteAuthority,
  NAMESPACE,
  proposedEvidence,
  proposedFact,
  TENANT,
} from './transition-test-support';

const authority = makeWriteAuthority();
const e1 = makeInlineEvidence('e1');
const base = { operationId: 'operation-1', tenantId: TENANT, authority };

const PROPOSALS: Record<(typeof TRANSITION_PROPOSAL_KINDS)[number], TransitionProposal> = {
  'append-evidence': appendProposal('operation-1'),
  'correct-evidence': {
    ...base,
    kind: 'correct-evidence',
    successor: proposedEvidence('e2', { supersedes: ['e1'] }),
    projections: [proposedFact('p2', [{ id: 'e2', digest: makeInlineEvidence('e2').digest }])],
    revisions: [
      {
        namespace: NAMESPACE,
        id: 'p1',
        expectedRevision: 1,
        change: { kind: 'superseded', supersededBy: { id: 'p2', revision: 1 } },
      },
    ],
  },
  'create-projection': {
    ...base,
    kind: 'create-projection',
    projections: [proposedFact('p1', [{ id: 'e1', digest: e1.digest }])],
  },
  'revise-projection': {
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
  consolidate: {
    ...base,
    kind: 'consolidate',
    namespace: NAMESPACE,
    candidates: [
      { id: 'p1', revision: 1 },
      { id: 'p2', revision: 1 },
    ],
    outcome: 'supersede',
    summary: { id: 's1', text: 'A summary' },
    projectorRevision: 'consolidator:1',
    promptRevision: 'prompt:1',
  },
};

describe('transition proposal schema', () => {
  for (const kind of TRANSITION_PROPOSAL_KINDS) {
    it(`accepts a ${kind} proposal`, () => {
      expect(parseTransitionProposal(PROPOSALS[kind]).kind).toBe(kind);
    });
  }

  it('accepts a consolidation with fewer than two candidates, leaving the refusal to the validator', () => {
    const proposal = { ...PROPOSALS.consolidate, candidates: [] };
    expect(parseTransitionProposal(proposal).kind).toBe('consolidate');
  });

  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['an unknown kind', { ...base, kind: 'delete-everything' }],
    ['an unknown key', { ...PROPOSALS['append-evidence'], extra: true }],
    [
      'a stored `writtenAt` on proposed evidence',
      {
        ...PROPOSALS['append-evidence'],
        evidence: [{ ...proposedEvidence('e1'), writtenAt: FIXED_AT }],
      },
    ],
    [
      'a stored `revision` on a proposed projection',
      {
        ...PROPOSALS['create-projection'],
        projections: [{ ...proposedFact('p1', [{ id: 'e1', digest: e1.digest }]), revision: 1 }],
      },
    ],
    [
      'a `policyRevision` on a proposed projection',
      {
        ...PROPOSALS['create-projection'],
        projections: [
          { ...proposedFact('p1', [{ id: 'e1', digest: e1.digest }]), policyRevision: 'x' },
        ],
      },
    ],
    [
      'evidence that supersedes inside append-evidence',
      {
        ...PROPOSALS['append-evidence'],
        evidence: [proposedEvidence('e2', { supersedes: ['e1'] })],
      },
    ],
    [
      'a correction that supersedes nothing',
      {
        ...PROPOSALS['correct-evidence'],
        successor: proposedEvidence('e2'),
      },
    ],
    [
      'an authority of another tenant',
      {
        ...PROPOSALS['append-evidence'],
        authority: makeWriteAuthority({ tenantId: 'tenant-b' }),
      },
    ],
    [
      'a record of another tenant',
      {
        ...PROPOSALS['append-evidence'],
        evidence: [proposedEvidence('e1', { tenantId: 'tenant-b' })],
      },
    ],
    ['an evidence id named twice', appendProposal('operation-1', ['e1', 'e1'])],
    [
      'a projection named twice',
      {
        ...PROPOSALS['create-projection'],
        projections: [
          proposedFact('p1', [{ id: 'e1', digest: e1.digest }]),
          proposedFact('p1', [{ id: 'e1', digest: e1.digest }]),
        ],
      },
    ],
    [
      'an authority key the schema does not declare',
      {
        ...PROPOSALS['append-evidence'],
        authority: { ...authority, administrator: true },
      },
    ],
    ['an empty operation id', { ...PROPOSALS['append-evidence'], operationId: '' }],
    [
      'a rebuild without a payload',
      {
        ...PROPOSALS['revise-projection'],
        revisions: [
          {
            namespace: NAMESPACE,
            id: 'p1',
            expectedRevision: 1,
            change: { kind: 'rebuilt', sources: [{ evidenceId: 'e1', digest: e1.digest }] },
          },
        ],
      },
    ],
  ];

  it.each(malformed)('refuses %s with a typed error, not an outcome', (_label, proposal) => {
    expect(() => parseTransitionProposal(proposal)).toThrow(MemoryTransitionProposalError);
    try {
      parseTransitionProposal(proposal);
    } catch (error) {
      expect((error as MemoryTransitionProposalError).code).toBe('malformed');
    }
  });
});

describe('transition digest', () => {
  it('is stable for equal proposals and independent of key order', () => {
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(PROPOSALS['append-evidence']).toReversed())),
    ) as TransitionProposal;
    expect(transitionDigest(reordered)).toBe(transitionDigest(PROPOSALS['append-evidence']));
    expect(transitionDigest(PROPOSALS['append-evidence'])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('differs for every kind', () => {
    const digests = TRANSITION_PROPOSAL_KINDS.map((kind) => transitionDigest(PROPOSALS[kind]));
    expect(new Set(digests).size).toBe(TRANSITION_PROPOSAL_KINDS.length);
  });

  it('covers the operation id, the policy revision inside the authority, and caller-supplied times', () => {
    const original = transitionDigest(PROPOSALS['append-evidence']);
    expect(transitionDigest(appendProposal('operation-2'))).not.toBe(original);
    expect(
      transitionDigest(
        appendProposal(
          'operation-1',
          ['e1'],
          makeWriteAuthority({ policyRevision: 'authorization:2' }),
        ),
      ),
    ).not.toBe(original);
    const later: TransitionProposal = {
      ...PROPOSALS['append-evidence'],
      evidence: [proposedEvidence('e1', { eventAt: FIXED_AT + 5 })],
    } as TransitionProposal;
    expect(transitionDigest(later)).not.toBe(original);
  });

  it('keeps the order of arrays, because order is semantic', () => {
    const forwards = appendProposal('operation-1', ['e1', 'e2']);
    const backwards = appendProposal('operation-1', ['e2', 'e1']);
    expect(transitionDigest(forwards)).not.toBe(transitionDigest(backwards));
  });

  it('does not depend on the key order of a rebuilt payload', () => {
    const rebuilt = (payload: object): TransitionProposal => ({
      ...base,
      kind: 'revise-projection',
      revisions: [
        {
          namespace: NAMESPACE,
          id: 'p1',
          expectedRevision: 1,
          change: { kind: 'rebuilt', sources: [{ evidenceId: 'e1', digest: e1.digest }], payload },
        },
      ],
    });
    expect(transitionDigest(rebuilt({ statement: 's', entities: ['a'] }))).toBe(
      transitionDigest(rebuilt({ entities: ['a'], statement: 's' })),
    );
  });

  it('refuses to digest a malformed proposal', () => {
    expect(() => transitionDigest({ kind: 'append-evidence' })).toThrow(
      MemoryTransitionProposalError,
    );
  });

  it('does not see the fields the engine stamps from its clock', () => {
    // The stamped paths are absent from the proposal by construction, so the proposal that
    // carries them is refused instead of silently digested.
    const stored = makeFact('p1', [e1]);
    expect(() =>
      parseTransitionProposal({
        ...PROPOSALS['create-projection'],
        projections: [{ ...stored, validity: undefined }],
      }),
    ).toThrow(MemoryTransitionProposalError);
  });
});
