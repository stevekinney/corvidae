/**
 * COR-1968 — a cancelled upload is aborted on the Bureau, over the real `bureau.assets.uploads.*`
 * routes of a running host. `uploadAsset` is run against the host and cancelled after its first
 * chunk; the session it left open must be gone, so a later append to it is a `NotFound`, while an
 * upload nobody cancelled still takes the same append.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '@lostgradient/testing';
import { HttpClientError } from '@lostgradient/weft';

import { UPLOAD_CHUNK_BYTES, uploadAsset } from '../lib/bureau-assets.ts';
import { callBureau, type Fetcher } from '../lib/bureau-client.ts';
import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function start(): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-upload-abort-'));
  directories.push(home);
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  hosts.push(host);
  return host;
}

/** `fetch` aimed at `host`: the page's relative Bureau paths, resolved against its origin. */
function fetcherFor(host: Host): Fetcher {
  return (input, init) => fetch(new URL(typeof input === 'string' ? input : '', host.url), init);
}

const CHUNK = btoa('x');

/** The fault an append to `uploadId` raises, or `undefined` when the Bureau took the chunk. */
async function appendFault(host: Host, uploadId: string): Promise<string | undefined> {
  try {
    await callBureau(
      'bureau.assets.uploads.append',
      { uploadId, chunk: CHUNK },
      { fetch: fetcherFor(host) },
    );
    return undefined;
  } catch (error) {
    if (!(error instanceof HttpClientError)) throw error;
    return String(error.data?.['weftCode']);
  }
}

describe('a cancelled upload', () => {
  test('is aborted on the Bureau, so its session takes no more chunks', async () => {
    const host = await start();
    const send = fetcherFor(host);
    const controller = new AbortController();
    const methods: string[] = [];
    let uploadId = '';
    const cancelling: Fetcher = async (input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        method: string;
        params: { uploadId?: string };
      };
      methods.push(body.method);
      const response = await send(input, init);
      if (body.method === 'bureau.assets.uploads.append') {
        uploadId = body.params.uploadId ?? '';
        controller.abort();
      }
      return response;
    };

    const file = new File([new Uint8Array(UPLOAD_CHUNK_BYTES * 2)], 'big.bin', {
      type: 'application/octet-stream',
    });
    const cancelled = await rejectionOf(
      uploadAsset(file, { fetch: cancelling, signal: controller.signal }),
    );
    expect(cancelled).toBeInstanceOf(Error);

    expect(methods).toEqual([
      'bureau.assets.uploads.create',
      'bureau.assets.uploads.append',
      'bureau.assets.uploads.abort',
    ]);
    expect(uploadId).not.toBe('');
    expect(await appendFault(host, uploadId)).toBe('NotFound');
    // The session is already gone, which the Bureau answers as `aborted: false`.
    const again = await callBureau('bureau.assets.uploads.abort', { uploadId }, { fetch: send });
    expect(again).toEqual({ uploadId, aborted: false });
  });

  test('control: an upload that was not aborted is still open and takes a chunk', async () => {
    const host = await start();
    const created = (await callBureau(
      'bureau.assets.uploads.create',
      { declaredByteLength: 4 },
      { fetch: fetcherFor(host) },
    )) as { uploadId: string };

    expect(await appendFault(host, created.uploadId)).toBeUndefined();
  });
});
