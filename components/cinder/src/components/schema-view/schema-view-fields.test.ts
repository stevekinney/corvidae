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

  test('stops a self-referencing schema at the depth cap instead of looping', () => {
    const schema = {
      $ref: '#/$defs/node',
      $defs: {
        node: {
          type: 'object',
          properties: { name: { type: 'string' }, child: { $ref: '#/$defs/node' } },
        },
      },
    };
    const fields = readSchemaFields(schema, 3);
    let depth = 0;
    let current = fields.find((field) => field.key === 'child');
    while (current) {
      depth += 1;
      const next: (typeof fields)[number] | undefined = current.fields.find(
        (f) => f.key === 'child',
      );
      if (!next) {
        expect(current.truncated).toBe(true);
      }
      current = next;
    }
    // The top-level field plus three expanded levels beneath it; the fourth is cut.
    expect(depth).toBe(4);
  });

  test('describes a recursive array type without looping', () => {
    const fields = readSchemaFields({
      $defs: { nested: { type: 'array', items: { $ref: '#/$defs/nested' } } },
      properties: { tree: { $ref: '#/$defs/nested' } },
    });
    expect(fields[0]?.type.startsWith('array of array')).toBe(true);
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
