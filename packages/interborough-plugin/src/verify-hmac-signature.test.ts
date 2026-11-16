/**
 * COR-2169 — `verifyHmacSignature`: the check a `receive` makes of a sender's HMAC-SHA-256 over the
 * body it read. Expected signatures are computed here with `node:crypto`, independently of the
 * implementation, which uses Web Crypto.
 */
import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { verifyHmacSignature } from './verify-hmac-signature.ts';

const SECRET = 'whsec_0123456789abcdef';
const BODY = '{"event":"push","commits":[1,2,3]}';

/** The signature a sender writes for `body` under `secret`: `sha256=` and lowercase hex. */
function sign(body: string | Uint8Array, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

afterEach(() => {
  // Restores any spy a test installed on `crypto.subtle`.
  spies.splice(0).forEach((spy) => spy.mockRestore());
});

const spies: Array<{ mockRestore: () => void }> = [];

describe('verifyHmacSignature', () => {
  test('accepts a correct sha256= signature of a string body', async () => {
    expect(await verifyHmacSignature({ secret: SECRET, body: BODY, signature: sign(BODY) })).toBe(
      true,
    );
  });

  test('accepts a string body and the same bytes as a Uint8Array identically', async () => {
    const bytes = new TextEncoder().encode(BODY);
    const signature = sign(BODY);
    expect(await verifyHmacSignature({ secret: SECRET, body: bytes, signature })).toBe(true);
    expect(await verifyHmacSignature({ secret: SECRET, body: BODY, signature })).toBe(true);
    const wrong = sign('another body');
    expect(await verifyHmacSignature({ secret: SECRET, body: bytes, signature: wrong })).toBe(
      false,
    );
    expect(await verifyHmacSignature({ secret: SECRET, body: BODY, signature: wrong })).toBe(false);
  });

  test('verifies the bytes of a view, not the buffer behind it, and bytes that are not UTF-8', async () => {
    const raw = Uint8Array.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x01, 0x02]);
    expect(await verifyHmacSignature({ secret: SECRET, body: raw, signature: sign(raw) })).toBe(
      true,
    );
    const padded = new Uint8Array(raw.length + 6);
    padded.set(raw, 3);
    const view = padded.subarray(3, 3 + raw.length);
    expect(await verifyHmacSignature({ secret: SECRET, body: view, signature: sign(raw) })).toBe(
      true,
    );
    expect(await verifyHmacSignature({ secret: SECRET, body: padded, signature: sign(raw) })).toBe(
      false,
    );
  });

  test('refuses a wrong secret, a changed body and a signature for another body', async () => {
    const signature = sign(BODY);
    expect(await verifyHmacSignature({ secret: 'another', body: BODY, signature })).toBe(false);
    expect(await verifyHmacSignature({ secret: SECRET, body: `${BODY} `, signature })).toBe(false);
    expect(await verifyHmacSignature({ secret: SECRET, body: BODY, signature: sign('x') })).toBe(
      false,
    );
  });

  test('refuses a missing signature', async () => {
    expect(await verifyHmacSignature({ secret: SECRET, body: BODY, signature: null })).toBe(false);
    expect(
      await verifyHmacSignature({
        secret: SECRET,
        body: BODY,
        signature: undefined as unknown as null,
      }),
    ).toBe(false);
  });

  test('refuses a signature of the wrong length, the wrong prefix, upper-case hex or non-hex', async () => {
    const hex = sign(BODY).slice('sha256='.length);
    const refused = [
      `sha256=${hex.slice(0, -2)}`,
      `sha256=${hex}00`,
      'sha256=',
      hex,
      `sha1=${hex}`,
      `SHA256=${hex}`,
      `sha256:${hex}`,
      ` sha256=${hex}`,
      `sha256=${hex} `,
      `sha256=${hex}\n`,
      `sha256=${hex.toUpperCase()}`,
      // One digit upper-cased: the first letter, since a digit has no other case.
      `sha256=${hex.replace(/[a-f]/, (letter) => letter.toUpperCase())}`,
      `sha256=${'g'.repeat(64)}`,
      `sha256=${hex.slice(0, 63)}z`,
      `sha256=${hex.slice(0, 62)}é`,
      '',
    ];
    for (const signature of refused) {
      expect(await verifyHmacSignature({ secret: SECRET, body: BODY, signature }), signature).toBe(
        false,
      );
    }
    // The control: the one well-formed form is accepted.
    expect(
      await verifyHmacSignature({ secret: SECRET, body: BODY, signature: `sha256=${hex}` }),
    ).toBe(true);
  });

  test('refuses an empty secret, even for the signature an empty key makes', async () => {
    expect(await verifyHmacSignature({ secret: '', body: BODY, signature: sign(BODY, '') })).toBe(
      false,
    );
  });

  test('never throws, whatever it is given', async () => {
    const garbage: unknown[] = [
      undefined,
      null,
      'text',
      7,
      {},
      { secret: 7, body: BODY, signature: sign(BODY) },
      { secret: SECRET, body: 7, signature: sign(BODY) },
      { secret: SECRET, body: undefined, signature: sign(BODY) },
      { secret: SECRET, body: BODY, signature: 7 },
    ];
    for (const input of garbage) {
      const verified = await verifyHmacSignature(
        input as Parameters<typeof verifyHmacSignature>[0],
      );
      expect(verified).toBe(false);
    }
  });

  test('verifies the bytes it was given when it was called, not what the caller wrote over them while the key was imported', async () => {
    const encoder = new TextEncoder();
    const importKey = crypto.subtle.importKey.bind(crypto.subtle);
    let overwrite: Uint8Array | undefined;
    let target: Uint8Array | undefined;
    const imported = spyOn(crypto.subtle, 'importKey').mockImplementation(((
      ...arguments_: Parameters<typeof importKey>
    ) => {
      // The caller reuses its buffer while the host is still importing the key.
      if (target !== undefined && overwrite !== undefined) target.set(overwrite);
      return importKey(...arguments_);
    }) as typeof crypto.subtle.importKey);
    spies.push(imported);

    // A plain array, a Node Buffer (whose `slice` is a view, not a copy), a view over the middle
    // of a larger buffer, and a Buffer view of one.
    const shapes: Array<[string, (text: string) => Uint8Array]> = [
      ['a Uint8Array', (text) => encoder.encode(text)],
      ['a Buffer', (text) => Buffer.from(text)],
      [
        'a subarray of a larger buffer',
        (text) => {
          const larger = new Uint8Array(text.length + 8);
          larger.set(encoder.encode(text), 4);
          return larger.subarray(4, 4 + text.length);
        },
      ],
      [
        'a Buffer over a larger buffer',
        (text) => {
          const larger = Buffer.alloc(text.length + 8);
          larger.write(text, 4);
          return larger.subarray(4, 4 + text.length);
        },
      ],
    ];
    for (const [label, make] of shapes) {
      // Unsigned bytes overwritten with the signed ones during the import are still refused.
      target = make('unsigned');
      overwrite = encoder.encode('approved');
      expect(
        await verifyHmacSignature({ secret: SECRET, body: target, signature: sign('approved') }),
        `${label}, unsigned overwritten with signed`,
      ).toBe(false);

      // Signed bytes overwritten with others during the import are still accepted.
      target = make('approved');
      overwrite = encoder.encode('tampered');
      expect(
        await verifyHmacSignature({ secret: SECRET, body: target, signature: sign('approved') }),
        `${label}, signed overwritten with others`,
      ).toBe(true);
    }
  });

  test('compares through crypto.subtle.verify, never by comparing the two strings', async () => {
    const verify = spyOn(crypto.subtle, 'verify');
    spies.push(verify);
    await verifyHmacSignature({ secret: SECRET, body: BODY, signature: sign(BODY) });
    await verifyHmacSignature({ secret: SECRET, body: BODY, signature: sign('other') });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0]?.[0]).toBe('HMAC');
    // A malformed signature is refused before any key is made.
    await verifyHmacSignature({ secret: SECRET, body: BODY, signature: 'nope' });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  test('is false, not a rejection, when Web Crypto refuses', async () => {
    const verify = spyOn(crypto.subtle, 'verify').mockRejectedValue(new Error('boom'));
    spies.push(verify);
    expect(await verifyHmacSignature({ secret: SECRET, body: BODY, signature: sign(BODY) })).toBe(
      false,
    );
  });
});
