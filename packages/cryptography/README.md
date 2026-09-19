# Cryptography

`@corvidae/cryptography` owns the cross-platform hashing, signing, and timing-safe comparison primitives shared by Corvidae packages.

## Public API

- `sha256Hex` uses Web Crypto and works in browser, Bun, Node.js, and Deno environments.
- `sha256HexSync` uses Bun or supported Node.js built-ins.
- `hmacSha256HexSync` signs text with HMAC-SHA-256.
- `timingSafeEqualHex` compares valid equal-length hexadecimal digests without leaking the first differing byte.
- `createIncrementalHash` hashes streamed text incrementally.

The synchronous APIs fail explicitly when the host does not expose the required cryptographic primitive. Browser consumers should use `sha256Hex`.

## Development

Run `bunx turbo run lint typecheck test --filter=@corvidae/cryptography --concurrency=1` from the repository root. Run `bun run validate` for the complete workspace.
