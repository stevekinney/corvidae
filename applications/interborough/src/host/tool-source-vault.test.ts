/**
 * COR-1930: the encrypted store of tool-source credentials and OAuth state.
 */
import { generateEncryptionKey } from '@lostgradient/cryptography';
import { describe, expect, test } from 'bun:test';

import {
  createToolSourceVault,
  toolSourceSecretKey,
  ToolSourceSecretsLockedError,
  ToolSourceSecretsUnreadableError,
} from './tool-source-vault.ts';

function memory(mode: 'local' | 'remote' = 'local') {
  const secrets = new Map<string, string>();
  return {
    secrets,
    bungalow: {
      mode,
      readSecret: (key: string) => secrets.get(key),
      writeSecret: (key: string, value: string) => void secrets.set(key, value),
    },
  };
}

async function vaultOver(home = memory()) {
  const keys = { current: await generateEncryptionKey() };
  return { home, keys, vault: createToolSourceVault({ bungalow: home.bungalow, keys }) };
}

describe('the tool-source vault', () => {
  test('stores every value and the whole OAuth state as ciphertext, and reads them back', async () => {
    const { home, vault } = await vaultOver();

    await vault.write('files', {
      credentials: new Map([['token', 'plain-token-value']]),
      oauth: {
        tokens: { access_token: 'plain-access', token_type: 'Bearer' },
        codeVerifier: 'plain-verifier',
      },
    });

    const stored = home.secrets.get(toolSourceSecretKey('files')) ?? '';
    for (const plaintext of ['plain-token-value', 'plain-access', 'plain-verifier', 'Bearer']) {
      expect(stored).not.toContain(plaintext);
    }
    // Only the names are in the clear.
    expect(vault.credentialNames('files')).toEqual(['token']);
    const read = await vault.read('files');
    expect(read.credentials.get('token')).toBe('plain-token-value');
    expect(read.oauth?.codeVerifier).toBe('plain-verifier');
  });

  test('refuses a secret copied from another source, and one sealed under a key that is gone', async () => {
    const { home, vault } = await vaultOver();
    await vault.write('files', { credentials: new Map([['token', 'v']]), oauth: undefined });
    home.secrets.set(
      toolSourceSecretKey('other'),
      home.secrets.get(toolSourceSecretKey('files')) ?? '',
    );

    const copied = await vault.read('other').catch((error: unknown) => error);
    const elsewhere = createToolSourceVault({
      bungalow: home.bungalow,
      keys: { current: await generateEncryptionKey() },
    });
    const keyGone = await elsewhere.read('files').catch((error: unknown) => error);

    expect(copied).toBeInstanceOf(ToolSourceSecretsUnreadableError);
    expect(keyGone).toBeInstanceOf(ToolSourceSecretsUnreadableError);
    expect(String(keyGone)).not.toContain('files-secret');
  });

  test('swaps a credential’s ciphertext for another credential’s only by failing', async () => {
    const { home, vault } = await vaultOver();
    await vault.write('files', {
      credentials: new Map([
        ['first', 'one'],
        ['second', 'two'],
      ]),
      oauth: undefined,
    });
    const record = JSON.parse(home.secrets.get(toolSourceSecretKey('files')) ?? '{}') as {
      credentials: Record<string, unknown>;
    };
    record.credentials['second'] = record.credentials['first'];
    home.secrets.set(toolSourceSecretKey('files'), JSON.stringify(record));

    const failure = await vault.read('files').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ToolSourceSecretsUnreadableError);
  });

  test('keeps both of two overlapping OAuth saves', async () => {
    const { vault } = await vaultOver();
    const storage = vault.tokenStorage('files');

    await Promise.all([
      storage.save({ codeVerifier: 'verifier' }),
      storage.save({ state: 'state' }),
      storage.save({ tokens: { access_token: 'a', token_type: 'Bearer' } }),
    ]);

    const loaded = await storage.load();
    expect(loaded.codeVerifier).toBe('verifier');
    expect(loaded.state).toBe('state');
    expect(loaded.tokens?.access_token).toBe('a');
    await storage.clear?.(['codeVerifier', 'state']);
    const cleared = await storage.load();
    expect(cleared.codeVerifier).toBeUndefined();
    expect(cleared.tokens?.access_token).toBe('a');
  });

  test('reads a source with no secret as having none, and clearing it removes what it held', async () => {
    const { vault } = await vaultOver();
    const empty = await vault.read('files');
    expect(empty.credentials.size).toBe(0);
    expect(vault.credentialNames('files')).toEqual([]);

    await vault.write('files', { credentials: new Map([['token', 'v']]), oauth: undefined });
    vault.clear('files');

    expect(vault.credentialNames('files')).toEqual([]);
    expect(vault.stored('files')).toBeUndefined();
  });

  test('refuses to write in a remote home, where the deployment holds the secrets', async () => {
    const { vault } = await vaultOver(memory('remote'));

    const failure = await vault
      .write('files', { credentials: new Map([['token', 'v']]), oauth: undefined })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ToolSourceSecretsLockedError);
    expect(() => vault.clear('files')).toThrow(ToolSourceSecretsLockedError);
  });
});
