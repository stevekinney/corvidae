import { describe, expect, it } from 'bun:test';

import { holdAssetStorageCall } from '../../testing/asset-storage-hold.test-support.ts';
import { KEYS } from '../../assets/records.ts';
import { createMemoryAssetStorage } from '../../assets/storage.ts';
import { base64Of, pngBytes, textBytes } from '../../testing/asset-fixtures.test-support.ts';
import { BUREAU_SCOPES } from '../bureau-scopes.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import {
  assetsGetOperation,
  assetsUploadsAbortOperation,
  assetsUploadsAppendOperation,
  assetsUploadsCompleteOperation,
  assetsUploadsCreateOperation,
} from './assets-operations.ts';
import {
  openBureau,
  type OpenedBureau,
  type RpcBody,
  rpc,
} from './management-fixtures.test-support.ts';

const png = pngBytes(4, 3, 64);

async function withBureau<T>(
  options: Parameters<typeof openBureau>[0],
  body: (opened: OpenedBureau) => Promise<T>,
): Promise<T> {
  const opened = await openBureau(options);
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

const create = (
  opened: OpenedBureau,
  key: string,
  params: { declaredByteLength: number; declaredMediaType?: string },
) => rpc(opened.handler, 'bureau.assets.uploads.create', params, key);

const append = (opened: OpenedBureau, key: string, uploadId: string, bytes: Uint8Array) =>
  rpc(opened.handler, 'bureau.assets.uploads.append', { uploadId, chunk: base64Of(bytes) }, key);

const complete = (opened: OpenedBureau, key: string, uploadId: string) =>
  rpc(opened.handler, 'bureau.assets.uploads.complete', { uploadId }, key);

const abort = (opened: OpenedBureau, key: string, uploadId: string) =>
  rpc(opened.handler, 'bureau.assets.uploads.abort', { uploadId }, key);

const get = (opened: OpenedBureau, key: string, assetId: string) =>
  rpc(opened.handler, 'bureau.assets.get', { assetId }, key);

/** An upload of `bytes` through the three upload operations, answered with the completion. */
async function upload(
  opened: OpenedBureau,
  key: string,
  bytes: Uint8Array,
  declaredMediaType?: string,
): Promise<{ readonly uploadId: string; readonly completed: RpcBody }> {
  const created = await create(opened, key, {
    declaredByteLength: bytes.byteLength,
    ...(declaredMediaType === undefined ? {} : { declaredMediaType }),
  });
  const uploadId = created.result!['uploadId'] as string;
  const half = Math.floor(bytes.byteLength / 2);
  await append(opened, key, uploadId, bytes.subarray(0, half));
  await append(opened, key, uploadId, bytes.subarray(half));
  return { uploadId, completed: await complete(opened, key, uploadId) };
}

const httpStatusOf = (body: RpcBody) => body.error?.data?.httpStatus;

describe('the asset operations and their scopes', () => {
  it('are served by the handler, and the two scopes are registered', () => {
    for (const operation of [
      assetsUploadsCreateOperation,
      assetsUploadsAppendOperation,
      assetsUploadsCompleteOperation,
      assetsUploadsAbortOperation,
      assetsGetOperation,
    ]) {
      expect(BUREAU_HANDLER_OPERATIONS).toContain(operation);
    }
    expect(BUREAU_SCOPES).toContain('bureau.assets:read');
    expect(BUREAU_SCOPES).toContain('bureau.assets:write');
  });

  it('answer 403 to a caller without the scope each needs, and a write scope does not imply read', async () => {
    await withBureau({}, async (opened) => {
      const created = await create(opened, 'alice-assets-key', {
        declaredByteLength: png.byteLength,
      });
      const uploadId = created.result!['uploadId'] as string;

      const unscoped = await create(opened, 'alice-key', { declaredByteLength: 4 });
      const readOnly = await create(opened, 'assets-reader-key', { declaredByteLength: 4 });
      const writeOnly = await get(opened, 'assets-writer-key', 'asset-1');
      const unscopedGet = await get(opened, 'alice-key', 'asset-1');
      const unscopedAppend = await append(opened, 'alice-key', uploadId, png);
      const unscopedComplete = await complete(opened, 'alice-key', uploadId);
      const unscopedAbort = await abort(opened, 'alice-key', uploadId);
      const readOnlyAbort = await abort(opened, 'assets-reader-key', uploadId);

      for (const body of [
        unscoped,
        readOnly,
        writeOnly,
        unscopedGet,
        unscopedAppend,
        unscopedComplete,
        unscopedAbort,
        readOnlyAbort,
      ]) {
        expect(httpStatusOf(body)).toBe(403);
      }
      // Refused for want of the scope, it discarded nothing.
      const stillOpen = await append(opened, 'alice-assets-key', uploadId, png);
      expect(stillOpen.result).toMatchObject({ receivedBytes: png.byteLength });
    });
  });
});

describe('an upload through the management plane', () => {
  it('is created, appended to in chunks, completed, and read back as an available descriptor', async () => {
    await withBureau({}, async (opened) => {
      const created = await create(opened, 'alice-assets-key', {
        declaredByteLength: png.byteLength,
        declaredMediaType: 'image/png',
      });
      expect(created.result).toMatchObject({
        declaredByteLength: png.byteLength,
        declaredMediaType: 'image/png',
        receivedBytes: 0,
        state: 'open',
      });
      const uploadId = created.result!['uploadId'] as string;

      const half = Math.floor(png.byteLength / 2);
      const first = await append(opened, 'alice-assets-key', uploadId, png.subarray(0, half));
      expect(first.result).toMatchObject({ uploadId, receivedBytes: half });
      const second = await append(opened, 'alice-assets-key', uploadId, png.subarray(half));
      expect(second.result).toMatchObject({ uploadId, receivedBytes: png.byteLength });

      const completed = await complete(opened, 'alice-assets-key', uploadId);
      expect(completed.result).toMatchObject({
        state: 'available',
        mediaType: 'image/png',
        byteLength: png.byteLength,
        access: 'owner',
      });
      const assetId = completed.result!['assetId'] as string;

      const read = await get(opened, 'alice-assets-key', assetId);
      expect(read.result).toEqual(completed.result);
      // The asset is the caller's under the owner string runs use, so a chat that names it resolves.
      expect(await opened.bureau.assets!.inspect(assetId, { id: 'api-key:alice' })).toMatchObject({
        state: 'available',
      });
    });
  });

  it('does not resolve a completion while the asset is pending, and resolves available once it has settled', async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await withBureau(
      {
        assetPorts: {
          extractMetadata: async () => {
            reached.resolve();
            await release.promise;
            return {};
          },
        },
      },
      async (opened) => {
        const created = await create(opened, 'alice-assets-key', {
          declaredByteLength: png.byteLength,
        });
        const uploadId = created.result!['uploadId'] as string;
        await append(opened, 'alice-assets-key', uploadId, png);

        let settled = false;
        const completing = complete(opened, 'alice-assets-key', uploadId).then((body) => {
          settled = true;
          return body;
        });
        await reached.promise;
        // The asset is pending: its admission has not finished, so the call has not answered.
        await Bun.sleep(20);
        expect(settled).toBe(false);
        const pending = opened.bureau
          .assets!.activeWork()
          .find((work) => work.workKind === 'admission');
        expect(pending).toBeDefined();

        release.resolve();
        const body = await completing;
        expect(body.result).toMatchObject({ state: 'available' });
      },
    );
  });

  it('answers a rejected asset with a typed fault carrying its rejection code', async () => {
    await withBureau({}, async (opened) => {
      const { completed } = await upload(opened, 'alice-assets-key', png, 'application/pdf');

      expect(completed.result).toBeUndefined();
      expect(completed.error?.data).toMatchObject({
        httpStatus: 422,
        reason: 'media-type-mismatch',
      });
      expect(completed.error?.message).toMatch(/was rejected/);
    });
  });

  it('answers a quarantined asset with a typed fault carrying its rejection code', async () => {
    await withBureau(
      {
        assetPorts: {
          safetyGates: [
            { name: 'scanner', inspect: async () => ({ verdict: 'flagged', category: 'malware' }) },
          ],
        },
      },
      async (opened) => {
        const { completed } = await upload(opened, 'alice-assets-key', textBytes('hello world'));

        expect(completed.error?.data).toMatchObject({
          httpStatus: 422,
          reason: 'safety-gate-flagged',
        });
        expect(completed.error?.message).toMatch(/was quarantined/);
        // The fault names the asset and the code, never the category a gate saw.
        expect(JSON.stringify(completed)).not.toContain('malware');
      },
    );
  });

  it('refuses a declared length above the policy ceiling before anything is stored', async () => {
    await withBureau({ assetPolicy: { maxAssetBytes: 16 } }, async (opened) => {
      const refused = await create(opened, 'alice-assets-key', { declaredByteLength: 17 });

      expect(refused.error?.data).toMatchObject({
        httpStatus: 422,
        reason: 'per-part-limit-exceeded',
      });
    });
  });

  it('refuses a chunk that is not base64 as invalid params, and writes nothing', async () => {
    await withBureau({}, async (opened) => {
      const created = await create(opened, 'alice-assets-key', {
        declaredByteLength: png.byteLength,
      });
      const uploadId = created.result!['uploadId'] as string;

      const refused = await rpc(
        opened.handler,
        'bureau.assets.uploads.append',
        { uploadId, chunk: 'not base64 !!' },
        'alice-assets-key',
      );
      expect(httpStatusOf(refused)).toBe(400);

      // The session still holds nothing: the whole asset is what the next append supplies.
      const whole = await append(opened, 'alice-assets-key', uploadId, png);
      expect(whole.result).toMatchObject({ receivedBytes: png.byteLength });
    });
  });
});

