/**
 * COR-1609 — an upload session admits exactly one asset, whatever the number of processes and
 * retries. Each cross-process case runs two Bureaus over one SQLite file: the first parked
 * between a read and the write that depends on it (`holdAssetStorageCall`), the second finishing
 * in the gap.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  createDurableAssetStorageFixture,
  type DurableAssetStorageFixture,
} from '../test/asset-storage-fixtures';
import {
  alice,
  type AssetHarness,
  base64Of,
  bob,
  createAssetHarness,
  textBytes,
} from '../testing/asset-fixtures.test-support';
import { holdAssetStorageCall } from '../testing/asset-storage-hold.test-support';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  AssetConflictError,
  AssetNotFoundError,
  type AssetStorage,
  type BureauAssetOptions,
} from '../index';
import type { UploadSessionRecord } from './uploads';
import { KEYS } from './records';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface Opened extends AssetHarness {
  readonly storage: AssetStorage;
}

async function open(
  options: Omit<BureauAssetOptions, 'storage'> & { readonly storage: AssetStorage },
  seed: string,
): Promise<Opened> {
  const runtime = createManualRuntimeServices({ identifierSeed: seed });
  const opened = await createAssetHarness(options, runtime);
  let closed = false;
  cleanups.push(async () => {
    if (closed) return;
    closed = true;
    await opened.harness.close();
  });
  return { ...opened, storage: options.storage };
}

/** Two Bureaus over one SQLite file; the first reads through a storage the test can park. */
async function twoBureausOverOneStore(
  hold: (inner: AssetStorage) => AssetStorage,
  options: Omit<BureauAssetOptions, 'storage'> = {},
): Promise<{ readonly first: Opened; readonly second: Opened; readonly shared: AssetStorage }> {
  const firstRuntime = createManualRuntimeServices({ identifierSeed: 'first-process' });
  const firstStore: DurableAssetStorageFixture = createDurableAssetStorageFixture({
    runtime: firstRuntime,
  });
  cleanups.push(() => firstStore.dispose());
  const secondStore = createDurableAssetStorageFixture({
    runtime: createManualRuntimeServices(),
    path: firstStore.path,
  });
  cleanups.push(() => secondStore.dispose());
  const first = await open({ ...options, storage: hold(firstStore.storage) }, 'first-process');
  const second = await open({ ...options, storage: secondStore.storage }, 'second-process');
  return { first, second, shared: secondStore.storage };
}

/** Every chunk listing starts here; the session id follows. */
const CHUNK_PREFIX = KEYS.chunkRootPrefix;

const uploadOf = (uploadId: string) => ({ kind: 'upload' as const, uploadId });

async function sessionRecord(
  storage: AssetStorage,
  uploadId: string,
): Promise<UploadSessionRecord | undefined> {
  const raw = await storage.get(KEYS.upload(uploadId));
  return raw === null ? undefined : (JSON.parse(raw) as UploadSessionRecord);
}

/** The held Bureau's storage is wrapped by `holdAssetStorageCall`; `hold` is set once it has been built. */
function parked(
  verb: 'get' | 'list',
  matches: (key: string) => boolean,
): {
  readonly wrap: (inner: AssetStorage) => AssetStorage;
  readonly hold: () => ReturnType<typeof holdAssetStorageCall>;
} {
  let hold: ReturnType<typeof holdAssetStorageCall> | undefined;
  return {
    wrap: (inner) => {
      hold = holdAssetStorageCall(inner, verb, matches);
      return hold.storage;
    },
    hold: () => hold!,
  };
}

