import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { sortJsonValue, type JsonObject } from '../src/core/serialization/json';
import {
  assertJsonValue,
  defineTool,
  serializeToolDefinition,
  stableStringifyJson,
} from '../src/index';

function expectPlainJsonObject(value: unknown): asserts value is JsonObject {
  assertJsonValue(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
}

describe('JSON serialization own properties', () => {
  it('retains own special keys as data properties without changing the result prototype', () => {
    const input = {
      z: 1,
      ['__proto__']: { marker: 'retained' },
      constructor: 'constructor value',
      prototype: 'prototype value',
      toString: 'toString value',
    };
    const sorted = sortJsonValue(input);
    expectPlainJsonObject(sorted);
    expect(Object.keys(sorted)).toEqual(['__proto__', 'constructor', 'prototype', 'toString', 'z']);
    expect(Object.getOwnPropertyDescriptor(sorted, '__proto__')).toEqual({
      value: { marker: 'retained' },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(stableStringifyJson(input)).toBe(
      '{"__proto__":{"marker":"retained"},"constructor":"constructor value","prototype":"prototype value","toString":"toString value","z":1}',
    );
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
  });

  it('preserves special keys recursively through ordinary objects and arrays', () => {
    const input = { outer: [{ inner: { ['__proto__']: { z: 2, a: 1 }, safe: true } }] };
    const json = stableStringifyJson(input);
    expect(json).toBe('{"outer":[{"inner":{"__proto__":{"a":1,"z":2},"safe":true}}]}');
    expect(input.outer[0]?.inner['__proto__']).toEqual({ z: 2, a: 1 });
  });

  it('keeps distinct special-key values distinct in stable serialization', () => {
    const left = { ['__proto__']: { tenant: 'left' }, same: true };
    const right = { ['__proto__']: { tenant: 'right' }, same: true };
    expect(stableStringifyJson(left)).not.toBe(stableStringifyJson(right));
    expect(stableStringifyJson(left)).not.toBe(stableStringifyJson({ same: true }));
  });

  it('preserves sorted getter reads and enumerable-string-key selection', () => {
    const reads: string[] = [];
    const symbol = Symbol('omitted');
    const input = {
      get z() {
        reads.push('z');
        return 2;
      },
      get a() {
        reads.push('a');
        return 1;
      },
      [symbol]: 'not JSON',
    };
    Object.setPrototypeOf(input, null);
    Object.defineProperty(input, 'hidden', { value: 'not enumerable' });
    const sorted = sortJsonValue(input);
    expectPlainJsonObject(sorted);
    expect(reads).toEqual(['a', 'z']);
    expect(Object.keys(sorted)).toEqual(['a', 'z']);
    expect(Object.getOwnPropertySymbols(sorted)).toEqual([]);
    expect(stableStringifyJson(sorted)).toBe('{"a":1,"z":2}');
  });

  it('retains special-key metadata in the public tool serializer', () => {
    const definition = defineTool({
      name: 'metadata-special-key',
      description: 'Preserve JSON metadata',
      input: z.object({}),
      metadata: { ['__proto__']: { marker: 'metadata' }, normal: 1 },
    });
    const metadata = serializeToolDefinition(definition).metadata;
    expectPlainJsonObject(metadata);
    expect(Object.hasOwn(metadata, '__proto__')).toBe(true);
    expect(metadata['__proto__']).toEqual({ marker: 'metadata' });
    expect(stableStringifyJson(metadata)).toBe('{"__proto__":{"marker":"metadata"},"normal":1}');
  });
});
