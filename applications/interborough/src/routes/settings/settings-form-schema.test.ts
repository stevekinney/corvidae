import { validateSchemaFormValue } from '@lostgradient/cinder';
import { describe, expect, test } from 'bun:test';

import { PUBLISHED_SCHEMA } from './settings-fixtures.test-support.ts';
import { formSchemaOf, numbersCommitted } from './settings-form-schema.ts';

describe('the schema a form is given', () => {
  test('is the published node, a union left a union, and the form is named by its key', () => {
    const node = PUBLISHED_SCHEMA.properties['retention.audit'];
    const schema = formSchemaOf('retention.audit', node);
    expect(schema['anyOf']).toEqual(node?.anyOf);
    expect(schema['oneOf']).toBeUndefined();
    expect(schema['title']).toBe('retention.audit');
  });

  test('leaves the description to the row, which draws it as Markdown', () => {
    const node = PUBLISHED_SCHEMA.properties['retention.receipts'];
    expect(node?.description).toBeString();
    expect(formSchemaOf('retention.receipts', node)['description']).toBeUndefined();
  });

  test('carries a duration’s unit as the Bureau wrote it on the field, and invents none by name', () => {
    for (const key of ['retention.receipts', 'retention.memory', 'retention.notifications']) {
      const schema = formSchemaOf(key, PUBLISHED_SCHEMA.properties[key]);
      const properties = schema['properties'] as Record<string, Record<string, unknown>>;
      expect(properties['olderThan']?.['unit'], key).toBe('milliseconds');
      expect(properties['olderThan']?.['format'], key).toBeUndefined();
    }
    const audit = formSchemaOf('retention.audit', PUBLISHED_SCHEMA.properties['retention.audit']);
    const window = (audit['anyOf'] as Record<string, unknown>[]).find(
      (branch) => branch['properties'] !== undefined,
    );
    const fields = (window?.['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    expect(fields['olderThan']?.['unit']).toBe('milliseconds');
    const history = formSchemaOf('engine.history', PUBLISHED_SCHEMA.properties['engine.history']);
    const counts = history['properties'] as Record<string, Record<string, unknown>>;
    expect(counts['maxEvents']?.['unit']).toBeUndefined();
    expect(counts['maxEvents']?.['format']).toBeUndefined();
  });

  test('keeps a union with null a union, so null stays a value it holds', () => {
    const schema = formSchemaOf(
      'engine.payloadSize',
      PUBLISHED_SCHEMA.properties['engine.payloadSize'],
    );
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['maxBytes']?.['anyOf']).toEqual([
      { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      { type: 'null' },
    ]);
  });

  test('keeps a union with false a union, so false stays a value it holds', () => {
    const node = {
      anyOf: [{ const: false }, { type: 'object', properties: { count: { type: 'integer' } } }],
      description: 'Options.',
    };
    const schema = formSchemaOf('x.options', node);
    expect(schema['anyOf']).toEqual(node.anyOf);
    expect(schema['type']).toBeUndefined();
  });

  test('keeps the keywords the page does not read', () => {
    const schema = formSchemaOf('x', {
      type: 'object',
      properties: { n: { type: 'number', minimum: 1 } },
      additionalProperties: false,
    });
    expect(schema['additionalProperties']).toBe(false);
  });

  test('passes a node that is not an object through as an empty schema', () => {
    expect(formSchemaOf('x', null)).toEqual({ title: 'x' });
  });
});

/**
 * What JSON Schema says of a value in a property: `anyOf` holds when at least one alternative does,
 * `oneOf` when exactly one does, and a missing property is neither `null` nor `false`. Every row is
 * checked through the schema a form is given and through the node it came from.
 *
 * What `main` said before the form was given the published schema: `formSchemaOf` read an `anyOf`
 * as a `oneOf` and left out a `null` or `false` alternative, so three cells were wrong there. An
 * `anyOf` value that matches both alternatives was invalid, an explicit `null` for the nullable
 * `anyOf` was invalid, and an explicit `false` for false-or-an-object was invalid. Every other
 * cell, and every cell of the node itself, was already right.
 */
type Cell = readonly [value: unknown, valid: boolean] | undefined;

const TABLE: readonly {
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly one: Cell;
  readonly both: Cell;
  readonly explicitNull: Cell;
  readonly explicitFalse: Cell;
}[] = [
  {
    name: 'anyOf whose alternatives can both match',
    schema: { anyOf: [{ type: 'number' }, { type: 'integer' }] },
    one: [1.5, true],
    both: [2, true],
    explicitNull: [null, false],
    explicitFalse: [false, false],
  },
  {
    name: 'oneOf whose alternatives can both match',
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
    name: 'false or an object',
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

async function validity(schema: Record<string, unknown>, value: Record<string, unknown>) {
  const result = await validateSchemaFormValue(schema, value);
  return result.valid;
}

describe('a setting is checked against the schema as it was published', () => {
  for (const row of TABLE) {
    const node = (required: boolean) => ({
      type: 'object',
      properties: { x: row.schema },
      ...(required ? { required: ['x'] } : {}),
    });
    describe(row.name, () => {
      const columns = [
        ['a value matching one alternative', row.one],
        ['a value matching both alternatives', row.both],
        ['an explicit null', row.explicitNull],
        ['an explicit false', row.explicitFalse],
      ] as const;
      for (const [column, cell] of columns) {
        if (cell === undefined) continue;
        const [value, valid] = cell;
        test(`${column} is ${valid ? 'valid' : 'invalid'}`, async () => {
          expect(await validity(node(false), { x: value })).toBe(valid);
          expect(await validity(formSchemaOf('x', node(false)), { x: value })).toBe(valid);
        });
      }

      test('a missing property is valid while it is optional, and invalid once required', async () => {
        expect(await validity(formSchemaOf('x', node(false)), {})).toBe(true);
        expect(await validity(formSchemaOf('x', node(true)), {})).toBe(false);
      });
    });
  }

  test('a nullable setting takes null, and a missing property is a different value', async () => {
    const node = PUBLISHED_SCHEMA.properties['engine.payloadSize'];
    const schema = formSchemaOf('engine.payloadSize', node);
    expect(await validity(schema, { maxBytes: null })).toBe(true);
    expect(await validity(schema, {})).toBe(true);
    expect(await validity(schema, { maxBytes: false })).toBe(false);
    const required = { ...schema, required: ['maxBytes'] };
    expect(await validity(required, { maxBytes: null })).toBe(true);
    expect(await validity(required, {})).toBe(false);
  });
});

describe('numbers that are still being typed', () => {
  test('are not committed, at any depth', () => {
    const schema = formSchemaOf('engine.history', PUBLISHED_SCHEMA.properties['engine.history']);
    expect(numbersCommitted(schema, { maxEvents: 12 })).toBe(true);
    expect(numbersCommitted(schema, { maxEvents: '12' })).toBe(false);
    expect(numbersCommitted(schema, {})).toBe(true);
    const nested = {
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'integer' } } },
    };
    expect(numbersCommitted(nested, { list: [1, '2'] })).toBe(false);
    expect(numbersCommitted(nested, { list: [1, 2], other: 'text' })).toBe(true);
  });

  test('are not committed inside a nullable field, and null is committed', () => {
    const node = PUBLISHED_SCHEMA.properties['engine.payloadSize'];
    expect(numbersCommitted(node, { maxBytes: '12' })).toBe(false);
    expect(numbersCommitted(node, { maxBytes: 12 })).toBe(true);
    expect(numbersCommitted(node, { maxBytes: null })).toBe(true);
    expect(numbersCommitted({ type: ['integer', 'null'] }, '12')).toBe(false);
    expect(numbersCommitted({ type: ['integer', 'null'] }, null)).toBe(true);
  });

  test('are read in the alternatives of an anyOf and of a oneOf alike', () => {
    for (const keyword of ['anyOf', 'oneOf']) {
      const choice = {
        [keyword]: [
          { type: 'string', const: 'forever' },
          { type: 'object', properties: { olderThan: { type: 'number' } } },
        ],
      };
      expect(numbersCommitted(choice, { olderThan: '12' }), keyword).toBe(false);
      expect(numbersCommitted(choice, { olderThan: 12 }), keyword).toBe(true);
      expect(numbersCommitted(choice, 'forever'), keyword).toBe(true);
    }
  });

  test('read the object alternative of a choice, as retention.events and its siblings are', () => {
    for (const key of [
      'retention.audit',
      'retention.events',
      'retention.tasks',
      'retention.checkpoints',
    ]) {
      const schema = formSchemaOf(key, PUBLISHED_SCHEMA.properties[key]);
      const object = (schema['anyOf'] as Record<string, unknown>[] | undefined)?.find(
        (branch) => branch['properties'] !== undefined,
      );
      const field = Object.keys((object?.['properties'] ?? schema['properties']) as object)[0];
      expect(field, key).toBeString();
      expect(numbersCommitted(schema, { [field as string]: '12' }), key).toBe(false);
      expect(numbersCommitted(schema, { [field as string]: 12 }), key).toBe(true);
      expect(numbersCommitted(schema, 'forever'), key).toBe(true);
    }
  });
});