describe('appends across two processes', () => {
  it('serializes appends through storage: the held append loses with Conflict and stores nothing', async () => {
    const parking = parked('get', (key) => key.startsWith(KEYS.uploadPrefix));
    const { first, second, shared } = await twoBureausOverOneStore(parking.wrap);
    const session = await second.assets.beginUpload(alice, { declaredByteLength: 4 });

    parking.hold().arm();
    const losing = rejectionOf(first.assets.appendUpload(session.uploadId, alice, textBytes('aa')));
    await parking.hold().reached;
    // The second process appends while the first holds a read of the session that is now stale.
    expect(
      (await second.assets.appendUpload(session.uploadId, alice, textBytes('bb'))).receivedBytes,
    ).toBe(2);
    parking.hold().release();

    expect(await losing).toBeInstanceOf(AssetConflictError);
    // Nothing of the losing append is stored: one chunk, the winner's, and a record that counts it.
    expect(await shared.list(KEYS.chunkPrefix(session.uploadId))).toEqual([
      KEYS.chunk(session.uploadId, 0),
    ]);
    expect(await shared.get(KEYS.chunk(session.uploadId, 0))).toBe(base64Of(textBytes('bb')));
    expect(await sessionRecord(shared, session.uploadId)).toMatchObject({
      receivedBytes: 2,
      chunkCount: 1,
    });

    // The assembled bytes are exactly what was acknowledged.
    await second.assets.appendUpload(session.uploadId, alice, textBytes('cc'));
    const admission = await second.assets.admit({ source: uploadOf(session.uploadId) }, alice);
    expect(await admission.work.result()).toMatchObject({ outcome: 'completed' });
    expect((await second.assets.resolve(admission.source, alice)).content).toEqual({
      kind: 'bytes',
      bytes: textBytes('bbcc'),
    });
  });
});

describe('completions across two processes', () => {
  it('claims the session before reading chunks: two overlapping completions admit one asset, and the loser answers Conflict with no orphan', async () => {
    const parking = parked('get', (key) => key.startsWith(KEYS.uploadPrefix));
    const { first, second, shared } = await twoBureausOverOneStore(parking.wrap);
    const session = await second.assets.beginUpload(alice, { declaredByteLength: 4 });
    await second.assets.appendUpload(session.uploadId, alice, textBytes('abcd'));

    parking.hold().arm();
    const losing = rejectionOf(first.assets.admit({ source: uploadOf(session.uploadId) }, alice));
    await parking.hold().reached;
    const winning = await second.assets.admit({ source: uploadOf(session.uploadId) }, alice);
    expect(await winning.work.result()).toMatchObject({ outcome: 'completed' });
    parking.hold().release();

    expect(await losing).toBeInstanceOf(AssetConflictError);
    // One asset record, the winner's: the loser persisted nothing to reject.
    expect(await shared.list(KEYS.recordPrefix)).toEqual([KEYS.record(winning.assetId)]);
    expect((await first.assets.resolve(winning.source, alice)).content).toEqual({
      kind: 'bytes',
      bytes: textBytes('abcd'),
    });
  });

  it('answers a completion that arrives while the first is in flight with Conflict, from either process', async () => {
    const parking = parked('list', (prefix) => prefix.startsWith(CHUNK_PREFIX));
    const { first, second } = await twoBureausOverOneStore(parking.wrap);
    const session = await second.assets.beginUpload(alice, { declaredByteLength: 4 });
    await second.assets.appendUpload(session.uploadId, alice, textBytes('abcd'));

    parking.hold().arm();
    const inFlight = await first.assets.admit({ source: uploadOf(session.uploadId) }, alice);
    // The first has claimed the session and is parked listing its chunks.
    await parking.hold().reached;

    expect(
      await rejectionOf(second.assets.admit({ source: uploadOf(session.uploadId) }, alice)),
    ).toBeInstanceOf(AssetConflictError);
    expect(
      await rejectionOf(second.assets.completedUploadAssetId(session.uploadId, alice)),
    ).toBeInstanceOf(AssetConflictError);
    parking.hold().release();
    expect(await inFlight.work.result()).toMatchObject({ outcome: 'completed' });
    expect(await second.assets.completedUploadAssetId(session.uploadId, alice)).toBe(
      inFlight.assetId,
    );
    // Admitting a session that has completed is as much a conflict as admitting one being completed.
    expect(
      await rejectionOf(first.assets.admit({ source: uploadOf(session.uploadId) }, alice)),
    ).toBeInstanceOf(AssetConflictError);
  });
});

