import { describe, expect, it } from 'bun:test';

import {
  HOOK_SIGNATURE_TOLERANCE_SECONDS,
  signHookDelivery,
  verifyHookSignature,
} from './hook-signature.ts';

const SECRET = 'whsec-signature-test-1234567890';
const BODY = '{"id":"d-1","kind":"run.settled"}';
const T = 1_800_000_000;

/** An independent computation of the documented algorithm, with WebCrypto. */
async function expectedDigest(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('X-Signature', () => {
  it('is t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>"> under the secret', async () => {
    const header = signHookDelivery({ secret: SECRET, body: BODY, timestampSeconds: T });
    expect(header).toBe(`t=${T},v1=${await expectedDigest(SECRET, T, BODY)}`);
  });

  it('is accepted by a verifier whose clock is inside the window', () => {
    const header = signHookDelivery({ secret: SECRET, body: BODY, timestampSeconds: T });
    expect(verifyHookSignature({ secret: SECRET, header, body: BODY, now: T * 1000 })).toEqual({
      ok: true,
    });
    expect(
      verifyHookSignature({
        secret: SECRET,
        header,
        body: BODY,
        now: (T + HOOK_SIGNATURE_TOLERANCE_SECONDS) * 1000,
      }),
    ).toEqual({ ok: true });
  });

  it('fails when the body is altered by one byte', () => {
    const header = signHookDelivery({ secret: SECRET, body: BODY, timestampSeconds: T });
    expect(
      verifyHookSignature({ secret: SECRET, header, body: `${BODY} `, now: T * 1000 }),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('fails when the timestamp is altered, even to another time inside the window', () => {
    const header = signHookDelivery({ secret: SECRET, body: BODY, timestampSeconds: T });
    const altered = header.replace(`t=${T}`, `t=${T + 1}`);
    expect(
      verifyHookSignature({ secret: SECRET, header: altered, body: BODY, now: T * 1000 }),
    ).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('fails under another secret', () => {
    const header = signHookDelivery({ secret: SECRET, body: BODY, timestampSeconds: T });
    expect(
      verifyHookSignature({ secret: `${SECRET}x`, header, body: BODY, now: T * 1000 }),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a replay outside the window, in either direction', () => {
    const header = signHookDelivery({ secret: SECRET, body: BODY, timestampSeconds: T });
    const late = (T + HOOK_SIGNATURE_TOLERANCE_SECONDS + 1) * 1000;
    const early = (T - HOOK_SIGNATURE_TOLERANCE_SECONDS - 1) * 1000;
    expect(verifyHookSignature({ secret: SECRET, header, body: BODY, now: late })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyHookSignature({ secret: SECRET, header, body: BODY, now: early })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('accepts any v1 part when a header carries several, and ignores parts it does not know', () => {
    const good = signHookDelivery({ secret: SECRET, body: BODY, timestampSeconds: T });
    const digest = good.split('v1=')[1]!;
    const other = 'a'.repeat(64);
    const header = `t=${T},v1=${other},v1=${digest},v2=whatever`;
    expect(verifyHookSignature({ secret: SECRET, header, body: BODY, now: T * 1000 })).toEqual({
      ok: true,
    });
  });

  it.each(['', 'v1=abc', `t=${T}`, `t=abc,v1=${'a'.repeat(64)}`, `t=${T},v1=XYZ`])(
    'calls %p malformed',
    (header) => {
      expect(verifyHookSignature({ secret: SECRET, header, body: BODY, now: T * 1000 })).toEqual({
        ok: false,
        reason: 'malformed',
      });
    },
  );

  it('fails closed on a clock or tolerance that is not a number, and on a header that is not text', () => {
    const header = signHookDelivery({ secret: SECRET, body: BODY, timestampSeconds: T });
    expect(verifyHookSignature({ secret: SECRET, header, body: BODY, now: Number.NaN })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(
      verifyHookSignature({
        secret: SECRET,
        header,
        body: BODY,
        now: T * 1000,
        toleranceSeconds: Number.NaN,
      }),
    ).toEqual({ ok: false, reason: 'expired' });
    expect(
      verifyHookSignature({
        secret: SECRET,
        header: undefined as never,
        body: BODY,
        now: T * 1000,
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });
});
