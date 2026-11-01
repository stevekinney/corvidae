/**
 * COR-1548 — uploading a file to the Bureau's managed assets over `bureau.assets.uploads.*`: the
 * bytes go in chunks small enough for the host's request body limit, the answer is the asset's
 * identifier, and every fault the three operations can raise is named for the person.
 */
import { rejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';

import {
  AttachmentUploadError,
  UPLOAD_CHUNK_BYTES,
  uploadAsset,
  type UploadedAsset,
} from './bureau-assets.ts';
import type { Fetcher } from './bureau-client.ts';

/** The default JSON body limit the host serves (`packages/weft/src/server/json-rpc-http.ts`). */
const HOST_BODY_LIMIT_BYTES = 1024 * 1024;

type Answer = (params: Record<string, unknown>, init: RequestInit) => Response;

function view(overrides: Record<string, unknown> = {}) {
  return {
    uploadId: 'upload-1',
    declaredMediaType: null,
    declaredByteLength: 1,
    receivedBytes: 0,
    state: 'open',
    createdAt: '2026-10-19T00:00:00.000Z',
    expiresAt: '2026-10-19T01:00:00.000Z',
    ...overrides,
  };
}

const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });
const fault = (httpStatus: number, weftCode: string, data: Record<string, unknown> = {}) =>
  Response.json({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: 'No.', data: { weftCode, httpStatus, ...data } },
  });

function bureau(answers: Record<string, Answer>) {
  const calls: Array<{ method: string; params: Record<string, unknown>; bodyLength: number }> = [];
  const send: Fetcher = async (_input, init) => {
    const text = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(text) as { method: string; params: Record<string, unknown> };
    calls.push({ method: body.method, params: body.params, bodyLength: text.length });
    const answer = answers[body.method];
    if (answer === undefined) throw new Error(`Unexpected ${body.method}`);
    return answer(body.params, init ?? {});
  };
  return { calls, send };
}

const happy: Record<string, Answer> = {
  'bureau.assets.uploads.create': () => ok(view()),
  'bureau.assets.uploads.append': () => ok(view()),
  'bureau.assets.uploads.complete': () =>
    ok({ assetId: 'asset-7', state: 'available', mediaType: 'image/png' }),
};

const png = (size = 8) =>
  new File([new Uint8Array(size).fill(7)], 'photo.png', { type: 'image/png' });

async function failure(promise: Promise<UploadedAsset>): Promise<AttachmentUploadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AttachmentUploadError) return error;
    throw error;
  }
  throw new Error('Expected the upload to fail.');
}

describe('uploadAsset', () => {
  test('creates a session for the file’s length and type, appends its bytes, and completes it', async () => {
    const { calls, send } = bureau(happy);

    const uploaded = await uploadAsset(png(8), { fetch: send });

    expect(uploaded).toEqual({ assetId: 'asset-7', mediaType: 'image/png' });
    expect(calls.map((call) => call.method)).toEqual([
      'bureau.assets.uploads.create',
      'bureau.assets.uploads.append',
      'bureau.assets.uploads.complete',
    ]);
    expect(calls[0]?.params).toEqual({ declaredByteLength: 8, declaredMediaType: 'image/png' });
    expect(calls[1]?.params).toEqual({
      uploadId: 'upload-1',
      chunk: btoa(String.fromCharCode(...new Uint8Array(8).fill(7))),
    });
    expect(calls[2]?.params).toEqual({ uploadId: 'upload-1' });
  });

  test('declares no media type for a file the browser could not name', async () => {
    const { calls, send } = bureau(happy);

    await uploadAsset(new File([new Uint8Array(2)], 'blob'), { fetch: send });

    expect(calls[0]?.params).toEqual({ declaredByteLength: 2 });
  });

  test('sends 512 KiB of raw bytes per append, and no request body reaches the host’s limit', async () => {
    expect(UPLOAD_CHUNK_BYTES).toBe(512 * 1024);
    const { calls, send } = bureau(happy);

    await uploadAsset(png(UPLOAD_CHUNK_BYTES * 2 + 5), { fetch: send });

    const appends = calls.filter((call) => call.method === 'bureau.assets.uploads.append');
    expect(appends).toHaveLength(3);
    for (const append of appends)
      expect(append.bodyLength).toBeLessThanOrEqual(HOST_BODY_LIMIT_BYTES);
    const decoded = appends.map((append) => atob(String(append.params['chunk'])).length);
    expect(decoded).toEqual([UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, 5]);
  });

  test('stops at once, sends no more bytes, and aborts the open upload, when the signal aborts', async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    const { calls, send } = bureau({
      ...happy,
      'bureau.assets.uploads.append': () => {
        controller.abort();
        return ok(view());
      },
      'bureau.assets.uploads.abort': (_params, init) => {
        signals.push(init.signal);
        return ok({ uploadId: 'upload-1', aborted: true });
      },
    });

    const aborted = await rejectionOf(
      uploadAsset(png(UPLOAD_CHUNK_BYTES * 2), { fetch: send, signal: controller.signal }),
    );

    // The signal's own reason, not a fault to tell the person about.
    expect(aborted).not.toBeInstanceOf(AttachmentUploadError);
    expect(aborted).toBeInstanceOf(Error);

    expect(calls.map((call) => call.method)).toEqual([
      'bureau.assets.uploads.create',
      'bureau.assets.uploads.append',
      'bureau.assets.uploads.abort',
    ]);
    expect(calls[2]?.params).toEqual({ uploadId: 'upload-1' });
    // The abort goes under no signal: the upload's own has already fired.
    expect(signals).toEqual([undefined]);
  });

  test('still rejects with the cancellation when the Bureau cannot abort the upload', async () => {
    const controller = new AbortController();
    const { calls, send } = bureau({
      ...happy,
      'bureau.assets.uploads.append': () => {
        controller.abort();
        return ok(view());
      },
      'bureau.assets.uploads.abort': () => fault(503, 'Unavailable'),
    });

    const aborted = await rejectionOf(
      uploadAsset(png(8), { fetch: send, signal: controller.signal }),
    );

    expect(aborted).not.toBeInstanceOf(AttachmentUploadError);
    expect(calls.at(-1)?.method).toBe('bureau.assets.uploads.abort');
  });

  test('aborts the open upload when the signal aborts while a chunk is being sent', async () => {
    const controller = new AbortController();
    const { calls, send } = bureau({
      ...happy,
      'bureau.assets.uploads.complete': () => {
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
      'bureau.assets.uploads.abort': () => ok({ uploadId: 'upload-1', aborted: false }),
    });

    const aborted = await rejectionOf(
      uploadAsset(png(8), { fetch: send, signal: controller.signal }),
    );

    expect(aborted).toBeInstanceOf(DOMException);
    expect(calls.map((call) => call.method)).toEqual([
      'bureau.assets.uploads.create',
      'bureau.assets.uploads.append',
      'bureau.assets.uploads.complete',
      'bureau.assets.uploads.abort',
    ]);
  });

  test('does not ask the Bureau to abort an upload that failed for another reason', async () => {
    const { calls, send } = bureau({
      ...happy,
      'bureau.assets.uploads.append': () => fault(404, 'NotFound'),
    });

    await failure(uploadAsset(png(8), { fetch: send }));

    expect(calls.map((call) => call.method)).not.toContain('bureau.assets.uploads.abort');
  });

  test('sends nothing when the signal is aborted before the upload starts', async () => {
    const { calls, send } = bureau(happy);

    await rejectionOf(uploadAsset(png(8), { fetch: send, signal: AbortSignal.abort() }));

    expect(calls).toEqual([]);
  });

  test('refuses an empty file without calling the Bureau', async () => {
    const { calls, send } = bureau(happy);

    const error = await failure(uploadAsset(new File([], 'empty.txt'), { fetch: send }));

    expect(error.kind).toBe('upload-failed');
    expect(calls).toEqual([]);
  });
});

