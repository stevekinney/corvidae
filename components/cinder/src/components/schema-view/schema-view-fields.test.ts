import { describe, expect, test } from 'bun:test';

import { readSchemaFields } from './schema-view-fields.ts';

describe('readSchemaFields', () => {
  test('reads properties in order with formatted labels, types, descriptions and required', () => {
    const fields = readSchemaFields({
      type: 'object',
      required: ['orderId'],
      properties: {
        orderId: { type: 'string', description: 'The order to refund.' },
        refundAmount: { type: 'number' },
        wrong_item: { type: 'boolean' },
      },
    });
    expect(fields.map((field) => field.label)).toEqual(['Order ID', 'Refund Amount', 'Wrong Item']);
    expect(fields.map((field) => field.type)).toEqual(['string', 'number', 'boolean']);
    expect(fields.map((field) => field.required)).toEqual([true, false, false]);
    expect(fields[0]?.description).toBe('The order to refund.');
    expect(fields[1]?.description).toBeUndefined();
  });

  test('nests the fields of an object and of the objects an array holds', () => {
    const fields = readSchemaFields({
      type: 'object',
      properties: {
        customer: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', format: 'email' } },
        },
        lines: {
          type: 'array',
          items: { type: 'object', properties: { sku: { type: 'string' } } },
        },
      },
    });
    expect(fields[0]?.fields[0]).toMatchObject({
      label: 'Email',
      type: 'string (email)',
      required: true,
    });
    expect(fields[1]?.type).toBe('array of object');
    expect(fields[1]?.fields[0]?.label).toBe('Sku');
  });

  test('follows local references and merges allOf members', () => {
    const fields = readSchemaFields({
      type: 'object',
      properties: {
        address: { $ref: '#/$defs/address' },
        contact: { allOf: [{ properties: { phone: { type: 'string' } }, required: ['phone'] }] },
      },
      $defs: {
        address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    });
    expect(fields[0]?.type).toBe('object');
    expect(fields[0]?.fields[0]).toMatchObject({ label: 'City', required: true });
    expect(fields[1]?.fields[0]).toMatchObject({ label: 'Phone', required: true });
  });

  test('describes enums, constants, unions and nullable types in one short string', () => {
    const fields = readSchemaFields({
      properties: {
        mode: { enum: ['fast', 'slow'] },
        many: { enum: ['a', 'b', 'c', 'd', 'e', 'f'] },
        kind: { const: 'refund' },
        note: { type: ['string', 'null'] },
        either: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        anything: {},
      },
    });
    expect(fields.map((field) => field.type)).toEqual([
      '"fast" | "slow"',
      '"a" | "b" | "c" | "d" | …',
      '"refund"',
      'string | null',
      'string | integer',
      'any',
    ]);
  });

  test('shows a self-reference as a recursive reference instead of expanding it again', () => {
    const fields = readSchemaFields({
      $ref: '#/$defs/node',
      $defs: {
        node: {
          type: 'object',
          properties: { name: { type: 'string' }, child: { $ref: '#/$defs/node' } },
        },
      },
    });
    expect(fields.map((field) => [field.key, field.type])).toEqual([
      ['name', 'string'],
      ['child', 'node (recursive)'],
    ]);
    expect(fields[1]?.fields).toEqual([]);
  });

  test('keeps a recursive filter-expression schema to a handful of fields', () => {
    const fields = readSchemaFields({
      type: 'object',
      properties: { filter: { $ref: '#/$defs/expression' } },
      $defs: {
        expression: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            and: { type: 'array', items: { $ref: '#/$defs/expression' } },
            or: { type: 'array', items: { $ref: '#/$defs/expression' } },
            not: { $ref: '#/$defs/expression' },
          },
        },
      },
    });
    const count = (entries: typeof fields): number =>
      entries.reduce((total, entry) => total + 1 + count(entry.fields), 0);
    expect(count(fields)).toBe(5);
    expect(fields[0]?.fields.map((field) => field.type)).toEqual([
      'string',
      'array of expression (recursive)',
      'array of expression (recursive)',
      'expression (recursive)',
    ]);
  });

  test('a reference to the document root is a recursive reference', () => {
    const fields = readSchemaFields({
      type: 'object',
      properties: { parent: { $ref: '#' }, name: { type: 'string' } },
    });
    expect(fields[0]).toMatchObject({ type: 'schema (recursive)', fields: [] });
  });

  test('stops expanding a wide, non-recursive fan-out once the field budget is spent', () => {
    const defs: Record<string, unknown> = {};
    for (let level = 0; level < 9; level += 1) {
      defs[`level${level}`] = {
        type: 'object',
        properties: Object.fromEntries(
          ['a', 'b', 'c', 'd'].map((key) => [key, { $ref: `#/$defs/level${level + 1}` }]),
        ),
      };
    }
    defs['level9'] = { type: 'object', properties: { leaf: { type: 'string' } } };
    const fields = readSchemaFields({ $ref: '#/$defs/level0', $defs: defs });
    const all: typeof fields = [];
    const collect = (entries: typeof fields) => {
      for (const entry of entries) {
        all.push(entry);
        collect(entry.fields);
      }
    };
    collect(fields);
    expect(all.length).toBeLessThan(600);
    expect(all.some((field) => field.truncated)).toBe(true);
  });

  test('describes a recursive array type without looping', () => {
    const fields = readSchemaFields({
      $defs: { nested: { type: 'array', items: { $ref: '#/$defs/nested' } } },
      properties: { tree: { $ref: '#/$defs/nested' } },
    });
    expect(fields[0]?.type).toBe('array of nested (recursive)');
  });

  test('does not call an array of non-recursive references recursive', () => {
    const fields = readSchemaFields({
      type: 'object',
      properties: {
        lines: { type: 'array', items: { $ref: '#/$defs/Line' } },
        optionalLines: { type: ['array', 'null'], items: { $ref: '#/$defs/Line' } },
        tree: { type: 'array', items: { $ref: '#/$defs/Node' } },
      },
      $defs: {
        Line: { type: 'object', properties: { sku: { type: 'string' } } },
        Node: {
          type: 'object',
          properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } },
        },
      },
    });
    const [lines, optionalLines, tree] = fields;
    expect(lines?.type).toBe('array of object');
    expect(lines?.fields.map((field) => field.key)).toEqual(['sku']);
    expect(optionalLines?.type).toBe('array of object | null');
    expect(optionalLines?.fields.map((field) => field.key)).toEqual(['sku']);
    expect(tree?.type).toBe('array of object');
    expect(tree?.fields[0]?.type).toBe('array of Node (recursive)');
  });

  test('merges the property schemas of allOf members that describe the same property', () => {
    const fields = readSchemaFields({
      allOf: [
        {
          type: 'object',
          properties: {
            customer: {
              type: 'object',
              required: ['email'],
              properties: { email: { type: 'string' } },
            },
          },
        },
        { properties: { customer: { properties: { name: { type: 'string' } } } } },
      ],
    });
    const customer = fields[0]?.fields ?? [];
    expect(customer.map((field) => field.key)).toEqual(['email', 'name']);
    expect(customer[0]?.required).toBe(true);
  });

  test('keeps referenced properties and required entries beside sibling keywords', () => {
    const fields = readSchemaFields({
      $ref: '#/$defs/base',
      properties: { extra: { type: 'number' } },
      required: ['extra'],
      $defs: {
        base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    });
    expect(fields.map((field) => [field.key, field.required])).toEqual([
      ['id', true],
      ['extra', true],
    ]);
  });

  test('a dangling reference and an inherited key name are treated as unresolved', () => {
    const fields = readSchemaFields({
      properties: {
        missing: { $ref: '#/$defs/nope' },
        proto: { $ref: '#/constructor' },
      },
    });
    expect(fields.map((field) => field.type)).toEqual(['any', 'any']);
  });

  test('a schema that is not an object with properties yields one Value line', () => {
    expect(readSchemaFields({ type: 'string', description: 'A name.' })).toMatchObject([
      { label: 'Value', type: 'string', description: 'A name.' },
    ]);
  });

  test('true, an empty schema and non-objects yield no fields', () => {
    expect(readSchemaFields(true)).toEqual([]);
    expect(readSchemaFields({})).toEqual([]);
    expect(readSchemaFields(null)).toEqual([]);
    expect(readSchemaFields('string')).toEqual([]);
  });
});
