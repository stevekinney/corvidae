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
    repository: 'corvidae',
    base: 'base',
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
});