describe('the faults of an upload', () => {
  test('a 413 on an append is a failed upload', async () => {
    const { send } = bureau({
      ...happy,
      'bureau.assets.uploads.append': () => new Response('Too large', { status: 413 }),
    });

    const error = await failure(uploadAsset(png(), { fetch: send }));
    expect(error.kind).toBe('upload-failed');
  });

  test.each(['bureau.assets.uploads.append', 'bureau.assets.uploads.complete'] as const)(
    'a NotFound from %s is an expired upload',
    async (method) => {
      const { send } = bureau({ ...happy, [method]: () => fault(404, 'NotFound') });

      const error = await failure(uploadAsset(png(), { fetch: send }));
      expect(error.kind).toBe('expired');
    },
  );

  test.each(['safety-gate-flagged', 'media-type-mismatch'])(
    'a completion refused for %s is a rejected file',
    async (reason) => {
      const { send } = bureau({
        ...happy,
        'bureau.assets.uploads.complete': () => fault(422, 'Unprocessable', { reason }),
      });

      const error = await failure(uploadAsset(png(), { fetch: send }));
      expect(error.kind).toBe('rejected');
    },
  );

  test.each([
    ['upload-incomplete', 422, 'Unprocessable'],
    ['media-type-not-allowed', 422, 'Unprocessable'],
    ['per-part-limit-exceeded', 422, 'Unprocessable'],
    ['asset-expired', 503, 'Unavailable'],
  ] as const)('a %s fault is a failed upload', async (reason, status, code) => {
    const { send } = bureau({
      ...happy,
      'bureau.assets.uploads.complete': () => fault(status, code, { reason }),
    });

    const error = await failure(uploadAsset(png(), { fetch: send }));
    expect(error.kind).toBe('upload-failed');
  });

  test.each(['bureau.assets.uploads.append', 'bureau.assets.uploads.complete'] as const)(
    'a 404 that is not a NotFound fault, such as MethodNotFound, from %s is a failed upload, not an expired one',
    async (method) => {
      const { send } = bureau({ ...happy, [method]: () => fault(404, 'MethodNotFound') });

      const error = await failure(uploadAsset(png(), { fetch: send }));

      expect(error.kind).toBe('upload-failed');
    },
  );

  test('a bare 404 with no fault body is a failed upload, not an expired one', async () => {
    const { send } = bureau({
      ...happy,
      'bureau.assets.uploads.append': () => new Response('Not found', { status: 404 }),
    });

    const error = await failure(uploadAsset(png(), { fetch: send }));

    expect(error.kind).toBe('upload-failed');
  });

  test('a NotFound from create is a failed upload, not an expired one', async () => {
    const { send } = bureau({
      ...happy,
      'bureau.assets.uploads.create': () => fault(404, 'NotFound'),
    });

    const error = await failure(uploadAsset(png(), { fetch: send }));
    expect(error.kind).toBe('upload-failed');
  });
});
