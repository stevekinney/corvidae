import type { StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  getSchemaKeys,
  getSchemaShape,
  isZodObjectSchema,
  isZodSchema,
  schemasLooselyMatch,
  unwrapSchema,
  wrapStandardSchema,
} from '../src/core/schema-utilities';

/** A minimal hand-rolled Standard Schema V1 validator that trims and uppercases. */
function shoutingStringSchema(): StandardSchemaV1<unknown, string> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        if (typeof value !== 'string' || value.trim().length === 0) {
          return { issues: [{ message: 'expected a non-empty string', path: ['value'] }] };
        }
        // A real transform: the OUTPUT differs from the raw input, so a
        // refine-based (rather than transform-based) wrapper would silently
        // drop this and leak the raw input through to `execute()`.
        return { value: value.trim().toUpperCase() };
      },
    },
  };
}

describe('schema utilities', () => {
  it('derives shapes from direct shape functions and objects', () => {
    const fnShape = { shape: () => ({ foo: 1, bar: 2 }) };
    const objShape = { shape: { baz: true } };
    const defShape = { _def: { shape: () => ({ qux: 'ok' }) } };

    expect(Reflect.apply(getSchemaShape, undefined, [fnShape])).toEqual({ foo: 1, bar: 2 });
    expect(Reflect.apply(getSchemaShape, undefined, [objShape])).toEqual({ baz: true });
    expect(Reflect.apply(getSchemaShape, undefined, [defShape])).toEqual({ qux: 'ok' });
  });

  it('gracefully handles shape accessors that throw', () => {
    const throwingShape = {
      shape: () => {
        throw new Error('nope');
      },
    };
    const throwingDefShape = {
      _def: {
        shape: () => {
          throw new Error('boom');
        },
      },
    };

    expect(Reflect.apply(getSchemaShape, undefined, [throwingShape])).toBeUndefined();
    expect(Reflect.apply(getSchemaShape, undefined, [throwingDefShape])).toBeUndefined();
  });

  it('unwraps nested schema wrappers', () => {
    const leaf = { shape: () => ({ leaf: true }) };
    const viaInner = { _def: { innerType: leaf } };
    const viaSchema = { _def: { schema: leaf } };
    const viaDefOut = { def: { out: leaf } };

    expect(Reflect.apply(unwrapSchema, undefined, [viaInner])).toBe(leaf);
    expect(Reflect.apply(unwrapSchema, undefined, [viaSchema])).toBe(leaf);
    expect(Reflect.apply(unwrapSchema, undefined, [viaDefOut])).toBe(leaf);
  });

  it('returns schema keys when shape information exists', () => {
    const schema = { shape: () => ({ alpha: true, beta: true }) };
    expect(Reflect.apply(getSchemaKeys, undefined, [schema]).toSorted()).toEqual(['alpha', 'beta']);
    expect(Reflect.apply(getSchemaKeys, undefined, [{}])).toEqual([]);
  });

  it('performs loose schema comparison with subset semantics', () => {
    const target = { shape: () => ({ foo: true, bar: true }) };
    const matching = { shape: () => ({ foo: true }) };
    const nonMatching = { shape: () => ({ baz: true }) };
    const empty = { shape: () => ({}) };

    expect(Reflect.apply(schemasLooselyMatch, undefined, [target, matching])).toBe(true);
    expect(Reflect.apply(schemasLooselyMatch, undefined, [target, nonMatching])).toBe(false);
    expect(Reflect.apply(schemasLooselyMatch, undefined, [target, empty])).toBe(true);
    expect(Reflect.apply(schemasLooselyMatch, undefined, [{}, matching])).toBe(false);
  });

  it('identifies Zod schemas via safeParse detection', () => {
    expect(
      isZodSchema({
        safeParse() {
          return null;
        },
      }),
    ).toBe(true);
    expect(isZodSchema(null)).toBe(false);
  });

  it('identifies Zod object schemas by shape detection', () => {
    expect(isZodObjectSchema(z.object({ foo: z.string() }))).toBe(true);
    expect(isZodObjectSchema(z.number())).toBe(false);
  });

  describe('wrapStandardSchema', () => {
    it('produces a ZodTypeAny whose parseAsync returns the VALIDATOR output, not the raw input', async () => {
      const wrapped = wrapStandardSchema(shoutingStringSchema());
      const result = await wrapped.parseAsync('  hello  ');
      // If wrapStandardSchema used `refine` (boolean gate) instead of
      // `transform`, this would be the untouched raw input ('  hello  ').
      expect(result).toBe('HELLO');
    });

    it('raises a real z.ZodError on validation failure, carrying the issue message', async () => {
      const wrapped = wrapStandardSchema(shoutingStringSchema());
      try {
        await wrapped.parseAsync('   ');
        throw new Error('expected parseAsync to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(z.ZodError);
        if (error instanceof z.ZodError) {
          expect(error.issues[0]?.message).toBe('expected a non-empty string');
        }
      }
    });

    it('throws synchronously via `parse` because the wrapped check is async', () => {
      const wrapped = wrapStandardSchema(shoutingStringSchema());
      expect(() => wrapped.parse('hello')).toThrow();
    });
  });
});
