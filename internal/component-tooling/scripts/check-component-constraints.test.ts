import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { ConstraintsDocument } from '../../../components/core/src/_internal/constraints.ts';

import {
  checkComponentConstraints,
  checkConstraintsDocument,
  componentPropNames,
  findUnknownConstraintProps,
} from './check-component-constraints.ts';

const fixture: ConstraintsDocument & { $schema: string } = {
  $schema: '../../../../../internal/component-tooling/src/schemas/constraints.schema.json',
  component: 'button',
  summary: 'A fixture.',
  rules: [
    {
      id: 'needs-a-name',
      severity: 'error',
      description: 'Needs a name.',
      kind: 'anyOf',
      when: { prop: 'iconOnly', equals: true },
      of: [{ prop: 'label', nonEmpty: true }, { anyOf: [{ prop: 'labelText', exists: true }] }],
    },
  ],
};

describe('the constraints prop cross-check', () => {
  test('fails on a constraint that names a prop the component does not have', () => {
    const known = new Set(['iconOnly', 'label']);
    expect(findUnknownConstraintProps(fixture, known)).toEqual(['labelText']);
    expect(checkConstraintsDocument(fixture, 'button', known)).toEqual([
      'names "labelText", which is not a prop or snippet of button',
    ]);
  });

  test('passes once every named prop exists, reading nested and `when` predicates', () => {
    expect(
      checkConstraintsDocument(fixture, 'button', new Set(['iconOnly', 'label', 'labelText'])),
    ).toEqual([]);
  });

  test('knows the HTML attributes and snippets a props type takes', () => {
    const names = componentPropNames(
      join(import.meta.dir, '../../../components/core/src/components/button'),
      'button',
    );
    for (const name of ['label', 'iconOnly', 'children', 'leadingIcon', 'aria-label']) {
      expect(names.has(name)).toBe(true);
    }
  });

  test('passes on the tree', async () => {
    expect(await checkComponentConstraints()).toEqual([]);
  });
});