describe('the session record', () => {
  async function single(
    options: Omit<BureauAssetOptions, 'storage'> = {},
    wrap: (inner: AssetStorage) => AssetStorage = (inner) => inner,
  ): Promise<Opened> {
    const runtime = createManualRuntimeServices({ identifierSeed: 'only-process' });
    const fixture = createDurableAssetStorageFixture({ runtime });
    cleanups.push(() => fixture.dispose());
    return open({ ...options, storage: wrap(fixture.storage) }, 'only-process');
  }

  it('keeps a terminal completed record holding the assetId, with its chunks deleted, and replays the asset', async () => {
    const opened = await single();
    const session = await opened.assets.beginUpload(alice, { declaredByteLength: 4 });
    await opened.assets.appendUpload(session.uploadId, alice, textBytes('ab'));
    await opened.assets.appendUpload(session.uploadId, alice, textBytes('cd'));
    const admission = await opened.assets.admit({ source: uploadOf(session.uploadId) }, alice);
    expect(await admission.work.result()).toMatchObject({ outcome: 'completed' });

    expect(await sessionRecord(opened.storage, session.uploadId)).toMatchObject({
      state: 'completed',
      assetId: admission.assetId,
      receivedBytes: 4,
    });
    expect(await opened.storage.list(KEYS.chunkPrefix(session.uploadId))).toEqual([]);
    // A retry asks for the settled outcome and is told which asset it is; the session is no longer open.
    expect(await opened.assets.completedUploadAssetId(session.uploadId, alice)).toBe(
      admission.assetId,
    );
    expect(await rejectionOf(opened.assets.inspectUpload(session.uploadId, alice))).toBeInstanceOf(
      AssetNotFoundError,
    );
    // Only the owner is told: a stranger reads it as missing.
    expect(
      await rejectionOf(opened.assets.completedUploadAssetId(session.uploadId, bob)),
    ).toBeInstanceOf(AssetNotFoundError);
    // An append to it is refused as to any session that is not open.
    expect(
      await rejectionOf(opened.assets.appendUpload(session.uploadId, alice, textBytes('e'))),
    ).toBeInstanceOf(AssetNotFoundError);
  });

  it('answers NotFound to a retry once the expiry collection has purged the terminal record', async () => {
    const opened = await single({ policy: { uploadSessionTtlMilliseconds: 60_000 } });
    const session = await opened.assets.beginUpload(alice, { declaredByteLength: 2 });
    await opened.assets.appendUpload(session.uploadId, alice, textBytes('ab'));
    const admission = await opened.assets.admit({ source: uploadOf(session.uploadId) }, alice);
    await admission.work.result();

    await opened.runtime.advance(59_999);
    const early = await opened.assets.collectGarbage().result();
    expect(early).toMatchObject({ outcome: 'completed', value: { purgedUploads: [] } });
    expect(await opened.assets.completedUploadAssetId(session.uploadId, alice)).toBe(
      admission.assetId,
    );

    await opened.runtime.advance(1);
    const purge = await opened.assets.collectGarbage().result();
    expect(purge).toMatchObject({
      outcome: 'completed',
      value: { purgedUploads: [session.uploadId] },
    });
    expect(await sessionRecord(opened.storage, session.uploadId)).toBeUndefined();
    expect(
      await rejectionOf(opened.assets.completedUploadAssetId(session.uploadId, alice)),
    ).toBeInstanceOf(AssetNotFoundError);
    // The asset itself outlives its session.
    expect(await opened.assets.inspect(admission.assetId, alice)).toMatchObject({
      state: 'available',
    });
  });

  it('reopens an incomplete upload, so it stays appendable', async () => {
    const opened = await single();
    const session = await opened.assets.beginUpload(alice, { declaredByteLength: 4 });
    await opened.assets.appendUpload(session.uploadId, alice, textBytes('ab'));
    const short = await opened.assets.admit({ source: uploadOf(session.uploadId) }, alice);
    expect(await short.work.result()).toMatchObject({
      outcome: 'failed',
      rejection: { code: 'upload-incomplete' },
    });

    const reopened = await sessionRecord(opened.storage, session.uploadId);
    expect(reopened?.state).toBe('open');
    expect(reopened).not.toHaveProperty('assetId');
    expect(await opened.assets.completedUploadAssetId(session.uploadId, alice)).toBeUndefined();
    expect(
      await opened.assets.appendUpload(session.uploadId, alice, textBytes('cd')),
    ).toMatchObject({
      receivedBytes: 4,
      state: 'open',
    });
    const whole = await opened.assets.admit({ source: uploadOf(session.uploadId) }, alice);
    expect(await whole.work.result()).toMatchObject({ outcome: 'completed' });
    expect((await opened.assets.resolve(whole.source, alice)).content).toEqual({
      kind: 'bytes',
      bytes: textBytes('abcd'),
    });
  });

  it('reopens a session whose claimer was aborted before it read the chunks', async () => {
    const parking = parked('list', (prefix) => prefix.startsWith(CHUNK_PREFIX));
    const opened = await single({}, parking.wrap);
    const session = await opened.assets.beginUpload(alice, { declaredByteLength: 2 });
    await opened.assets.appendUpload(session.uploadId, alice, textBytes('ab'));

    parking.hold().arm();
    const admission = await opened.assets.admit({ source: uploadOf(session.uploadId) }, alice);
    // Claimed, and parked listing the chunks it has not yet read.
    await parking.hold().reached;
    expect((await sessionRecord(opened.storage, session.uploadId))?.state).toBe('completing');
    admission.work.abort('test');
    expect(await admission.work.result()).toMatchObject({ outcome: 'aborted' });
    parking.hold().release();

    expect((await sessionRecord(opened.storage, session.uploadId))?.state).toBe('open');
    const retry = await opened.assets.admit({ source: uploadOf(session.uploadId) }, alice);
    expect(await retry.work.result()).toMatchObject({ outcome: 'completed' });
  });

  it('purges an expired completing session, whose claimer died, with its chunks', async () => {
    const opened = await single({ policy: { uploadSessionTtlMilliseconds: 60_000 } });
    const session = await opened.assets.beginUpload(alice, { declaredByteLength: 4 });
    await opened.assets.appendUpload(session.uploadId, alice, textBytes('ab'));
    // What a claimer that died after claiming leaves behind.
    const stored = (await sessionRecord(opened.storage, session.uploadId))!;
    await opened.storage.set(
      KEYS.upload(session.uploadId),
      JSON.stringify({ ...stored, state: 'completing', assetId: 'asset-dead' }),
    );

    await opened.runtime.advance(59_999);
    const early = await opened.assets.collectGarbage().result();
    expect(early).toMatchObject({ value: { purgedUploads: [] } });
    expect(
      await rejectionOf(opened.assets.completedUploadAssetId(session.uploadId, alice)),
    ).toBeInstanceOf(AssetConflictError);

    await opened.runtime.advance(1);
    const purge = await opened.assets.collectGarbage().result();
    expect(purge).toMatchObject({ value: { purgedUploads: [session.uploadId] } });
    expect(await opened.storage.list(KEYS.uploadPrefix)).toEqual([]);
    expect(await opened.storage.list(KEYS.chunkPrefix(session.uploadId))).toEqual([]);
  });

  it('still loads a session record written before the claim existed: state open and no assetId', async () => {
    const opened = await single();
    const uploadId = 'asset-upload-legacy';
    const createdAt = opened.runtime.clock.nowISO();
    // The exact shape `beginUpload` wrote before COR-1609, member for member.
    const legacy = {
      uploadId,
      ownerId: alice.id,
      declaredMediaType: 'text/plain',
      declaredByteLength: 4,
      receivedBytes: 2,
      chunkCount: 1,
      state: 'open',
      createdAt,
      expiresAt: new Date(opened.runtime.clock.now() + 3_600_000).toISOString(),
    };
    await opened.storage.set(KEYS.upload(uploadId), JSON.stringify(legacy));
    await opened.storage.set(KEYS.chunk(uploadId, 0), base64Of(textBytes('ab')));

    expect(await opened.assets.inspectUpload(uploadId, alice)).toMatchObject({
      uploadId,
      receivedBytes: 2,
      state: 'open',
    });
    expect(await opened.assets.completedUploadAssetId(uploadId, alice)).toBeUndefined();
    await opened.assets.appendUpload(uploadId, alice, textBytes('cd'));
    const admission = await opened.assets.admit({ source: uploadOf(uploadId) }, alice);
    expect(await admission.work.result()).toMatchObject({ outcome: 'completed' });
    expect((await opened.assets.resolve(admission.source, alice)).content).toEqual({
      kind: 'bytes',
      bytes: textBytes('abcd'),
    });
    expect(await sessionRecord(opened.storage, uploadId)).toMatchObject({
      state: 'completed',
      assetId: admission.assetId,
    });
  });
});
