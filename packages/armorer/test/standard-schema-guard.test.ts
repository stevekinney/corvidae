import type { StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, test } from 'bun:test';

import { isStandardSchema } from '../src/core/schema-utilities';

/** A minimal hand-rolled Standard Schema V1 validator — no vendor dependency required. */
function positiveIntegerSchema(): StandardSchemaV1<unknown, number> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
          return { value };
        }
        return { issues: [{ message: 'expected a positive integer' }] };
      },
    },
  };
}

describe('isStandardSchema', () => {
  test.each([
    { validate: () => ({ value: 1 }) },
    { version: 2, vendor: 'test', validate: () => ({ value: 1 }) },
    { version: 1, vendor: 42, validate: () => ({ value: 1 }) },
  ])('rejects malformed standard metadata: %j', (properties) => {
    expect(isStandardSchema({ '~standard': properties })).toBe(false);
  });
  test('recognizes a validator with a `~standard.validate` function', () => {
    expect(isStandardSchema(positiveIntegerSchema())).toBe(true);
  });

  test('rejects plain objects without `~standard`', () => {
    expect(isStandardSchema({ type: 'object' })).toBe(false);
  });

  test('rejects primitives', () => {
    expect(isStandardSchema('not a schema')).toBe(false);
    expect(isStandardSchema(42)).toBe(false);
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema(undefined)).toBe(false);
  });

  test('rejects an object whose `~standard` has no validate function', () => {
    expect(isStandardSchema({ '~standard': { version: 1 } })).toBe(false);
  });
});
