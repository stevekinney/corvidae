import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  createIncrementalHash,
  sha256Base64UrlSync,
  sha256BytesHexSync,
  sha256HexSync,
  timingSafeEqualHex,
  timingSafeEqualText,
} from './hash.ts';

const knownHex = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('synchronous SHA-256 helpers', () => {
  test('preserves the known text, byte, and PKCE vectors', () => {
    expect(sha256HexSync('abc')).toBe(knownHex);
    expect(sha256BytesHexSync(new Uint8Array([0x61, 0x62, 0x63]))).toBe(knownHex);
    expect(sha256Base64UrlSync('abc')).toBe(createHash('sha256').update('abc').digest('base64url'));
  });

  test('compares equal UTF-8 inputs and rejects length and content differences', () => {
    expect(timingSafeEqualText('é', 'é')).toBe(true);
    expect(timingSafeEqualText('é', 'e')).toBe(false);
    expect(timingSafeEqualText('abc', 'abd')).toBe(false);
    expect(timingSafeEqualHex(knownHex, knownHex)).toBe(true);
  });

  test('matches an incremental hash with a one-shot hash', () => {
    const incremental = createIncrementalHash();
    incremental.update('a');
    incremental.update('bc');
    expect(incremental.digest()).toBe(sha256HexSync('abc'));
  });
});
