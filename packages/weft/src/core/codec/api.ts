import { Encoder, decode as msgpackDecode } from '@msgpack/msgpack';

import { extensionCodec, replaceUndefined } from './extension-codec.ts';

// One reusable encoder. `msgpack.encode()` constructs a fresh `Encoder` and its 2 KiB backing
// buffer on every call, which is a measurable share of the workflow-start admission path
// (two encodes per start), and returns a view into that buffer rather than an exact-size copy.
// `Encoder#encode` returns an exact-size copy and clones itself when re-entered (an extension
// encoder that calls back into `encode`), so sharing one instance is safe.
const sharedEncoder = new Encoder({ extensionCodec });

// Public API
// ---------------------------------------------------------------------------

/**
 * Encode a value to MessagePack bytes with structuredClone semantics.
 *
 * @example
 * ```ts
 * import { encode, decode } from '@lostgradient/weft';
 *
 * const data = { name: 'Alice', createdAt: new Date(), tags: new Set(['admin']) };
 * const bytes = encode(data);
 * console.log(bytes instanceof Uint8Array); // true
 *
 * const restored = decode(bytes) as typeof data;
 * console.log(restored.name);          // 'Alice'
 * console.log(restored.tags instanceof Set); // true
 * ```
 */
export function encode(value: unknown): Uint8Array {
  const preprocessed = replaceUndefined(value, new Set());
  return sharedEncoder.encode(preprocessed);
}

/**
 * Decode MessagePack bytes back to a value.
 *
 * @example
 * ```ts
 * import { encode, decode } from '@lostgradient/weft';
 *
 * const original = { id: 42, labels: new Map([['env', 'prod']]) };
 * const bytes = encode(original);
 * const result = decode(bytes) as typeof original;
 * console.log(result.id);                      // 42
 * console.log(result.labels.get('env'));        // 'prod'
 * ```
 */
export function decode(bytes: Uint8Array): unknown {
  return msgpackDecode(bytes, { extensionCodec });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
