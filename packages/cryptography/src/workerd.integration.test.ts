import { withWorker } from '@lostgradient/workerd-testing';
import { expect, test } from 'bun:test';

const entry = new URL('./workerd-fixture.ts', import.meta.url).pathname;
const knownHex = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('runs every synchronous hash and equality helper under workerd', async () => {
  await withWorker({ entry }, async ({ dispatchFetch }) => {
    const response = await dispatchFetch('https://cryptography.test');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bytes: knownHex,
      bytesAsync: knownHex,
      hex: knownHex,
      hexAsync: knownHex,
      hmac: '9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab',
      incremental: knownHex,
      pkce: 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0',
      textDifferent: false,
      textEqual: true,
      textLengthDifferent: false,
      hexEqual: true,
      hexDifferent: false,
    });
  });
});
