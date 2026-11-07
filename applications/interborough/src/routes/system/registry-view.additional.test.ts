import { describe, expect, test } from 'bun:test';

import { extractSchemaFields, schemaTypeLabel } from './registry-view.ts';

describe('extractSchemaFields', () => {
  test('returns [] for an undefined schema', () => {
    expect(extractSchemaFields(undefined)).toEqual([]);
  });

  test('returns [] for a non-object (e.g. bare string) schema', () => {
    expect(extractSchemaFields({ type: 'string' })).toEqual([]);
  });

  test('extracts properties sorted by name, marking required fields', () => {
    const fields = extractSchemaFields({
      type: 'object',
      required: ['orderId'],
      properties: {
        orderId: { type: 'string', description: 'The order id.' },
        amountCents: { type: 'number' },
      },
    });

    expect(fields).toEqual([
      { name: 'amountCents', type: 'number', required: false, description: undefined },
      { name: 'orderId', type: 'string', required: true, description: 'The order id.' },
    ]);
  });

  test('labels enum, union, and array-of-types fragments', () => {
    const fields = extractSchemaFields({
      type: 'object',
      properties: {
        tier: { enum: ['bronze', 'silver', 'gold'] },
        target: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        multi: { type: ['string', 'null'] },
        opaque: {},
      },
    });

    const byName = Object.fromEntries(fields.map((field) => [field.name, field.type]));
    expect(byName).toEqual({
      tier: 'enum',
      target: 'union',
      multi: 'string | null',
      opaque: 'unknown',
    });
  });
});
describe('schemaTypeLabel', () => {
  test('labels a root object schema, a root primitive schema, and an unrecognized fragment', () => {
    expect(schemaTypeLabel({ type: 'object', properties: {} })).toBe('object');
    expect(schemaTypeLabel({ type: 'string' })).toBe('string');
    expect(schemaTypeLabel({})).toBe('unknown');
  });
});