describe('a chunk larger than maxRequestBodyBytes', () => {
  it('answers 413 before any write, leaving the session’s received bytes and chunks as they were', async () => {
    const assetStorage = createMemoryAssetStorage();
    await withBureau(
      { handlerOptions: { maxRequestBodyBytes: 600 }, assetStorage },
      async (opened) => {
        const created = await create(opened, 'alice-assets-key', { declaredByteLength: 4096 });
        const uploadId = created.result!['uploadId'] as string;
        const small = new Uint8Array(100).fill(7);
        await append(opened, 'alice-assets-key', uploadId, small);

        const oversized = await opened.handler(
          new Request('http://localhost/jsonrpc', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-API-Key': 'alice-assets-key' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'bureau.assets.uploads.append',
              params: { uploadId, chunk: base64Of(new Uint8Array(1024).fill(9)) },
            }),
          }),
        );
        expect(oversized.status).toBe(413);
        // Nothing was written for it: the session holds the one chunk it held, and its record still
        // says so.
        expect(await assetStorage.list(KEYS.chunkPrefix(uploadId))).toHaveLength(1);
        const record = JSON.parse((await assetStorage.get(KEYS.upload(uploadId)))!) as {
          receivedBytes: number;
          chunkCount: number;
        };
        expect(record).toMatchObject({ receivedBytes: 100, chunkCount: 1 });

        // Only the first chunk is stored: the next append reports its bytes added to the 100 held.
        const next = await append(opened, 'alice-assets-key', uploadId, small);
        expect(next.result).toMatchObject({ receivedBytes: 200 });
      },
    );
  });
});

