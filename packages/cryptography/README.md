# Cryptography

`@lostgradient/cryptography` owns the cross-platform hashing, signing, timing-safe comparison, and authenticated-encryption primitives shared by Corvidae packages.

## Public API

- `sha256Hex` uses Web Crypto and works in browser, Bun, Node.js, and Deno environments.
- `sha256BytesHex` digests raw bytes through the same Web Crypto path. Use it for content that is not text — a bundled image or font — where decoding to a string first would corrupt the input rather than hash it.
- `sha256HexSync` uses `node:crypto`, which Bun and supported Node.js versions both provide. It never selects an implementation by runtime.
- `hmacSha256HexSync` signs text with HMAC-SHA-256.
- `timingSafeEqualHex` compares valid equal-length hexadecimal digests without leaking the first differing byte.
- `createIncrementalHash` hashes streamed text incrementally.
- `generateEncryptionKey`, `importEncryptionKey`, and `exportEncryptionKey` create and persist AES-256-GCM keys.
- `encrypt`, `decrypt`, and `decryptBytes` seal and open values with a `Keyring`; failures are `CryptographyError`s with a `code`.

The synchronous APIs fail explicitly when the host does not expose the required cryptographic primitive. Browser consumers should use `sha256Hex`.

## Hashing text

Use the asynchronous function when code must also run in a browser. It encodes the string as UTF-8 and returns a lowercase hexadecimal digest through [Web Crypto](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API):

```typescript
import { sha256Hex } from '@lostgradient/cryptography';

const digest = await sha256Hex('hello');
console.log(digest);
// 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

Hash the exact serialized representation you intend to identify. This package does not normalize whitespace, canonicalize JSON, or provide password storage.

On the server, the incremental API lets you feed text in chunks without concatenating the complete input first:

```typescript
import { createIncrementalHash, sha256HexSync } from '@lostgradient/cryptography';

const hash = createIncrementalHash(); // SHA-256 by default.
hash.update('hel');
hash.update('lo');
console.log(hash.digest() === sha256HexSync('hello')); // true
```

Call `digest()` when all chunks have arrived and create a new hasher for the next message. Treat finalization as the end of that instance's lifetime.

## Encrypting stored secrets

`encrypt` and `decrypt` use AES-256-GCM through Web Crypto, so they run in browsers, Bun, Node.js, and Deno. A stored value is plain JSON-safe data, all binary fields base64url without padding:

```typescript
import {
  decrypt,
  encrypt,
  exportEncryptionKey,
  generateEncryptionKey,
  importEncryptionKey,
} from '@lostgradient/cryptography';

const key = await generateEncryptionKey();
const encoded = await exportEncryptionKey(key); // 32 raw bytes as base64url: key material, store as a secret.

const stored = await encrypt('correct horse battery staple', key);
// { version: 1, ciphertext: '…', iv: '…', keyId: '…' }

const restored = await importEncryptionKey(encoded);
console.log(await decrypt(stored, { current: restored })); // correct horse battery staple
```

Each call to `encrypt` draws a fresh random 96-bit IV, so encrypting the same text twice gives different output; rotate a key well before it has sealed about 2^32 values. The 128-bit tag is part of `ciphertext`. The `keyId` is 24 lowercase hexadecimal characters taken from a domain-separated SHA-256 of the key, so it is safe to store and log, can be recomputed from the key, and is a valid Bungalow secret-name suffix; name the secret that holds a retired key `answer-encryption-key-<keyId>` (a hyphen, not a dot). `encrypt` rejects a string with a lone surrogate (`invalid-text`) instead of silently changing it, and `decrypt` returns a leading U+FEFF unchanged. The version and `keyId` are bound into the GCM additional data, so rewriting either one fails authentication instead of selecting another key.

`importEncryptionKey` returns a non-extractable key by default, which `exportEncryptionKey` then refuses; pass `{ extractable: true }` when you must export it again. `generateEncryptionKey` returns an extractable key.

### Rotation

A `Keyring` is the key that encrypts new values plus retired keys that can only decrypt. Values name their key by `keyId`, so rotating means making the new key `current` and moving the old one to `retired`:

```typescript
import {
  CryptographyError,
  decrypt,
  encrypt,
  generateEncryptionKey,
  type Keyring,
} from '@lostgradient/cryptography';

const oldKey = await generateEncryptionKey();
const stored = await encrypt('token', oldKey);

const keyring: Keyring = { current: await generateEncryptionKey(), retired: [oldKey] };
console.log(await decrypt(stored, keyring)); // token

try {
  await decrypt(stored, { current: keyring.current }); // the retired key was dropped
} catch (error) {
  if (error instanceof CryptographyError) console.log(error.code); // secret-unavailable
}
```

`CryptographyError.code` is one of `secret-unavailable` (the keyring lacks the stored `keyId`), `authentication-failed` (a field was altered or the key is wrong), `malformed-secret`, `unsupported-version`, `invalid-key`, or `invalid-text` (`encrypt` was given a string with a lone surrogate, or `decrypt` found bytes that are not UTF-8; use `decryptBytes`). Messages are fixed text and never contain key material or plaintext.

## Signatures and comparison

`hmacSha256HexSync(secret, text)` takes the secret first and the message second. It returns a hexadecimal HMAC-SHA-256 signature. Keep the secret in the calling application's credential boundary; the package does not load or store credentials.

`timingSafeEqualHex(expected, received)` returns `false` for empty, odd-length, invalid, or differently sized hexadecimal strings. Valid equal-length inputs use the host's timing-safe byte comparison, and hexadecimal letter case does not change the bytes. Shape validation is separate from that comparison; the helper does not promise to conceal input length or validity.

The synchronous helpers require the relevant Bun or Node cryptographic primitives. Missing primitives throw; there is no non-cryptographic fallback. Browser code should use `sha256Hex` for hashing and compose its own Web Crypto signing operation when needed.

## Workspace usage

Declare `"@lostgradient/cryptography": "workspace:*"` in the consuming workspace and import from the package root. The package exports private TypeScript source; the consumer owns compilation.

## Development

Run `bunx turbo run lint typecheck test --filter=@lostgradient/cryptography --concurrency=1` from the repository root. Run `bun run validate` for the complete workspace.
