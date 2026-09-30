import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { OutputSchemaConversionError } from '../../src/errors.ts';
import { isStrictCompatible, toOutputJsonSchema } from '../../src/structured-output/response-schema.ts';

describe('toOutputJsonSchema', () => {
  it('converts z.string() to { type: "string" }', () => {
    expect(toOutputJsonSchema(z.string())).toMatchObject({ type: 'string' });
  });

  it('converts z.number() to { type: "number" }', () => {
    expect(toOutputJsonSchema(z.number())).toMatchObject({ type: 'number' });
  });

  it('converts z.boolean() to { type: "boolean" }', () => {
    expect(toOutputJsonSchema(z.boolean())).toMatchObject({ type: 'boolean' });
  });

  it('converts z.object() with required properties', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const result = toOutputJsonSchema(schema);
    expect(result).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['name', 'age']),
    });
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    expect(props['name']).toMatchObject({ type: 'string' });
    expect(props['age']).toMatchObject({ type: 'number' });
  });

  it('converts z.object() with optional properties', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.optional(z.string()),
    });
    const result = toOutputJsonSchema(schema);
    expect(result).toMatchObject({ type: 'object' });
    const required = result['required'] as string[];
    expect(required).toContain('name');
    expect(required).not.toContain('nickname');
  });

  it('converts z.array() with items', () => {
    const schema = z.array(z.string());
    expect(toOutputJsonSchema(schema)).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('converts z.enum() to { type: "string", enum: [...] }', () => {
    const schema = z.enum(['red', 'green', 'blue']);
    expect(toOutputJsonSchema(schema)).toMatchObject({
      type: 'string',
      enum: ['red', 'green', 'blue'],
    });
  });

  it('converts z.literal() with a string to { const: value }', () => {
    expect(toOutputJsonSchema(z.literal('hello'))).toMatchObject({ const: 'hello' });
  });

  it('converts z.literal() with a number to { const: value }', () => {
    expect(toOutputJsonSchema(z.literal(42))).toMatchObject({ const: 42 });
  });

  it('converts z.literal() with a boolean to { const: value }', () => {
    expect(toOutputJsonSchema(z.literal(true))).toMatchObject({ const: true });
  });

  it('converts z.union() to { anyOf: [...] }', () => {
    const schema = z.union([z.string(), z.number()]);
    const result = toOutputJsonSchema(schema);
    expect(result).toHaveProperty('anyOf');
    const anyOf = result['anyOf'] as Array<Record<string, unknown>>;
    expect(anyOf).toHaveLength(2);
    expect(anyOf[0]).toMatchObject({ type: 'string' });
    expect(anyOf[1]).toMatchObject({ type: 'number' });
  });

  it('handles nested objects recursively', () => {
    const schema = z.object({
      address: z.object({
        street: z.string(),
        city: z.string(),
      }),
    });
    const result = toOutputJsonSchema(schema);
    expect(result).toMatchObject({ type: 'object' });
    // The nested object may be inlined or referenced via $defs
    expect(result['properties']).toBeDefined();
  });

  it('handles arrays of objects', () => {
    const schema = z.array(
      z.object({
        id: z.number(),
        name: z.string(),
      }),
    );
    const result = toOutputJsonSchema(schema);
    expect(result).toMatchObject({ type: 'array' });
    expect(result['items']).toBeDefined();
  });

  it('strips $schema and ~standard metadata', () => {
    const result = toOutputJsonSchema(z.string());
    expect(result).not.toHaveProperty('$schema');
    expect(result).not.toHaveProperty('~standard');
  });

  it('throws OutputSchemaConversionError synchronously for an unrepresentable schema, with no generic-object fallback', () => {
    expect(() => toOutputJsonSchema(z.date())).toThrow(OutputSchemaConversionError);
    try {
      toOutputJsonSchema(z.date());
      throw new Error('expected toOutputJsonSchema to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OutputSchemaConversionError);
      expect((error as InstanceType<typeof OutputSchemaConversionError>).code).toBe(
        'OUTPUT_SCHEMA_CONVERSION_FAILED',
      );
      expect((error as InstanceType<typeof OutputSchemaConversionError>).cause).toBeDefined();
    }
  });

  it('memoizes by schema identity — repeated calls on the same schema return the same object', () => {
    const schema = z.object({ answer: z.string() });
    const first = toOutputJsonSchema(schema);
    const second = toOutputJsonSchema(schema);
    expect(second).toBe(first);
  });

  it('does not cross-contaminate two structurally-identical but distinct schema instances', () => {
    const a = z.object({ answer: z.string() });
    const b = z.object({ answer: z.string() });
    expect(toOutputJsonSchema(a)).toEqual(toOutputJsonSchema(b));
    expect(toOutputJsonSchema(a)).not.toBe(toOutputJsonSchema(b));
  });

  it('keeps throwing for an unrepresentable schema on every call, not just the first', () => {
    const schema = z.date();
    expect(() => toOutputJsonSchema(schema)).toThrow(OutputSchemaConversionError);
    expect(() => toOutputJsonSchema(schema)).toThrow(OutputSchemaConversionError);
  });
});

describe('toOutputJsonSchema mutation safety', () => {
  it('returns a fresh deep copy so caller mutation never corrupts later calls', () => {
    const schema = z.object({
      name: z.string(),
      choice: z.union([z.string(), z.object({ id: z.number() })]),
    });
    const first = toOutputJsonSchema(schema);
    const snapshot = structuredClone(first);
    const properties = first['properties'] as Record<string, Record<string, unknown>>;
    delete properties['name'];
    properties['extra'] = { type: 'string' };
    const anyOf = properties['choice']?.['anyOf'] as unknown[] | undefined;
    anyOf?.push({ type: 'null' });
    (first['required'] as string[]).push('bogus');
    first['title'] = 'mutated';

    const second = toOutputJsonSchema(schema);
    expect(second).not.toBe(first);
    expect(second).toEqual(snapshot);
  });

  it('returns a fresh copy for the primitive-union normalized branch', () => {
    const schema = z.union([z.string(), z.number()]);
    const first = toOutputJsonSchema(schema);
    const snapshot = structuredClone(first);
    (first['anyOf'] as unknown[]).push({ type: 'null' });
    expect(toOutputJsonSchema(schema)).toEqual(snapshot);
  });

  it('returns distinct objects on cache hits', () => {
    const schema = z.string();
    expect(toOutputJsonSchema(schema)).not.toBe(toOutputJsonSchema(schema));
  });
});

describe('isStrictCompatible', () => {
  const strictObject = {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
    required: ['a', 'b'],
    additionalProperties: false,
  };
  const looseObject = { type: 'object', properties: {}, required: [] };

  it('accepts a fully strict-compliant schema', () => {
    expect(isStrictCompatible(strictObject)).toBe(true);
    expect(
      isStrictCompatible({
        type: 'object',
        properties: {
          list: { type: 'array', items: strictObject },
          u: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['list', 'u'],
        additionalProperties: false,
      }),
    ).toBe(true);
  });

  it('accepts primitive schemas', () => {
    expect(isStrictCompatible({ type: 'string' })).toBe(true);
  });

  it('rejects an object missing additionalProperties: false', () => {
    const { additionalProperties: _a, ...rest } = strictObject;
    expect(isStrictCompatible(rest)).toBe(false);
    expect(isStrictCompatible({ ...strictObject, additionalProperties: true })).toBe(false);
  });

  it('rejects nested objects missing additionalProperties: false', () => {
    expect(
      isStrictCompatible({
        ...strictObject,
        properties: { a: looseObject, b: { type: 'number' } },
      }),
    ).toBe(false);
    expect(isStrictCompatible({ type: 'array', items: looseObject })).toBe(false);
    expect(isStrictCompatible({ anyOf: [looseObject] })).toBe(false);
  });

  it('rejects an object inside $defs or definitions without additionalProperties: false', () => {
    expect(isStrictCompatible({ ...strictObject, $defs: { X: looseObject } })).toBe(false);
    expect(isStrictCompatible({ ...strictObject, definitions: { X: looseObject } })).toBe(false);
  });

  it('rejects a property absent from required', () => {
    expect(isStrictCompatible({ ...strictObject, required: ['a'] })).toBe(false);
    const { required: _r, ...noRequired } = strictObject;
    expect(isStrictCompatible(noRequired)).toBe(false);
  });

  const keywords = [
    'minLength',
    'maxLength',
    'pattern',
    'format',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minItems',
    'maxItems',
    'uniqueItems',
    'minProperties',
    'maxProperties',
    'allOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
    'dependentRequired',
    'dependentSchemas',
    'patternProperties',
  ];
  for (const keyword of keywords) {
    it(`rejects ${keyword} at the top level, nested, and inside $defs`, () => {
      const bad = { [keyword]: keyword === 'uniqueItems' ? true : {} };
      expect(isStrictCompatible({ ...strictObject, ...bad })).toBe(false);
      expect(
        isStrictCompatible({
          ...strictObject,
          properties: { a: { type: 'string', ...bad }, b: { type: 'number' } },
        }),
      ).toBe(false);
      expect(isStrictCompatible({ ...strictObject, $defs: { X: { type: 'string', ...bad } } })).toBe(
        false,
      );
    });
  }

  it('rejects $ref anywhere', () => {
    expect(isStrictCompatible({ ...strictObject, $ref: '#/$defs/X' })).toBe(false);
    expect(
      isStrictCompatible({
        ...strictObject,
        properties: { a: { $ref: '#/$defs/X' }, b: { type: 'number' } },
        $defs: { X: { type: 'string' } },
      }),
    ).toBe(false);
    expect(isStrictCompatible({ ...strictObject, $defs: { X: { $ref: '#' } } })).toBe(false);
  });

  it('does not treat a property NAMED like a keyword as a violation', () => {
    expect(
      isStrictCompatible({
        type: 'object',
        properties: { pattern: { type: 'string' }, format: { type: 'string' } },
        required: ['pattern', 'format'],
        additionalProperties: false,
      }),
    ).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(isStrictCompatible(null as never)).toBe(false);
  });
});
