/**
 * The `X-Signature` of a hook delivery (COR-1939): the wire contract a receiver verifies.
 *
 * ```
 * X-Signature: t=<unix seconds>,v1=<lowercase hex>
 * v1 = HMAC-SHA256(key = the signing secret as UTF-8, message = "<t>.<raw request body>")
 * ```
 *
 * `t` is taken afresh for every attempt, so a retry is signed again and a receiver's replay window
 * never rejects it for being old. A receiver rejects a header whose `t` is more than
 * {@link HOOK_SIGNATURE_TOLERANCE_SECONDS} from its own clock (replay protection), compares the
 * digest in constant time, and accepts a header that carries several `v1=` parts when any matches
 * (room for a secret rotation). Parts it does not know are ignored. Changing one byte of the body,
 * or the timestamp, changes the digest.
 *
 * @module hook-signature
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The header a delivery's signature travels in. */
export const HOOK_SIGNATURE_HEADER = 'X-Signature';

/** How far a signature's timestamp may be from the receiver's clock before it is rejected: five minutes. */
export const HOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The digest of `<timestamp>.<body>` under `secret`, as lowercase hexadecimal. */
function digestOf(secret: string, timestampSeconds: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
}

/**
 * The `X-Signature` value for `body`, signed with `secret` at `timestampSeconds` (whole Unix
 * seconds).
 */
export function signHookDelivery(input: {
  readonly secret: string;
  readonly body: string;
  readonly timestampSeconds: number;
}): string {
  return `t=${input.timestampSeconds},v1=${digestOf(input.secret, input.timestampSeconds, input.body)}`;
}

/** Why {@link verifyHookSignature} refused a delivery. */
export type HookSignatureFailure =
  /** The header has no `t=` or no `v1=` part, or either is not in the documented form. */
  | 'malformed'
  /** The timestamp is further from the receiver's clock than the tolerance. */
  | 'expired'
  /** No `v1=` digest matches the body and timestamp under the secret. */
  | 'mismatch';

/** The outcome of {@link verifyHookSignature}. */
export type HookSignatureVerification =
  { readonly ok: true } | { readonly ok: false; readonly reason: HookSignatureFailure };

/** The parts of an `X-Signature` header, or `undefined` when it is malformed. */
function parseHeader(
  header: string,
): { readonly timestamp: number; readonly digests: readonly string[] } | undefined {
  let timestamp: number | undefined;
  const digests: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === 't') {
      if (!/^\d{1,15}$/.test(value)) return undefined;
      timestamp = Number(value);
    } else if (name === 'v1') {
      if (!/^[0-9a-f]{64}$/.test(value)) return undefined;
      digests.push(value);
    }
  }
  return timestamp === undefined || digests.length === 0 ? undefined : { timestamp, digests };
}

/**
 * Verifies a hook delivery the way a receiver must: the header is well formed, its timestamp is
 * within `toleranceSeconds` of `now`, and one of its digests is the HMAC of `<t>.<body>` under
 * `secret`. `body` is the raw request body exactly as received.
 */
export function verifyHookSignature(input: {
  /** The signing secret the hook was created with. */
  readonly secret: string;
  /** The `X-Signature` header's value. */
  readonly header: string;
  /** The raw request body, as received. */
  readonly body: string;
  /** The receiver's clock in epoch milliseconds. Defaults to `Date.now()`. */
  readonly now?: number;
  /** The replay window. Defaults to {@link HOOK_SIGNATURE_TOLERANCE_SECONDS}. */
  readonly toleranceSeconds?: number;
}): HookSignatureVerification {
  const parsed = typeof input.header === 'string' ? parseHeader(input.header) : undefined;
  if (parsed === undefined) return { ok: false, reason: 'malformed' };
  const nowSeconds = (input.now ?? Date.now()) / 1000;
  const tolerance = input.toleranceSeconds ?? HOOK_SIGNATURE_TOLERANCE_SECONDS;
  // Written so that a NaN clock or tolerance fails closed instead of passing every comparison.
  if (!(Math.abs(nowSeconds - parsed.timestamp) <= tolerance)) {
    return { ok: false, reason: 'expired' };
  }
  const expected = Buffer.from(digestOf(input.secret, parsed.timestamp, input.body), 'hex');
  const matched = parsed.digests.some((digest) =>
    timingSafeEqual(expected, Buffer.from(digest, 'hex')),
  );
  return matched ? { ok: true } : { ok: false, reason: 'mismatch' };
}
