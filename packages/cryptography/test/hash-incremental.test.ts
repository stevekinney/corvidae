import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { createIncrementalHash, sha256HexSync } from '../src/hash';

const runtimeOverrideSymbol = Symbol.for('corvidae.cryptography.hash.runtime');

async function withRuntimeOverride<T>(
  runtimeOverride: unknown,
  callback: () => T | Promise<T>,
): Promise<T> {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const hadExistingOverride = runtimeOverrideSymbol in globalRecord;
  const previousOverride = globalRecord[runtimeOverrideSymbol];
  globalRecord[runtimeOverrideSymbol] = runtimeOverride;
  try {
    return await callback();
  } finally {
    if (hadExistingOverride) globalRecord[runtimeOverrideSymbol] = previousOverride;
    else delete globalRecord[runtimeOverrideSymbol];
  }
}

describe('createIncrementalHash', () => {
  test('single update + digest matches sha256HexSync for same input', () => {
    const hash = createIncrementalHash();
    hash.update('hello');
    expect(hash.digest()).toBe(sha256HexSync('hello'));
  });

  test('multiple update calls produce same result as single call with concatenated input', () => {
    const hash = createIncrementalHash();
    hash.update('hello');
    hash.update(' ');
    hash.update('world');
    expect(hash.digest()).toBe(sha256HexSync('hello world'));
  });

  test('separate instances are independent', () => {
    const a = createIncrementalHash();
    const b = createIncrementalHash();
    a.update('hello');
    b.update('world');
    expect(a.digest()).toBe(sha256HexSync('hello'));
    expect(b.digest()).toBe(sha256HexSync('world'));
  });

  test('defaults to sha256 algorithm', () => {
    const hash = createIncrementalHash();
    hash.update('test');
    expect(hash.digest()).toBe(sha256HexSync('test'));
  });

  test('passes supported Bun algorithms through without a package whitelist', () => {
    const hash = createIncrementalHash('blake2b512');
    hash.update('test');
    expect(hash.digest()).toBe(createHash('blake2b512').update('test').digest('hex'));
  });

  test('falls back to node crypto when the Bun runtime is unavailable', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
        require: (specifier: string) => {
          expect(specifier).toBe('node:crypto');
          return { createHash };
        },
      },
      () => {
        const hash = createIncrementalHash('sha256');
        hash.update('hello');
        hash.update(' world');
        expect(hash.digest()).toBe(createHash('sha256').update('hello world').digest('hex'));
      },
    );
  });

  test('uses the default require fallback when no override is provided', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
      },
      () => {
        const hash = createIncrementalHash();
        hash.update('fallback');
        expect(hash.digest()).toBe(createHash('sha256').update('fallback').digest('hex'));
      },
    );
  });

  test('throws a helpful error when no synchronous streaming runtime is available', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
        require: () => {
          throw new Error('runtime unavailable');
        },
      },
      () => {
        expect(() => createIncrementalHash()).toThrow(
          'createIncrementalHash is not available in this environment. Use the async sha256Hex instead, which works everywhere via Web Crypto.',
        );
      },
    );
  });
});
