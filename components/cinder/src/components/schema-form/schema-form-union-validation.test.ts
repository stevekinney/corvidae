import { describe, expect, test } from 'bun:test';

import { validateSchemaValue } from './schema-form-validation.ts';

/**
 * A value is valid for a union by JSON Schema's own rules: `anyOf` holds when at least one branch
 * does, `oneOf` when exactly one does, a type array when the value has one of the types, and a
 * missing property is not a `null` and not a `false`. SchemaForm checks the schema it was given,
 * never a rewrite of it, so a host's `anyOf` is not read as a `oneOf` and a `null` or `false`
 * alternative is not dropped.
 */
type Cell = readonly [value: unknown, valid: boolean] | undefined;

type UnionKind = {
  readonly name: string;
  readonly schema: Record<string, unknown>;
  /** A value that matches one alternative. */
  readonly one: Cell;
  /** A value that matches two alternatives at once, or `undefined` for a schema with no such value. */
  readonly both: Cell;
  readonly explicitNull: Cell;
  readonly explicitFalse: Cell;
};

const KINDS: readonly UnionKind[] = [
  {
    name: 'anyOf, a value can match both branches',
    schema: { anyOf: [{ type: 'number' }, { type: 'integer' }] },
    one: [1.5, true],
    both: [2, true],
    explicitNull: [null, false],
    explicitFalse: [false, false],
  },
  {
    name: 'oneOf, a value can match both branches',
    schema: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
    one: [1.5, true],
    both: [2, false],
    explicitNull: [null, false],
    explicitFalse: [false, false],
  },
  {
    name: 'nullable by a type array',
    schema: { type: ['integer', 'null'] },
    one: [2, true],
    both: undefined,
    explicitNull: [null, true],
    explicitFalse: [false, false],
  },
  {
    name: 'nullable by an anyOf with null',
    schema: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    one: [2, true],
    both: undefined,
    explicitNull: [null, true],
    explicitFalse: [false, false],
  },
  {
    name: 'false or an object, by an anyOf with a const false',
    schema: {
      anyOf: [
        { type: 'boolean', const: false },
        { type: 'object', properties: { count: { type: 'integer' } } },
      ],
    },
    one: [{ count: 1 }, true],
    both: undefined,
    explicitNull: [null, false],
    explicitFalse: [false, true],
  },
];

function objectWith(kind: UnionKind, required: boolean): Record<string, unknown> {
  return {
    type: 'object',
    properties: { x: kind.schema },
    ...(required ? { required: ['x'] } : {}),
  };
}

async function validityOf(kind: UnionKind, value: unknown, present: boolean, required = false) {
  const result = await validateSchemaValue(objectWith(kind, required), present ? { x: value } : {});
  return result.valid;
}

describe('SchemaForm validates the schema it is given', () => {
  for (const kind of KINDS) {
    describe(kind.name, () => {
      const columns = [
        ['a value matching one alternative', kind.one],
        ['a value matching both alternatives', kind.both],
        ['an explicit null', kind.explicitNull],
        ['an explicit false', kind.explicitFalse],
      ] as const;
      for (const [column, cell] of columns) {
        if (cell === undefined) continue;
        test(`${column} is ${cell[1] ? 'valid' : 'invalid'}`, async () => {
          expect(await validityOf(kind, cell[0], true)).toBe(cell[1]);
        });
      }

      test('a missing property is valid while it is optional, and not once it is required', async () => {
        expect(await validityOf(kind, undefined, false)).toBe(true);
        expect(await validityOf(kind, undefined, false, true)).toBe(false);
      });
    });
  }

  test('keeps a missing property, an explicit null and an explicit false apart', async () => {
    const nullable = KINDS.find((kind) => kind.name === 'nullable by an anyOf with null');
    const optionalOff = KINDS.find((kind) => kind.name.startsWith('false or an object'));
    if (nullable === undefined || optionalOff === undefined) throw new Error('missing a kind');
    // Required, a nullable accepts null and refuses a missing property; a `false` is neither.
    expect(await validityOf(nullable, null, true, true)).toBe(true);
    expect(await validityOf(nullable, undefined, false, true)).toBe(false);
    expect(await validityOf(nullable, false, true, true)).toBe(false);
    expect(await validityOf(optionalOff, false, true, true)).toBe(true);
    expect(await validityOf(optionalOff, null, true, true)).toBe(false);
    expect(await validityOf(optionalOff, undefined, false, true)).toBe(false);
  });
});