describe('two principals', () => {
  it('answer another owner’s upload and asset exactly as a missing one, even holding the scopes', async () => {
    const assetStorage = createMemoryAssetStorage();
    await withBureau({ assetStorage }, async (opened) => {
      const { uploadId, completed } = await upload(opened, 'alice-assets-key', png, 'image/png');
      const assetId = completed.result!['assetId'] as string;
      const openUpload = await create(opened, 'alice-assets-key', {
        declaredByteLength: png.byteLength,
      });
      const openUploadId = openUpload.result!['uploadId'] as string;

      const probes = async (key: string, upload: string, asset: string) => [
        await get(opened, key, asset),
        await append(opened, key, upload, png),
        await complete(opened, key, upload),
        await abort(opened, key, upload),
      ];
      const mask = (bodies: RpcBody[], ids: string[]) =>
        JSON.stringify(bodies, null, 1).replaceAll(ids[0]!, '<id>').replaceAll(ids[1]!, '<id>');

      const recordsBefore = await assetStorage.list(KEYS.recordPrefix);

      const bob = await probes('bob-assets-key', openUploadId, assetId);
      const missing = await probes('bob-assets-key', 'upload-missing', 'asset-missing');

      // A completion refused for a session the caller does not hold starts no admission, so it
      // leaves no rejected asset behind under the caller.
      expect(await assetStorage.list(KEYS.recordPrefix)).toEqual(recordsBefore);
      // Every probe but the abort is a fault; an abort that finds nothing of the caller's to
      // discard is the answer for another owner's upload and a missing one alike.
      for (const body of bob.slice(0, 3)) expect(httpStatusOf(body)).toBe(404);
      expect(bob[3]!.result).toEqual({ uploadId: openUploadId, aborted: false });
      expect(mask(bob, [openUploadId, assetId])).toBe(
        mask(missing, ['upload-missing', 'asset-missing']),
      );
      // A completed session is read as missing by anyone but its owner, so a retry cannot be
      // used to learn which asset a stranger's upload became.
      expect(httpStatusOf(await complete(opened, 'bob-assets-key', uploadId))).toBe(404);
      const retried = await complete(opened, 'alice-assets-key', uploadId);
      expect(retried.result).toEqual(completed.result);
      // Alice's own upload was untouched by bob's attempts.
      const own = await append(opened, 'alice-assets-key', openUploadId, png);
      expect(own.result).toMatchObject({ receivedBytes: png.byteLength });
    });
  });
});

