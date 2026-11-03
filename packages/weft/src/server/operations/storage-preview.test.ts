import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@lostgradient/storage';
import { Engine } from '../../core/engine.ts';
import { handleRequest } from '../handler.ts';
import { previewStorageValue, STORAGE_VALUE_PREVIEW_BYTES } from './storage-value-preview.ts';
import {
  adminStorageOptions,
  encode,
  request,
  writeOnlyStorageOptions,
} from './storage.test-support.ts';

/** Previews `key` over REST, as the storage browser does. */
async function preview(engine: Engine, key: string, options = adminStorageOptions()) {
  return handleRequest(
    request(`/v1/storage/-/preview?key=${encodeURIComponent(key)}`, { method: 'GET' }),
    engine,
    options,
  );
}

describe('weft.storage.preview', () => {
  it('shows a large non-JSON value as its first 64 KB of text with its whole size, and the raw get still returns every byte', async () => {
    // A 2.1 MB server log, as the sample world's log:server holds.
    const line = '2026-11-02 09:00:02 server started\n';
    const log = line.repeat(Math.ceil(2_100_000 / line.length));
    const storage = new MemoryStorage();
    await storage.put('log:server', encode(log));
    using engine = new Engine({ storage });

    const response = await preview(engine, 'log:server');

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      key: 'log:server',
      byteLength: encode(log).byteLength,
      format: 'text',
      truncated: true,
    });
    expect(body['preview']).toBe(log.slice(0, STORAGE_VALUE_PREVIEW_BYTES));
    expect(STORAGE_VALUE_PREVIEW_BYTES).toBe(65_536);

    const raw = await handleRequest(
      request('/v1/storage/log%3Aserver', { method: 'GET' }),
      engine,
      adminStorageOptions(),
    );
    const bytes = await raw.arrayBuffer();
    expect(bytes.byteLength).toBe(encode(log).byteLength);
  });

  it('judges a small JSON value as json and returns all of it', async () => {
    const storage = new MemoryStorage();
    const value = '{"dismissed":true,"dismissedOn":"2026-11-01T22:12:00Z"}';
    await storage.put('app:welcome-banner', encode(value));
    using engine = new Engine({ storage });

    const response = await preview(engine, 'app:welcome-banner');

    expect(await response.json()).toEqual({
      key: 'app:welcome-banner',
      byteLength: value.length,
      format: 'json',
      preview: value,
      truncated: false,
    });
  });

  it('answers 404 for an absent key and requires storage admin', async () => {
    using engine = new Engine({ storage: new MemoryStorage() });

    const absent = await preview(engine, 'missing');
    const forbidden = await preview(engine, 'missing', writeOnlyStorageOptions());
    expect(absent.status).toBe(404);
    expect(forbidden.status).toBe(403);
  });
});

describe('previewStorageValue', () => {
  it('judges JSON on the whole value, so a JSON value larger than the preview is still json', () => {
    const value = JSON.stringify({ entries: 'x'.repeat(STORAGE_VALUE_PREVIEW_BYTES * 2) });

    const result = previewStorageValue(encode(value));

    expect(result.format).toBe('json');
    expect(result.truncated).toBe(true);
    expect(result.preview?.length).toBe(STORAGE_VALUE_PREVIEW_BYTES);
  });

  it('cuts back to a whole character rather than splitting a multi-byte one', () => {
    // One ASCII byte, then four-byte characters: the 64 KB mark falls inside one of them.
    const value = `a${'😀'.repeat(STORAGE_VALUE_PREVIEW_BYTES / 4 + 1)}`;

    const result = previewStorageValue(encode(value));

    expect(result.format).toBe('text');
    expect(result.truncated).toBe(true);
    // 1 + 4 × 16,383 bytes fit; the next character would end past the mark.
    expect(encode(result.preview ?? '').byteLength).toBe(
      1 + 4 * (STORAGE_VALUE_PREVIEW_BYTES / 4 - 1),
    );
    expect(result.preview?.endsWith('😀')).toBe(true);
  });

  it('gives a binary value no preview, and an empty value is empty text', () => {
    expect(previewStorageValue(new Uint8Array([0xff, 0xfe, 0x00]))).toEqual({
      byteLength: 3,
      format: 'binary',
      preview: null,
      truncated: false,
    });
    expect(previewStorageValue(new Uint8Array())).toEqual({
      byteLength: 0,
      format: 'text',
      preview: '',
      truncated: false,
    });
  });
});
