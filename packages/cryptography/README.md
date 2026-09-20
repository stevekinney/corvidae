# Cryptography

`@corvidae/cryptography` owns the cross-platform hashing, signing, and timing-safe comparison primitives shared by Corvidae packages.

## Public API

- `sha256Hex` uses Web Crypto and works in browser, Bun, Node.js, and Deno environments.
- `sha256BytesHex` digests raw bytes through the same Web Crypto path. Use it for content that is not text — a bundled image or font — where decoding to a string first would corrupt the input rather than hash it.
- `sha256HexSync` uses Bun or supported Node.js built-ins.
- `hmacSha256HexSync` signs text with HMAC-SHA-256.
- `timingSafeEqualHex` compares valid equal-length hexadecimal digests without leaking the first differing byte.
- `createIncrementalHash` hashes streamed text incrementally.

The synchronous APIs fail explicitly when the host does not expose the required cryptographic primitive. Browser consumers should use `sha256Hex`.

## Hashing text

Use the asynchronous function when code must also run in a browser. It encodes the string as UTF-8 and returns a lowercase hexadecimal digest through [Web Crypto](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API):

```typescript
import { sha256Hex } from '@corvidae/cryptography';

const digest = await sha256Hex('hello');
console.log(digest);
// 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

Hash the exact serialized representation you intend to identify. This package does not normalize whitespace, canonicalize JSON, encrypt content, or provide password storage.

On the server, the incremental API lets you feed text in chunks without concatenating the complete input first:

```typescript
import { createIncrementalHash, sha256HexSync } from '@corvidae/cryptography';

const hash = createIncrementalHash(); // SHA-256 by default.
hash.update('hel');
hash.update('lo');
console.log(hash.digest() === sha256HexSync('hello')); // true
```

Call `digest()` when all chunks have arrived and create a new hasher for the next message. Treat finalization as the end of that instance's lifetime.

## Signatures and comparison

`hmacSha256HexSync(secret, text)` takes the secret first and the message second. It returns a hexadecimal HMAC-SHA-256 signature. Keep the secret in the calling application's credential boundary; the package does not load or store credentials.

`timingSafeEqualHex(expected, received)` returns `false` for empty, odd-length, invalid, or differently sized hexadecimal strings. Valid equal-length inputs use the host's timing-safe byte comparison, and hexadecimal letter case does not change the bytes. Shape validation is separate from that comparison; the helper does not promise to conceal input length or validity.

The synchronous helpers require the relevant Bun or Node cryptographic primitives. Missing primitives throw; there is no non-cryptographic fallback. Browser code should use `sha256Hex` for hashing and compose its own Web Crypto signing operation when needed.

## Workspace usage

Declare `"@corvidae/cryptography": "workspace:*"` in the consuming workspace and import from the package root. The package exports private TypeScript source; the consumer owns compilation.

## Development

Run `bunx turbo run lint typecheck test --filter=@corvidae/cryptography --concurrency=1` from the repository root. Run `bun run validate` for the complete workspace.