describe('a retried or concurrent completion', () => {
  it('answers a retry after success with the same asset, however many times it is asked', async () => {
    await withBureau({}, async (opened) => {
      const { uploadId, completed } = await upload(opened, 'alice-assets-key', png, 'image/png');
      const assetId = completed.result!['assetId'] as string;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const retried = await complete(opened, 'alice-assets-key', uploadId);
        expect(retried.result).toEqual(completed.result);
      }
      // Still exactly one asset: the retries admitted nothing.
      expect(await opened.bureau.assets!.inspect(assetId, { id: 'api-key:alice' })).toMatchObject({
        state: 'available',
      });
    });
  });

  it('replays a rejected completion as the same typed fault', async () => {
    const assetStorage = createMemoryAssetStorage();
    await withBureau({ assetStorage }, async (opened) => {
      const { uploadId, completed } = await upload(
        opened,
        'alice-assets-key',
        png,
        'application/pdf',
      );
      expect(completed.error?.data).toMatchObject({
        httpStatus: 422,
        reason: 'media-type-mismatch',
      });
      const recordsBefore = await assetStorage.list(KEYS.recordPrefix);

      const retried = await complete(opened, 'alice-assets-key', uploadId);

      expect(retried.error?.data).toMatchObject({ httpStatus: 422, reason: 'media-type-mismatch' });
      expect(retried.error?.message).toBe(completed.error?.message);
      expect(await assetStorage.list(KEYS.recordPrefix)).toEqual(recordsBefore);
    });
  });

  it('answers a retry as NotFound once the session has been purged', async () => {
    const assetStorage = createMemoryAssetStorage();
    await withBureau({ assetStorage }, async (opened) => {
      const { uploadId } = await upload(opened, 'alice-assets-key', png, 'image/png');
      // What the expiry collection does to a session past its `expiresAt`.
      await assetStorage.delete(KEYS.upload(uploadId));

      expect(httpStatusOf(await complete(opened, 'alice-assets-key', uploadId))).toBe(404);
    });
  });

  it('answers 409 to a completion that arrives while the first is in flight, and the first still succeeds', async () => {
    const hold = holdAssetStorageCall(createMemoryAssetStorage(), 'list', (prefix) =>
      prefix.startsWith(KEYS.chunkRootPrefix),
    );
    await withBureau({ assetStorage: hold.storage }, async (opened) => {
      const created = await create(opened, 'alice-assets-key', {
        declaredByteLength: png.byteLength,
      });
      const uploadId = created.result!['uploadId'] as string;
      await append(opened, 'alice-assets-key', uploadId, png);

      hold.arm();
      const first = complete(opened, 'alice-assets-key', uploadId);
      await hold.reached;
      const second = await complete(opened, 'alice-assets-key', uploadId);
      hold.release();

      expect(second.result).toBeUndefined();
      expect(second.error?.data).toMatchObject({ httpStatus: 409 });
      const answered = await first;
      expect(answered.result).toMatchObject({ state: 'available' });
    });
  });

  it('answers 409 to a retry that arrives after the terminal write while the asset is still pending', async () => {
    // Parks the first completion at its commit's blob read: its session is `completed`, its asset `pending`.
    const inner = createMemoryAssetStorage();
    const hold = holdAssetStorageCall(inner, 'get', (key) => key.startsWith(KEYS.blobPrefix));
    await withBureau({ assetStorage: hold.storage }, async (opened) => {
      const created = await create(opened, 'alice-assets-key', {
        declaredByteLength: png.byteLength,
      });
      const uploadId = created.result!['uploadId'] as string;
      await append(opened, 'alice-assets-key', uploadId, png);

      hold.arm();
      const first = complete(opened, 'alice-assets-key', uploadId);
      await hold.reached;
      const raw = await inner.get(KEYS.upload(uploadId));
      const retry = await complete(opened, 'alice-assets-key', uploadId);
      hold.release();

      expect(JSON.parse(raw!)).toMatchObject({ state: 'completed' });
      expect(retry.result).toBeUndefined();
      expect(retry.error?.data).toMatchObject({ httpStatus: 409, reason: 'concurrent-write' });
      const answered = await first;
      expect(answered.result).toMatchObject({ state: 'available' });
    });
  });

  it('answers a retry from the asset’s current state: Unavailable once it has been deleted', async () => {
    await withBureau({}, async (opened) => {
      const { uploadId, completed } = await upload(opened, 'alice-assets-key', png, 'image/png');
      const assetId = completed.result!['assetId'] as string;
      await opened.bureau.assets!.delete(assetId, { id: 'api-key:alice' }).result();

      const retried = await complete(opened, 'alice-assets-key', uploadId);

      expect(retried.error?.data).toMatchObject({ reason: 'asset-deleted' });
      expect(retried.error?.message).toBe(`Asset "${assetId}" is deleted`);
    });
  });

  it('names Conflict among the faults append and complete can answer, and says when', () => {
    for (const operation of [assetsUploadsAppendOperation, assetsUploadsCompleteOperation]) {
      expect(operation.producibleFaults).toContain('Conflict');
      expect(operation.description).toMatch(/`Conflict`/);
    }
    expect(assetsUploadsCreateOperation.producibleFaults).not.toContain('Conflict');
    expect(assetsGetOperation.producibleFaults).not.toContain('Conflict');
  });
});

