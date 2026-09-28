import { describe, expect, it } from 'bun:test';

import { fnv1a64 } from '../src/conversation/snapshot-integrity';

/** The original `BigInt` formulation, kept as the reference the limb version must match. */
function referenceFnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/** Deterministic xorshift so a failing input can be reproduced from its seed. */
function codeUnitStrings(seed: number, count: number): string[] {
  let state = seed;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return Array.from({ length: count }, () =>
    String.fromCharCode(...Array.from({ length: next() % 256 }, () => next() % 0x10000)),
  );
}

describe('fnv1a64', () => {
  it('matches the published FNV-1a 64-bit test vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('is bit-identical to the BigInt formulation across UTF-16 code units', () => {
    const inputs = [
      '\u0000',
      '￿',
      '😀 surrogate pair',
      '\ud800 lone surrogate',
      '{"key":"value"}',
      ...codeUnitStrings(0x9e3779b9, 500),
    ];
    for (const input of inputs) {
      expect(fnv1a64(input)).toBe(referenceFnv1a64(input));
    }
  });
});
