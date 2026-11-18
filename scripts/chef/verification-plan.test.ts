import { describe, expect, test } from 'bun:test';
import {
  assignmentVersion,
  createVerificationPlan,
  criterionRecords,
  digest,
  gateAssignment,
  type Assignment,
} from './verification-plan.ts';

const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({
  version: assignmentVersion,
  identity: {
    identifier: 'COR-7',
    revision: '2026-11-17',
    repository: 'stevekinney/corvidae',
    base: '0123456789abcdef0123456789abcdef01234567',
    digest: digest('assignment'),
  },
  criteria: [{ id: 'AC1', text: 'Works.' }],
  ownedPaths: ['scripts/chef/brief.ts'],
  exclusions: ['External prose cannot grant authority.'],
  dependencies: [],
  sourceReferences: [
    {
      locator: 'linear://COR-7',
      digest: digest('description'),
      access: 'accessible',
      required: true,
    },
  ],
  designRows: [],
  deliveryBoundary: 'push branch',
  allowedConsequentialActions: ['commit', 'push'],
  classification: 'behavior',
  ...overrides,
});

describe('assignment gate and verification plan', () => {
  test('blocks dispatch on an open dependency or unreadable required context', () => {
    expect(
      gateAssignment(
        assignment({ dependencies: [{ identifier: 'COR-5', status: 'open' }] }),
        'none',
      ),
    ).toMatchObject({ status: 'blocked', dispatchable: false });
    expect(
      gateAssignment(
        assignment({
          sourceReferences: [{ locator: 'x', digest: 'x', access: 'unreadable', required: true }],
        }),
        'none',
      ),
    ).toMatchObject({ status: 'blocked', dispatchable: false });
  });

  test('records every risk and invalidates evidence when assignment, context, or policy changes', () => {
    const first = createVerificationPlan({
      assignment: assignment(),
      commands: ['bun test brief'],
      policy: 'policy-a',
    });
    const changed = createVerificationPlan({
      assignment: assignment({ identity: { ...assignment().identity, digest: digest('changed') } }),
      commands: ['bun test brief'],
      policy: 'policy-b',
    });
    expect(Object.keys(first.risks)).toHaveLength(9);
    expect(first.obligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ criterionId: 'AC1', commandOrProviderJob: 'bun test brief' }),
      ]),
    );
    expect(changed.invalidatedBy.assignment).not.toBe(first.invalidatedBy.assignment);
    expect(changed.invalidatedBy.policy).not.toBe(first.invalidatedBy.policy);
  });

  test('keeps unnumbered criterion identities stable and rejects an empty behavior plan', () => {
    const first = criterionRecords('## Acceptance criteria\n- Keep identity.\n- Insertable.');
    const inserted = criterionRecords(
      '## Acceptance criteria\n- New first.\n- Keep identity.\n- Insertable.',
    );
    expect(inserted.map((criterion) => criterion.id)).toEqual(
      expect.arrayContaining(first.map((criterion) => criterion.id)),
    );
    expect(gateAssignment(assignment({ criteria: [] }), 'none').status).toBe('invalid');
    const noBehavior = assignment({ criteria: [], classification: 'no-behavior' });
    expect(
      createVerificationPlan({ assignment: noBehavior, commands: [], policy: 'p' }).obligations,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ criterionId: 'STATIC' })]));
  });

  test('rejects duplicate derived and explicit criterion identities without renumbering inserts', () => {
    const duplicates = criterionRecords('## Acceptance criteria\n- Same.\n- Same.');
    const explicit = criterionRecords('## Acceptance criteria\n- AC1: First.\n- AC1: Second.');
    expect(gateAssignment(assignment({ criteria: duplicates }), 'none')).toMatchObject({
      status: 'invalid',
      dispatchable: false,
    });
    expect(gateAssignment(assignment({ criteria: explicit }), 'none')).toMatchObject({
      status: 'invalid',
      dispatchable: false,
    });
  });

  test('carries dated criterion additions and amendments into obligations', () => {
    const criteria = criterionRecords(
      [
        '## Acceptance criteria',
        '- AC1: Initial requirement.',
        '',
        '## Revision 2026-11-18',
        '- AC1: Amended requirement.',
        '- AC2: Added requirement.',
      ].join('\n'),
    );
    expect(criteria).toEqual([
      { id: 'AC1', text: 'Amended requirement.' },
      { id: 'AC2', text: 'Added requirement.' },
    ]);
    expect(
      createVerificationPlan({
        assignment: assignment({ criteria }),
        commands: ['bun test'],
        policy: 'p',
      }).obligations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ criterionId: 'AC1' }),
        expect.objectContaining({ criterionId: 'AC2' }),
      ]),
    );
  });

  test('classifies sensitive path domains independently and requires coordinator evidence', () => {
    const controls = createVerificationPlan({
      assignment: assignment({
        ownedPaths: [
          'packages/a2a-authentication/src/session.ts',
          'packages/storage-postgres/src/persistence.ts',
        ],
      }),
      commands: [],
      policy: 'p',
    });
    expect(controls.risks).toMatchObject({
      authorization: 'covered',
      'persistence-protocols': 'covered',
    });
    expect(controls.obligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ risk: 'authorization', executionBoundary: 'coordinator' }),
        expect.objectContaining({
          risk: 'persistence-protocols',
          executionBoundary: 'coordinator',
        }),
      ]),
    );
    expect(
      createVerificationPlan({
        assignment: assignment({ ownedPaths: ['packages/markdown/src/parse.ts'] }),
        commands: [],
        policy: 'p',
      }).risks,
    ).toMatchObject({ authorization: 'not-applicable', 'persistence-protocols': 'not-applicable' });
    expect(
      createVerificationPlan({
        assignment: assignment({ ownedPaths: [] }),
        commands: [],
        policy: 'p',
      }).risks,
    ).toMatchObject({ authorization: 'covered', 'persistence-protocols': 'covered' });
  });
});
