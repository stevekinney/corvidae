import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIncrementalHash,
  sha256Base64UrlSync,
  sha256BytesHexSync,
  sha256HexSync,
  timingSafeEqualHex,
  timingSafeEqualText,
} from './hash.ts';

const knownHex = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('matches the SHA-256 and PKCE vectors on Node', () => {
  assert.equal(sha256HexSync('abc'), knownHex);
  assert.equal(sha256BytesHexSync(new Uint8Array([0x61, 0x62, 0x63])), knownHex);
  assert.equal(sha256Base64UrlSync('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
});

test('compares UTF-8 text and incremental digests on Node', () => {
  assert.equal(timingSafeEqualText('é', 'é'), true);
  assert.equal(timingSafeEqualText('é', 'e'), false);
  assert.equal(timingSafeEqualText('abc', 'abd'), false);
  assert.equal(timingSafeEqualHex(knownHex, knownHex), true);
  const incremental = createIncrementalHash();
  incremental.update('a');
  incremental.update('bc');
  assert.equal(incremental.digest(), knownHex);
});