describe('bureau.assets.uploads.abort', () => {
  it('discards an open upload and every chunk it held, and the session no longer exists', async () => {
    const assetStorage = createMemoryAssetStorage();
    await withBureau({ assetStorage }, async (opened) => {
      const created = await create(opened, 'alice-assets-key', {
        declaredByteLength: png.byteLength,
      });
      const uploadId = created.result!['uploadId'] as string;
      const half = Math.floor(png.byteLength / 2);
      await append(opened, 'alice-assets-key', uploadId, png.subarray(0, half));
      expect(await assetStorage.list(KEYS.chunkPrefix(uploadId))).not.toEqual([]);

      const aborted = await abort(opened, 'alice-assets-key', uploadId);

      expect(aborted.result).toEqual({ uploadId, aborted: true });
      expect(await assetStorage.list(KEYS.chunkPrefix(uploadId))).toEqual([]);
      expect(await assetStorage.list(KEYS.uploadPrefix)).toEqual([]);
      const afterwards = await append(opened, 'alice-assets-key', uploadId, png);
      expect(httpStatusOf(afterwards)).toBe(404);
      expect(httpStatusOf(await complete(opened, 'alice-assets-key', uploadId))).toBe(404);
    });
  });

  it('is safe to retry: a second abort, and one of an upload that never existed, discard nothing and are not faults', async () => {
    await withBureau({}, async (opened) => {
      const created = await create(opened, 'alice-assets-key', { declaredByteLength: 4 });
      const uploadId = created.result!['uploadId'] as string;

      const first = await abort(opened, 'alice-assets-key', uploadId);
      const second = await abort(opened, 'alice-assets-key', uploadId);
      const never = await abort(opened, 'alice-assets-key', 'upload-never');

      expect(first.result).toEqual({ uploadId, aborted: true });
      expect(second.result).toEqual({ uploadId, aborted: false });
      expect(never.result).toEqual({ uploadId: 'upload-never', aborted: false });
    });
  });

  it('leaves a completed upload’s asset alone and reports that it aborted nothing', async () => {
    await withBureau({}, async (opened) => {
      const { uploadId, completed } = await upload(opened, 'alice-assets-key', png, 'image/png');
      const assetId = completed.result!['assetId'] as string;

      const aborted = await abort(opened, 'alice-assets-key', uploadId);

      expect(aborted.result).toEqual({ uploadId, aborted: false });
      const asset = await get(opened, 'alice-assets-key', assetId);
      expect(asset.result).toMatchObject({
        assetId,
        state: 'available',
      });
    });
  });

  it('answers a credential that can own nothing as it answers any other miss, without reaching the service', async () => {
    let reached = false;
    const host = {
      assets: {
        abortUpload: async () => {
          reached = true;
        },
      },
    };
    const principal = {
      method: 'api-key',
      subject: undefined,
      scopes: new Set(['bureau.assets:write']),
    };

    const answer = await assetsUploadsAbortOperation.invoke({
      input: { uploadId: 'upload-1' },
      host,
      principal,
    } as never);

    expect(answer).toEqual({ uploadId: 'upload-1', aborted: false });
    expect(reached).toBe(false);
  });

  it('is destructive, needs the write scope, and names Conflict among its faults', () => {
    expect(assetsUploadsAbortOperation.destructive).toBe(true);
    expect(assetsUploadsAbortOperation.producibleFaults).toContain('Conflict');
    expect(assetsUploadsAbortOperation.description).toMatch(/`bureau\.assets:write`/);
  });
});

describe('a completion that reuses an identical asset', () => {
  it('reports the asset it reused, on the first call and on a retry', async () => {
    await withBureau({ assetPolicy: { duplicatePolicy: 'reuse' } }, async (opened) => {
      const first = await upload(opened, 'alice-assets-key', png, 'image/png');
      const firstAssetId = first.completed.result!['assetId'] as string;
      expect(first.completed.result).toMatchObject({ state: 'available' });

      const second = await upload(opened, 'alice-assets-key', png, 'image/png');

      // The admission's own id is retired as a duplicate; the caller is given the asset it can use.
      expect(second.completed.error).toBeUndefined();
      expect(second.completed.result).toMatchObject({ assetId: firstAssetId, state: 'available' });
      const retried = await complete(opened, 'alice-assets-key', second.uploadId);
      expect(retried.result).toEqual(second.completed.result);
    });
  });
});
