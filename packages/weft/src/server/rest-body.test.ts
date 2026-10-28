import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { readOptionalRestJsonBody, readRestBodyBounded } from './rest-body.ts';

describe('readRestBodyBounded', () => {
  it('preserves the payload-too-large fault when stream cancellation rejects', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        throw new Error('cancel failed');
      },
    });

    expect(
      await rejectionOf(
        readRestBodyBounded(
          new Request('http://localhost/body', {
            method: 'POST',
            body: stream,
          }),
          { maxBodyBytes: 1 },
        ),
      ),
    ).toMatchObject({
      code: 'PayloadTooLarge',
      message: 'Payload Too Large',
      data: { maxBytes: 1 },
    });
  });
});

describe('readRestBodyBounded content-length validation', () => {
  it('rejects a non-numeric content-length header as invalid params', async () => {
    const request = new Request('http://localhost/body', {
      method: 'POST',
      headers: { 'content-length': '12abc' },
      body: 'x',
    });

    expect(await rejectionOf(readRestBodyBounded(request))).toMatchObject({
      code: 'InvalidParams',
      message: 'Invalid Content-Length header',
      data: { issues: [] },
    });
  });

  it('rejects a content-length too large to be a safe integer as invalid params', async () => {
    const request = new Request('http://localhost/body', {
      method: 'POST',
      headers: { 'content-length': '9'.repeat(30) },
      body: 'x',
    });

    expect(await rejectionOf(readRestBodyBounded(request))).toMatchObject({
      code: 'InvalidParams',
      message: 'Invalid Content-Length header',
    });
  });
});

describe('readOptionalRestJsonBody', () => {
  it('returns undefined for an empty JSON body', async () => {
    expect(
      await readOptionalRestJsonBody(
        new Request('http://localhost/body', {
          method: 'POST',
          body: '  ',
        }),
      ),
    ).toBeUndefined();
  });

  it('parses a non-empty JSON body', async () => {
    expect(
      await readOptionalRestJsonBody(
        new Request('http://localhost/body', {
          method: 'POST',
          body: '{"ok":true}',
        }),
      ),
    ).toEqual({ ok: true });
  });
});
