import type { Bungalow } from '@lostgradient/bungalow';
import {
  decrypt,
  encrypt,
  exportEncryptionKey,
  generateEncryptionKey,
} from '@lostgradient/cryptography';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, test } from 'bun:test';

import {
  ANSWER_ENCRYPTION_KEY,
  answerEncryptionKeys,
  retiredAnswerEncryptionKey,
} from './answer-encryption.ts';

/** A Bungalow that holds its secrets in a map and records every write. */
function fakeBungalow(mode: 'local' | 'remote', secrets = new Map<string, string>()) {
  const writes: string[] = [];
  const bungalow = {
    mode,
    readSecret: (key: string) => secrets.get(key),
    writeSecret: (key: string, value: string) => {
      if (mode === 'remote') throw new Error('A remote Bungalow cannot write a secret.');
      writes.push(key);
      secrets.set(key, value);
    },
    secretLocation: (key: string) =>
      mode === 'remote' ? `INTERBOROUGH_SECRET_${key.toUpperCase().replaceAll('-', '_')}` : key,
  } as unknown as Bungalow;
  return { bungalow, secrets, writes };
}

describe('answerEncryptionKeys', () => {
  test('creates the key on a local host’s first start and reads the same key afterwards', async () => {
    const { bungalow, secrets, writes } = fakeBungalow('local');

    const first = await answerEncryptionKeys(bungalow);
    const second = await answerEncryptionKeys(bungalow);

    expect(writes).toEqual([ANSWER_ENCRYPTION_KEY]);
    expect(secrets.get(ANSWER_ENCRYPTION_KEY)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.current.keyId).toBe(first.current.keyId);
    const sealed = await encrypt('hunter2', first.current);
    expect(await decrypt(sealed, { current: second.current })).toBe('hunter2');
  });

  test('reads a remote host’s key from the deployment and never writes one', async () => {
    const stored = await exportEncryptionKey(await generateEncryptionKey());
    const { bungalow, writes } = fakeBungalow('remote', new Map([[ANSWER_ENCRYPTION_KEY, stored]]));

    const keys = await answerEncryptionKeys(bungalow);

    expect(writes).toEqual([]);
    expect(keys.current.keyId).toMatch(/^[0-9a-f]{24}$/);
  });

  test('refuses a remote host without the key, naming the variable', async () => {
    const { bungalow } = fakeBungalow('remote');

    const failure = await rejectionOf(answerEncryptionKeys(bungalow));
    expect(String(failure)).toContain('INTERBOROUGH_SECRET_ANSWER_ENCRYPTION_KEY');
  });

  test('reads a retired key by its id, and nothing for an id it does not hold', async () => {
    const old = await generateEncryptionKey();
    const { bungalow, secrets } = fakeBungalow('local');
    const keys = await answerEncryptionKeys(bungalow);
    secrets.set(retiredAnswerEncryptionKey(old.keyId), await exportEncryptionKey(old));

    const found = await keys.retired?.(old.keyId);
    expect(found?.keyId).toBe(old.keyId);
    expect(await keys.retired?.('0'.repeat(24))).toBeUndefined();
    // An id that is not a key id is never turned into a secret name.
    expect(await keys.retired?.('../approval-secret')).toBeUndefined();
  });

  test('ignores a retired file that holds a key with another id', async () => {
    const wrong = await generateEncryptionKey();
    const named = '0123456789abcdef01234567';
    const { bungalow, secrets } = fakeBungalow('local');
    const keys = await answerEncryptionKeys(bungalow);
    secrets.set(retiredAnswerEncryptionKey(named), await exportEncryptionKey(wrong));

    expect(await keys.retired?.(named)).toBeUndefined();
  });
});
