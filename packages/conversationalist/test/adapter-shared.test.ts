import { describe, expect, test } from 'bun:test';

import { isCanonicalToolResultPayload, parseJSONValue, toJSONValue } from '../src/adapters/shared';

describe('shared adapter helpers', () => {
  describe('toJSONValue', () => {
    test('returns primitives as-is', () => {
      expect(toJSONValue(null)).toBeNull();
      expect(toJSONValue('hello')).toBe('hello');
      expect(toJSONValue(42)).toBe(42);
      expect(toJSONValue(true)).toBe(true);
    });

    test('converts arrays recursively', () => {
      expect(toJSONValue([1, 'a', null])).toEqual([1, 'a', null]);
    });

    test('converts objects recursively', () => {
      expect(toJSONValue({ a: 1, b: 'c' })).toEqual({ a: 1, b: 'c' });
    });

    test('preserves prototype-named own keys as JSON data', () => {
      const input = { ['__proto__']: { label: 'retained' }, nested: [{ ['__proto__']: 'value' }] };
      const converted = toJSONValue(input);
      expect(converted).toEqual(input);
      expect(JSON.stringify(converted)).toBe(JSON.stringify(input));
      expect(Object.getPrototypeOf(converted)).toBe(Object.prototype);
    });

    test('converts undefined to string fallback', () => {
      expect(toJSONValue(undefined)).toBe('undefined');
    });
  });

  describe('parseJSONValue', () => {
    test('parses valid JSON', () => {
      expect(parseJSONValue('{"a":1}')).toEqual({ a: 1 });
    });

    test('returns undefined for invalid JSON', () => {
      expect(parseJSONValue('not json')).toBeUndefined();
    });
  });

  describe('isCanonicalToolResultPayload', () => {
    test('returns true for valid canonical payload', () => {
      expect(
        isCanonicalToolResultPayload({
          outcome: 'success',
          content: 'data',
        }),
      ).toBe(true);
    });

    test('returns false for non-object', () => {
      expect(isCanonicalToolResultPayload('string')).toBe(false);
      expect(isCanonicalToolResultPayload(null)).toBe(false);
    });

    test('returns false when missing outcome', () => {
      expect(isCanonicalToolResultPayload({ content: 'data' })).toBe(false);
    });

    test('returns false when missing content', () => {
      expect(isCanonicalToolResultPayload({ outcome: 'success' })).toBe(false);
    });

    test('validates optional canonical fields before claiming their types', () => {
      expect(
        isCanonicalToolResultPayload({ outcome: 'error', content: '', error: 'invalid' }),
      ).toBe(false);
      expect(
        isCanonicalToolResultPayload({
          outcome: 'action_required',
          content: '',
          action: { type: 'unknown' },
        }),
      ).toBe(false);
      expect(
        isCanonicalToolResultPayload({ outcome: 'success', content: '', inputDigest: 42 }),
      ).toBe(false);
    });
  });
});
