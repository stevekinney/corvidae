import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { hmacSha256HexSync, sha256HexSync, timingSafeEqualHex } from '../src/hash';

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

describe('hash runtime shape guards', () => {
  test('rejects a malformed crypto module returned by the runtime loader', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
        require: () => ({ createHash: 'not-a-function' }),
      },
      () => {
        expect(() => sha256HexSync('hello')).toThrow(
          'sha256HexSync is not available in this environment.',
        );
      },
    );
  });

  test('rejects a malformed crypto module returned by getBuiltinModule', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
        getBuiltinModule: () => ({ createHash: 'not-a-function' }),
      },
      () => {
        expect(() => sha256HexSync('hello')).toThrow(
          'sha256HexSync is not available in this environment.',
        );
      },
    );
  });
});

// ── hmacSha256HexSync ─────────────────────────────────────────────

describe('hmacSha256HexSync', () => {
  test('rejects a malformed HMAC implementation from the runtime loader', async () => {
    await withRuntimeOverride(
      {
        Bun: undefined,
        require: () => ({ createHmac: 'not-a-function' }),
      },
      () => {
        expect(() => hmacSha256HexSync('secret', 'payload')).toThrow(
          'hmacSha256HexSync is not available in this environment.',
        );
      },
    );
  });
});

// ── timingSafeEqualHex ────────────────────────────────────────────

describe('timingSafeEqualHex', () => {
  test('rejects a malformed timing-safe implementation from the runtime loader', async () => {
    const digest = createHash('sha256').update('same').digest('hex');

    await withRuntimeOverride(
      {
        Bun: undefined,
        require: () => ({ timingSafeEqual: 'not-a-function' }),
      },
      () => {
        expect(() => timingSafeEqualHex(digest, digest)).toThrow(
          'timingSafeEqualHex is not available in this environment.',
        );
      },
    );
  });
});
