/** What {@link verifyHmacSignature} checks. */
export interface VerifyHmacSignatureOptions {
  /** The secret the sender and the plugin share. An empty secret never verifies. */
  readonly secret: string;
  /** The bytes the sender signed: the request body, read as bytes. A string is its UTF-8 bytes. */
  readonly body: Uint8Array | string;
  /** The header value the sender sent, such as `sha256=<64 lowercase hex digits>`, or `null` when it sent none. */
  readonly signature: string | null;
}

/** The only form accepted: the algorithm, then 32 bytes as 64 lowercase hex digits. */
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;

function bytesOfHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Whether `signature` is the HMAC-SHA-256 of `body` under `secret`, in the form `sha256=` and 64
 * lowercase hex digits that GitHub and most webhook senders use. A trigger's `receive` calls it with
 * the body bytes it read and the signature header, before it fires anything.
 *
 * The comparison is Web Crypto's `crypto.subtle.verify`, which is constant time: the two digests
 * are never compared as strings. It resolves `false`, and never rejects, for a missing signature
 * (`null`), one of the wrong length or prefix, upper-case or non-hex digits, an empty secret, and
 * any input that is not the type declared. It takes its own copy of a byte array before it awaits,
 * so a caller that reuses the buffer meanwhile changes nothing. It checks no timestamp: a replayed
 * delivery is answered by the idempotency key `fire` is given.
 */
export async function verifyHmacSignature(options: VerifyHmacSignatureOptions): Promise<boolean> {
  try {
    const { secret, body, signature } = options;
    if (typeof secret !== 'string' || secret === '' || typeof signature !== 'string') return false;
    if (typeof body !== 'string' && !(body instanceof Uint8Array)) return false;
    const match = SIGNATURE_PATTERN.exec(signature);
    if (match?.[1] === undefined) return false;
    const encoder = new TextEncoder();
    // The caller owns `body`: take its bytes now, before anything awaits, so a buffer it reuses
    // while the key is imported cannot change what is verified.
    const bytes = typeof body === 'string' ? encoder.encode(body) : body.slice();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify('HMAC', key, bytesOfHex(match[1]), bytes);
  } catch {
    return false;
  }
}
