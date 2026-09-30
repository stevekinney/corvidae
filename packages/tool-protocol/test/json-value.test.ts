import { describe, expect, test } from 'bun:test';

import { assertJSONValue, isJSONValue } from '../src';

describe('assertJSONValue / isJSONValue (AB-18)', () => {
  test('accepts every JSON primitive, dense arrays, and plain/null-prototype objects', () => {
    for (const value of [
      null,
      'text',
      true,
      false,
      0,
      -1.5,
      [1, 2, 3],
      { a: 1, b: { c: [1, null, 'x'] } },
      Object.assign(Object.create(null), { a: 1 }),
      [],
      {},
    ]) {
      expect(() => assertJSONValue(value)).not.toThrow();
      expect(isJSONValue(value)).toBe(true);
    }
  });

  test('rejects non-finite numbers', () => {
    expect(isJSONValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJSONValue(Number.NaN)).toBe(false);
    expect(() => assertJSONValue(Number.NaN)).toThrow(TypeError);
  });

  test('rejects undefined, bigint, function, and symbol', () => {
    expect(isJSONValue(undefined)).toBe(false);
    expect(isJSONValue(1n)).toBe(false);
    expect(isJSONValue(() => {})).toBe(false);
    expect(isJSONValue(Symbol('x'))).toBe(false);
  });

  test('rejects a sparse array (a hole is not a present index)', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    expect(isJSONValue(sparse)).toBe(false);
  });

  test('rejects an array carrying an own non-index property', () => {
    const withExtra: unknown[] & { label?: string } = [1, 2];
    withExtra.label = 'oops';
    expect(isJSONValue(withExtra)).toBe(false);
  });

  test('rejects a dense array carrying a non-enumerable non-index property', () => {
    const dense: unknown[] = [1, 2];
    expect(Object.keys(dense).length).toBe(dense.length);
    Object.defineProperty(dense, 'foo', { value: 'hidden', enumerable: false });
    expect(Object.keys(dense).length).toBe(dense.length);
    expect(isJSONValue(dense)).toBe(false);
    expect(() => assertJSONValue(dense)).toThrow(/Non-enumerable own property/);
  });

  test('rejects a dense array carrying a symbol-keyed property', () => {
    const dense: unknown[] = [1, 2];
    expect(Object.keys(dense).length).toBe(dense.length);
    (dense as unknown as Record<symbol, unknown>)[Symbol('hidden')] = 'x';
    expect(Object.keys(dense).length).toBe(dense.length);
    expect(isJSONValue(dense)).toBe(false);
    expect(() => assertJSONValue(dense)).toThrow(/Symbol-keyed property/);
  });

  test('accepts a plain dense array with only index properties', () => {
    const dense = [1, 'two', [3]];
    expect(Object.keys(dense).length).toBe(dense.length);
    expect(() => assertJSONValue(dense)).not.toThrow();
    expect(isJSONValue(dense)).toBe(true);
  });

  test('rejects a Date, Map, Set, and class instance (non-plain prototype)', () => {
    class Point {
      x = 1;
      y = 2;
    }
    expect(isJSONValue(new Date())).toBe(false);
    expect(isJSONValue(new Map([['a', 1]]))).toBe(false);
    expect(isJSONValue(new Set([1, 2]))).toBe(false);
    expect(isJSONValue(new Point())).toBe(false);
  });

  test('rejects an object with a symbol-keyed property', () => {
    const withSymbol: Record<string, unknown> = { a: 1 };
    (withSymbol as Record<symbol, unknown>)[Symbol('hidden')] = 'x';
    expect(isJSONValue(withSymbol)).toBe(false);
    expect(() => assertJSONValue(withSymbol)).toThrow(/Symbol-keyed property/);
  });

  test('rejects an object with a non-enumerable custom property', () => {
    const withHidden: Record<string, unknown> = { a: 1 };
    Object.defineProperty(withHidden, 'secret', { value: 42, enumerable: false });
    expect(isJSONValue(withHidden)).toBe(false);
    expect(() => assertJSONValue(withHidden)).toThrow(/Non-enumerable own property/);
  });

  test('rejects a circular array and a circular object', () => {
    const circularArray: unknown[] = [1, 2];
    circularArray.push(circularArray);
    expect(isJSONValue(circularArray)).toBe(false);

    const circularObject: Record<string, unknown> = {};
    circularObject['self'] = circularObject;
    expect(isJSONValue(circularObject)).toBe(false);
  });

  test('accepts a shared (non-cyclic) reference appearing twice', () => {
    const shared = { id: 1 };
    expect(isJSONValue({ a: shared, b: shared })).toBe(true);
  });
});
