/**
 * COR-1709 — a JSON Schema from outside the process becomes a Standard Schema validator, within
 * the size and keyword limits Bureau holds every untrusted schema to.
 */
import { describe, expect, it } from 'bun:test';

import {
  DECISION_SCHEMA_MAXIMUM_BYTES,
  DecisionSchemaRefusedError,
  standardSchemaFromJsonSchema,
} from './json-schema-standard.ts';

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
  required: ['name'],
  additionalProperties: false,
};

describe('standardSchemaFromJsonSchema', () => {
  it('validates an answer and describes the schema it was given', () => {
    const standard = standardSchemaFromJsonSchema(SCHEMA)['~standard'];

    expect(standard.validate({ name: 'x', count: 2 })).toEqual({ value: { name: 'x', count: 2 } });
    const refused = standard.validate({ count: 0, extra: true });
    expect('issues' in refused && refused.issues.length).toBeGreaterThan(0);
    expect(standard.jsonSchema.input({ target: 'draft-2020-12' })).toEqual(SCHEMA);
  });

  it('hands out a copy, so the caller’s later change reaches neither the validator nor the model', () => {
    const mutable = structuredClone(SCHEMA);
    const standard = standardSchemaFromJsonSchema(mutable)['~standard'];
    mutable.required = [];
    standard.jsonSchema.input().type = 'string';

    expect(standard.validate({})).toHaveProperty('issues');
    expect(standard.jsonSchema.input()).toEqual(SCHEMA);
  });

  it.each([
    ['a number', 7],
    ['an array', []],
    ['null', null],
  ])('refuses %s', (_label, schema) => {
    expect(() => standardSchemaFromJsonSchema(schema)).toThrow(DecisionSchemaRefusedError);
  });

  it('refuses a schema over the size limit', () => {
    const large = { type: 'object', description: 'x'.repeat(DECISION_SCHEMA_MAXIMUM_BYTES) };

    expect(() => standardSchemaFromJsonSchema(large)).toThrow(/at most 16384 bytes/);
  });

  it.each([
    ['a pattern', { type: 'string', pattern: '^(a+)+$' }],
    ['a nested pattern', { type: 'object', properties: { a: { type: 'string', pattern: 'a' } } }],
    ['an $id', { $id: 'https://example.test/schema', type: 'string' }],
    [
      'a nested $id',
      { type: 'object', properties: { a: { $id: 'https://x.test/a', type: 'string' } } },
    ],
    ['an unresolvable $ref', { $ref: '#/$defs/missing' }],
    ['an unknown type', { type: 'nonsense' }],
  ])('refuses %s', (_label, schema) => {
    expect(() => standardSchemaFromJsonSchema(schema)).toThrow(DecisionSchemaRefusedError);
  });
});
