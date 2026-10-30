import { describe, expect, test } from 'bun:test';

import {
  CryptographyError,
  decrypt,
  decryptBytes,
  encrypt,
  exportEncryptionKey,
  generateEncryptionKey,
  importEncryptionKey,
  type CryptographyErrorCode,
  type EncryptedValue,
  type Keyring,
} from '../src/index';

const secret = 'correct horse battery staple';

async function expectCode(work: Promise<unknown>, code: CryptographyErrorCode): Promise<void> {
  const error = await work.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CryptographyError);
  expect((error as CryptographyError).code).toBe(code);
}

function flipByte(encoded: string, which: 'first' | 'last'): string {
  const bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
  const index = which === 'first' ? 0 : bytes.length - 1;
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

const flipFirstByte = (encoded: string): string => flipByte(encoded, 'first');
const flipLastByte = (encoded: string): string => flipByte(encoded, 'last');

describe('encrypt and decrypt', () => {
  test('round-trips text and bytes', async () => {
    const key = await generateEncryptionKey();
    const stored = await encrypt(secret, key);
    expect(stored.version).toBe(1);
    expect(stored.keyId).toBe(key.keyId);
    expect(await decrypt(stored, { current: key })).toBe(secret);

    const bytes = Uint8Array.from([0, 255, 254, 1, 2]);
    const storedBytes = await encrypt(bytes, key);
    expect(await decryptBytes(storedBytes, { current: key })).toEqual(bytes);
    await expectCode(decrypt(storedBytes, { current: key }), 'invalid-text');
  });

  test('round-trips the empty string and survives JSON storage', async () => {
    const key = await generateEncryptionKey();
    const stored = JSON.parse(JSON.stringify(await encrypt('', key))) as EncryptedValue;
    expect(await decrypt(stored, { current: key })).toBe('');
  });

  test('refuses input that is neither text nor bytes', async () => {
    const key = await generateEncryptionKey();
    const error = await encrypt(undefined as unknown as string, key).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(TypeError);
  });

  test('never reuses an IV and never repeats a ciphertext for the same plaintext', async () => {
    const key = await generateEncryptionKey();
    const values = await Promise.all(Array.from({ length: 64 }, () => encrypt(secret, key)));
    expect(new Set(values.map((value) => value.iv)).size).toBe(64);
    expect(new Set(values.map((value) => value.ciphertext)).size).toBe(64);
  });

  test('stored fields are unpadded base64url and the IV is 96 bits', async () => {
    const key = await generateEncryptionKey();
    const stored = await encrypt(secret, key);
    for (const field of [stored.ciphertext, stored.iv, stored.keyId]) {
      expect(field).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(atob(stored.iv.replaceAll('-', '+').replaceAll('_', '/')).length).toBe(12);
  });
});

describe('tampering', () => {
  test('a changed ciphertext fails authentication', async () => {
    const key = await generateEncryptionKey();
    const stored = await encrypt(secret, key);
    await expectCode(
      decrypt({ ...stored, ciphertext: flipFirstByte(stored.ciphertext) }, { current: key }),
      'authentication-failed',
    );
  });

  test('a changed tag fails authentication', async () => {
    const key = await generateEncryptionKey();
    const stored = await encrypt(secret, key);
    await expectCode(
      decrypt({ ...stored, ciphertext: flipLastByte(stored.ciphertext) }, { current: key }),
      'authentication-failed',
    );
  });

  test('a changed iv fails authentication', async () => {
    const key = await generateEncryptionKey();
    const stored = await encrypt(secret, key);
    await expectCode(
      decrypt({ ...stored, iv: flipFirstByte(stored.iv) }, { current: key }),
      'authentication-failed',
    );
  });

  test('a keyId swapped for another ring key fails authentication', async () => {
    const first = await generateEncryptionKey();
    const second = await generateEncryptionKey();
    const stored = await encrypt(secret, first);
    await expectCode(
      decrypt({ ...stored, keyId: second.keyId }, { current: first, retired: [second] }),
      'authentication-failed',
    );
  });

  test('the keyId is bound into the additional data, not only used for lookup', async () => {
    const key = await generateEncryptionKey();
    // The same key registered under a second id: only the additional data can tell them apart.
    const alias = { keyId: 'alias', cryptoKey: key.cryptoKey };
    const stored = await encrypt(secret, key);
    const ring: Keyring = { current: key, retired: [alias] };
    expect(await decrypt(stored, ring)).toBe(secret);
    await expectCode(decrypt({ ...stored, keyId: 'alias' }, ring), 'authentication-failed');
  });

  test('an unknown keyId is secret-unavailable and names only the id', async () => {
    const key = await generateEncryptionKey();
    const stored = await encrypt(secret, key);
    const error = await decrypt({ ...stored, keyId: 'nope' }, { current: key }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(CryptographyError);
    expect((error as CryptographyError).code).toBe('secret-unavailable');
    expect((error as CryptographyError).keyId).toBe('nope');
    expect((error as CryptographyError).message).not.toContain('nope');
  });

  test('an unsupported version is refused before any key is used', async () => {
    const key = await generateEncryptionKey();
    const stored = await encrypt(secret, key);
    await expectCode(
      decrypt({ ...stored, version: 2 } as unknown as EncryptedValue, { current: key }),
      'unsupported-version',
    );
    const { version: _removed, ...unversioned } = stored;
    await expectCode(
      decrypt(unversioned as unknown as EncryptedValue, { current: key }),
      'malformed-secret',
    );
  });

  test('a decryption with the wrong key fails authentication', async () => {
    const key = await generateEncryptionKey();
    const other = await generateEncryptionKey();
    const stored = await encrypt(secret, key);
    // Present the other key under the stored id, as a mislabeled keyring would.
    const mislabeled = { keyId: key.keyId, cryptoKey: other.cryptoKey };
    await expectCode(decrypt(stored, { current: mislabeled }), 'authentication-failed');
  });

  test('misshapen values are malformed', async () => {
    const key = await generateEncryptionKey();
    const stored = await encrypt(secret, key);
    const ring: Keyring = { current: key };
    const cases: unknown[] = [
      null,
      'text',
      {},
      { ...stored, iv: 'AAAA' },
      { ...stored, ciphertext: 'AAAA' },
      { ...stored, ciphertext: stored.ciphertext + '=' },
      { ...stored, ciphertext: `${stored.ciphertext}!` },
      { ...stored, ciphertext: 42 },
      { ...stored, keyId: 42 },
      { version: 1, ciphertext: stored.ciphertext, iv: stored.iv },
    ];
    for (const value of cases) {
      await expectCode(decrypt(value as EncryptedValue, ring), 'malformed-secret');
    }
  });

  test('a non-canonical encoding of valid ciphertext is refused', async () => {
    const key = await generateEncryptionKey();
    // 12 IV bytes encode to 16 characters with no spare bits; use a 1-byte tail to find spare bits.
    const stored = await encrypt('a', key); // 1 + 16 = 17 bytes -> 23 chars, last char carries spare bits
    expect(stored.ciphertext.length % 4).toBe(3);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = stored.ciphertext.at(-1) ?? 'A';
    const sibling = alphabet[(alphabet.indexOf(last) + 1) % 64] ?? 'A';
    const variant = stored.ciphertext.slice(0, -1) + sibling;
    // Both spare bits are zero in the canonical form, so any other final character is non-canonical.
    await expectCode(
      decrypt({ ...stored, ciphertext: variant }, { current: key }),
      'malformed-secret',
    );
  });
});

describe('rotation', () => {
  test('a value written under a retired key still decrypts through the keyring', async () => {
    const oldKey = await generateEncryptionKey();
    const newKey = await generateEncryptionKey();
    const oldValue = await encrypt(secret, oldKey);
    const ring: Keyring = { current: newKey, retired: [oldKey] };
    expect(await decrypt(oldValue, ring)).toBe(secret);
    const newValue = await encrypt(secret, ring.current);
    expect(newValue.keyId).toBe(newKey.keyId);
    expect(await decrypt(newValue, ring)).toBe(secret);
  });

  test('dropping the retired key yields secret-unavailable', async () => {
    const oldKey = await generateEncryptionKey();
    const newKey = await generateEncryptionKey();
    const oldValue = await encrypt(secret, oldKey);
    await expectCode(decrypt(oldValue, { current: newKey }), 'secret-unavailable');
    await expectCode(decrypt(oldValue, { current: newKey, retired: [] }), 'secret-unavailable');
  });
});

describe('key import and export', () => {
  test('export then import yields the same id and a working key', async () => {
    const key = await generateEncryptionKey();
    const exported = await exportEncryptionKey(key);
    expect(exported).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const imported = await importEncryptionKey(exported);
    expect(imported.keyId).toBe(key.keyId);
    const stored = await encrypt(secret, key);
    expect(await decrypt(stored, { current: imported })).toBe(secret);
    expect(
      await exportEncryptionKey(await importEncryptionKey(exported, { extractable: true })),
    ).toBe(exported);
  });

  test('the key id does not contain the key and differs per key', async () => {
    const first = await generateEncryptionKey();
    const second = await generateEncryptionKey();
    const exported = await exportEncryptionKey(first);
    expect(first.keyId).not.toBe(second.keyId);
    expect(first.keyId.length).toBe(16);
    expect(exported.includes(first.keyId)).toBe(false);
  });

  test('imported keys are not extractable by default', async () => {
    const key = await generateEncryptionKey();
    const imported = await importEncryptionKey(await exportEncryptionKey(key));
    await expectCode(exportEncryptionKey(imported), 'invalid-key');
  });

  test('invalid encoded keys are refused without echoing them', async () => {
    const tooShort = 'AAAA';
    const notBase64 = '!'.repeat(43);
    for (const encoded of [tooShort, notBase64, '', 'A'.repeat(44)]) {
      const error = await importEncryptionKey(encoded).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(CryptographyError);
      expect((error as CryptographyError).code).toBe('invalid-key');
      expect((error as CryptographyError).message).not.toContain(encoded || '\0');
    }
  });
});

describe('error hygiene', () => {
  test('no error message contains the plaintext or the key', async () => {
    const key = await generateEncryptionKey();
    const exported = await exportEncryptionKey(key);
    const stored = await encrypt(secret, key);
    const failures = await Promise.all([
      decrypt({ ...stored, ciphertext: flipFirstByte(stored.ciphertext) }, { current: key }).catch(
        (reason: unknown) => reason,
      ),
      decrypt({ ...stored, keyId: 'x' }, { current: key }).catch((reason: unknown) => reason),
      importEncryptionKey(exported.slice(1)).catch((reason: unknown) => reason),
    ]);
    for (const failure of failures) {
      const text = `${(failure as Error).message}${(failure as Error).stack ?? ''}`;
      expect(text).not.toContain(secret);
      expect(text).not.toContain(exported);
    }
  });
});
