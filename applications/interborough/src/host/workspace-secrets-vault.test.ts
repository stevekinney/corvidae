import { openTemporaryBungalow } from '@lostgradient/bungalow';
import { generateEncryptionKey } from '@lostgradient/cryptography';
import { expect, test } from 'bun:test';
import { createToolSourceVault } from './tool-source-vault.ts';

test('an admitted source resolves the credential version from its checked configuration snapshot', async () => {
  using bungalow = await openTemporaryBungalow({ name: 'secret-vault' });
  const keys = { current: await generateEncryptionKey() };
  const first = createToolSourceVault({ bungalow, keys });
  const second = createToolSourceVault({ bungalow, keys });
  await first.write('source', { credentials: new Map([['token', 'original']]), oauth: undefined });
  const observed = await bungalow.readConfiguration();
  await second.write('source', {
    credentials: new Map([['token', 'replacement']]),
    oauth: undefined,
  });
  const admitted = await first.read('source', observed);
  const current = await first.read('source');
  expect(admitted.credentials.get('token')).toBe('original');
  expect(current.credentials.get('token')).toBe('replacement');
});

test('OAuth predicate, credential read, and publication use one configuration fence across clients', async () => {
  using bungalow = await openTemporaryBungalow({ name: 'secret-vault' });
  const keys = { current: await generateEncryptionKey() };
  const first = createToolSourceVault({ bungalow, keys });
  const second = createToolSourceVault({ bungalow, keys });
  await first.write('source', { credentials: new Map(), oauth: { state: 'first' } });
  const storage = first.tokenStorage('source', 'take', async (snapshot) => {
    expect(snapshot?.revision).toBeDefined();
    await second.write('source', { credentials: new Map(), oauth: { state: 'second' } });
    return true;
  });
  expect(
    await Promise.resolve(storage.save({ codeVerifier: 'stale-callback' })).then(
      () => undefined,
      (error: unknown) => error,
    ),
  ).toMatchObject({
    code: 'conflict',
  });
  const current = await second.read('source');
  expect(current.oauth).toEqual({ state: 'second' });
});
