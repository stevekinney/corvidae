/**
 * COR-794 — deterministic lifecycle state transitions: retention and expiry,
 * reference renewal, tombstones, legal/audit holds, deduplication ownership,
 * concurrent deletion and resolution, orphan cleanup, partial-upload
 * cleanup, and storage failure.
 *
 * Time only moves through the harness's `ManualRuntimeServices` (the
 * timer-agnostic manual-clock style of `online-evals.test.ts`); a process
 * restart is a new Bureau over a reopened durable fixture, with the clock
 * set backwards the way `audit-trail.ts` handles a restart after a manual
 * clock set; storage failures are injected with operative's fault engine
 * (`createFaultEngine(...).wrapStorage`, the `FaultPlan` vocabulary
 * `packages/operative/src/test/fault-plan.test-d.ts` pins).
 *
 * Every Bureau is closed through `harness.close()` → `assertBureauQuiescent`.
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import { createFaultEngine, type FaultPlan, waitForCondition } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  createDurableAssetStorageFixture,
  createMemoryAssetStorageFixture,
} from '../test/asset-storage-fixtures';
import {
  alice,
  aliceAdministrator,
  type AssetHarness,
  base64Of,
  createAssetHarness,
  deferred,
  pngBytes,
  textBytes,
} from '../testing/asset-fixtures.test-support';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  AssetAdmissionError,
  AssetHeldError,
  AssetNotFoundError,
  AssetServiceClosedError,
  AssetStorageCapacityError,
  AssetUnavailableError,
  type AssetStorage,
  type BureauAssetOptions,
  createMemoryAssetStorage,
} from '../index';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface Opened extends AssetHarness {
  readonly storage: AssetStorage;
  close(): Promise<void>;
}

async function open(
  options: Partial<BureauAssetOptions> = {},
  runtime: ManualRuntimeServices = createManualRuntimeServices(),
): Promise<Opened> {
  const storage = options.storage ?? createMemoryAssetStorageFixture().storage;
  const opened = await createAssetHarness({ ...options, storage }, runtime);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await opened.harness.close();
  };
  cleanups.push(close);
  return { ...opened, storage, close };
}

const PNG = pngBytes(2, 2);

async function admitted(
  opened: Opened,
  request: Parameters<Opened['assets']['admit']>[0] = { source: { kind: 'inline', bytes: PNG } },
) {
  const admission = await opened.assets.admit(request, alice);
  const result = await admission.work.result();
  if (result.outcome !== 'completed')
    throw new Error(`admission failed: ${JSON.stringify(result)}`);
  return admission;
}

async function stateOf(opened: Opened, assetId: string) {
  const descriptor = await opened.assets.inspect(assetId, alice);
  return descriptor.state;
}

async function collect(opened: Opened) {
  const result = await opened.assets.collectGarbage().result();
  if (result.outcome !== 'completed')
    throw new Error(`collection failed: ${JSON.stringify(result)}`);
  return result.value;
}

describe('retention and expiry', () => {
  it('keeps an asset available until its retention floor, then expires it and purges its blob', async () => {
    const opened = await open({ policy: { defaultRetentionMilliseconds: 1_000 } });
    const admission = await admitted(opened);
    const descriptor = await opened.assets.inspect(admission.assetId, alice);
    expect(descriptor.expiresAt).toBe('2020-01-01T00:00:01.000Z');

    await opened.runtime.advance(999);
    expect(await collect(opened)).toMatchObject({ expired: [] });
    expect(await stateOf(opened, admission.assetId)).toBe('available');

    await opened.runtime.advance(1);
    const report = await collect(opened);
    expect(report.expired).toEqual([admission.assetId]);
    expect(report.purgedBlobs).toEqual([descriptor.digest!]);
    expect(await stateOf(opened, admission.assetId)).toBe('expired');
    const error = await rejectionOf(opened.assets.resolve(admission.source, alice));
    expect(error).toBeInstanceOf(AssetUnavailableError);
    expect((error as AssetUnavailableError).state).toBe('expired');
    await opened.close();
  });

  it('renews references monotonically and expires at the latest live claim', async () => {
    const opened = await open({ policy: { defaultRetentionMilliseconds: 1_000 } });
    const admission = await admitted(opened);
    const at = (milliseconds: number) =>
      new Date(Date.parse('2020-01-01T00:00:00.000Z') + milliseconds).toISOString();

    await opened.assets.retain(admission.assetId, aliceAdministrator, {
      holderId: 'run-1',
      until: at(5_000),
    });
    // A renewal never shortens a claim.
    const renewed = await opened.assets.retain(admission.assetId, aliceAdministrator, {
      holderId: 'run-1',
      until: at(3_000),
    });
    expect(renewed.projection === 'privileged' && renewed.retention.references).toEqual([
      { holderId: 'run-1', until: at(5_000) },
    ]);
    const extended = await opened.assets.retain(admission.assetId, alice, {
      holderId: 'run-1',
      until: at(8_000),
    });
    expect(extended.expiresAt).toBe(at(8_000));

    await opened.runtime.advance(7_999);
    expect(await collect(opened)).toMatchObject({ expired: [] });
    const released = await opened.assets.release(admission.assetId, alice, 'run-1');
    expect(released.expiresAt).toBe(at(1_000));
    expect(await collect(opened)).toMatchObject({ expired: [admission.assetId] });
    await opened.close();
  });

  it('expires on request, and an expired asset cannot be retained again', async () => {
    const opened = await open();
    const admission = await admitted(opened);
    const expired = await opened.assets.expire(admission.assetId, aliceAdministrator);
    expect(expired.state).toBe('expired');
    expect(expired.projection === 'privileged' && expired.expiredAt).toBe(
      '2020-01-01T00:00:00.000Z',
    );
    expect(
      await rejectionOf(
        opened.assets.retain(admission.assetId, alice, {
          holderId: 'late',
          until: '2030-01-01T00:00:00.000Z',
        }),
      ),
    ).toBeInstanceOf(AssetUnavailableError);
    await opened.close();
  });

  it('runs collection on its own timer, and clears that timer on shutdown', async () => {
    const opened = await open({
      policy: { defaultRetentionMilliseconds: 100 },
      garbageCollectionIntervalMilliseconds: 1_000,
    });
    const admission = await admitted(opened);
    expect(opened.assets.activeTimers()).toHaveLength(1);

    await opened.runtime.advance(1_000);
    await waitForState(opened, admission.assetId, 'expired');

    await opened.close();
    expect(opened.assets.activeTimers()).toEqual([]);
  });
});

async function waitForState(opened: Opened, assetId: string, state: string) {
  await waitForCondition(
    async () => (await stateOf(opened, assetId)) === state,
    `asset ${assetId} never reached ${state}`,
  );
}

describe('tombstones', () => {
  it('leaves a tombstone that answers "deleted" until its retention elapses, then purges it', async () => {
    const opened = await open({ policy: { tombstoneRetentionMilliseconds: 10_000 } });
    const admission = await admitted(opened);

    const deleted = await opened.assets.delete(admission.assetId, aliceAdministrator).result();
    expect(deleted.outcome === 'completed' && deleted.value).toMatchObject({
      state: 'deleted',
      deletedAt: '2020-01-01T00:00:00.000Z',
      tombstoneUntil: '2020-01-01T00:00:10.000Z',
    });
    const error = await rejectionOf(opened.assets.resolve(admission.source, alice));
    expect((error as AssetUnavailableError).state).toBe('deleted');

    await opened.runtime.advance(9_999);
    expect(await collect(opened)).toMatchObject({ purgedTombstones: [] });
    await opened.runtime.advance(1);
    expect(await collect(opened)).toMatchObject({ purgedTombstones: [admission.assetId] });
    expect(await rejectionOf(opened.assets.inspect(admission.assetId, alice))).toBeInstanceOf(
      AssetNotFoundError,
    );
    await opened.close();
  });

  it('completes a deletion whose provider copy outlives a failure, retrying the copy before purging', async () => {
    let failuresLeft = 2;
    const deletedCopies: string[] = [];
    const opened = await open({
      policy: { tombstoneRetentionMilliseconds: 1_000 },
      ports: {
        providers: {
          openai: {
            download: async () => ({ bytes: new Uint8Array() }),
            upload: async () => ({ providerFileId: 'file-1' }),
            delete: async ({ providerFileId }) => {
              if (failuresLeft-- > 0) throw new Error('provider unavailable');
              deletedCopies.push(providerFileId);
            },
          },
        },
      },
    });
    const admission = await admitted(opened);
    const transfer = opened.assets.transferToProvider(admission.assetId, alice, {
      provider: 'openai',
    });
    expect(await transfer.result()).toMatchObject({ outcome: 'completed' });

    const deletion = await opened.assets.delete(admission.assetId, alice).result();
    expect(deletion.outcome === 'completed' && deletion.value.state).toBe('deleted');
    const copiesOf = async () => {
      const descriptor = await opened.assets.inspect(admission.assetId, aliceAdministrator, {
        projection: 'privileged',
      });
      return descriptor.projection === 'privileged' ? descriptor.providerCopies : undefined;
    };
    expect(await copiesOf()).toEqual([{ provider: 'openai', providerFileId: 'file-1' }]);

    // Past the tombstone's retention, a copy the provider still refuses keeps the tombstone.
    await opened.runtime.advance(5_000);
    expect(await collect(opened)).toMatchObject({ purgedTombstones: [] });
    expect(await copiesOf()).toHaveLength(1);
    // Once the provider confirms the copy is gone, the tombstone purges in the same pass.
    expect(await collect(opened)).toMatchObject({ purgedTombstones: [admission.assetId] });
    expect(deletedCopies).toEqual(['file-1']);
    await opened.close();
  });

  it("deletes an expired asset's provider copy, so its tombstone still purges", async () => {
    const deletedCopies: string[] = [];
    const opened = await open({
      policy: { defaultRetentionMilliseconds: 1_000, tombstoneRetentionMilliseconds: 1_000 },
      ports: {
        providers: {
          openai: {
            download: async () => ({ bytes: new Uint8Array() }),
            upload: async () => ({ providerFileId: 'file-9' }),
            delete: async ({ providerFileId }) => {
              deletedCopies.push(providerFileId);
            },
          },
        },
      },
    });
    const admission = await admitted(opened);
    const transfer = opened.assets.transferToProvider(admission.assetId, alice, {
      provider: 'openai',
    });
    expect(await transfer.result()).toMatchObject({ outcome: 'completed' });

    await opened.runtime.advance(1_000);
    expect(await collect(opened)).toMatchObject({ expired: [admission.assetId] });
    await opened.runtime.advance(1_000);
    expect(await collect(opened)).toMatchObject({ purgedTombstones: [admission.assetId] });
    expect(deletedCopies).toEqual(['file-9']);
    await opened.close();
  });

  it('treats a second, concurrent deletion as the same tombstone', async () => {
    const opened = await open();
    const admission = await admitted(opened);
    const [first, second] = await Promise.all([
      opened.assets.delete(admission.assetId, alice).result(),
      opened.assets.delete(admission.assetId, alice).result(),
    ]);
    expect(first.outcome).toBe('completed');
    expect(second.outcome).toBe('completed');
    const revisions = [first, second].map((result) =>
      result.outcome === 'completed' ? result.value.revision : -1,
    );
    expect(revisions[0]).toBe(revisions[1]);
    await opened.close();
  });
});

describe('legal and audit holds', () => {
  it('blocks deletion and expiry while held, and resumes them once released', async () => {
    const opened = await open({ policy: { defaultRetentionMilliseconds: 1_000 } });
    const admission = await admitted(opened);
    await opened.assets.placeHold(admission.assetId, aliceAdministrator, {
      holdId: 'litigation-1',
      kind: 'legal',
    });

    const deletion = await opened.assets.delete(admission.assetId, alice).result();
    expect(deletion).toMatchObject({ outcome: 'failed', rejection: { code: 'held' } });
    expect(await rejectionOf(opened.assets.expire(admission.assetId, alice))).toBeInstanceOf(
      AssetHeldError,
    );

    await opened.runtime.advance(5_000);
    expect(await collect(opened)).toMatchObject({ expired: [] });
    expect(await stateOf(opened, admission.assetId)).toBe('available');

    await opened.assets.releaseHold(admission.assetId, aliceAdministrator, 'litigation-1');
    expect(await collect(opened)).toMatchObject({ expired: [admission.assetId] });
    await opened.close();
  });

  it('keeps a held quarantined or rejected record past its tombstone retention, and purges it once released', async () => {
    const opened = await open({
      policy: { tombstoneRetentionMilliseconds: 1_000 },
      ports: {
        safetyGates: [
          {
            name: 'flagger',
            inspect: async ({ bytes }) =>
              bytes.byteLength === PNG.byteLength
                ? { verdict: 'flagged', category: 'malware' }
                : { verdict: 'clean' },
          },
        ],
      },
    });
    const quarantined = await opened.assets.admit(
      { source: { kind: 'inline', bytes: PNG } },
      alice,
    );
    expect(await quarantined.work.result()).toMatchObject({
      rejection: { code: 'safety-gate-flagged' },
    });
    const rejected = await opened.assets.admit(
      { source: { kind: 'inline', bytes: textBytes('not a png') }, declaredMediaType: 'image/png' },
      alice,
    );
    expect(await rejected.work.result()).toMatchObject({
      rejection: { code: 'media-type-mismatch' },
    });
    const held = [quarantined.assetId, rejected.assetId];
    for (const assetId of held) {
      await opened.assets.placeHold(assetId, aliceAdministrator, {
        holdId: 'legal-1',
        kind: 'legal',
      });
    }

    await opened.runtime.advance(5_000);
    expect(await collect(opened)).toMatchObject({ purgedTombstones: [] });
    expect(await stateOf(opened, quarantined.assetId)).toBe('quarantined');
    expect(await stateOf(opened, rejected.assetId)).toBe('rejected');

    for (const assetId of held) {
      await opened.assets.releaseHold(assetId, aliceAdministrator, 'legal-1');
    }
    const report = await collect(opened);
    expect(report.purgedTombstones.toSorted((left, right) => left.localeCompare(right))).toEqual(
      held.toSorted((left, right) => left.localeCompare(right)),
    );
    await opened.close();
  });

  it('requires the privileged capability to place or release a hold', async () => {
    const opened = await open();
    const admission = await admitted(opened);
    const error = await rejectionOf(
      opened.assets.placeHold(admission.assetId, alice, { holdId: 'audit-1', kind: 'audit' }),
    );
    expect((error as Error).name).toBe('AssetAccessDeniedError');
    await opened.close();
  });
});

describe('deduplication ownership', () => {
  it('keeps a shared blob until its last owning asset is gone', async () => {
    const opened = await open({ policy: { duplicatePolicy: 'store-separately' } });
    const first = await admitted(opened);
    const second = await admitted(opened);
    const firstDescriptor = await opened.assets.inspect(first.assetId, alice);
    const digest = firstDescriptor.digest!;

    await opened.assets.delete(first.assetId, alice).result();
    expect(await collect(opened)).toMatchObject({ purgedBlobs: [] });
    expect(await opened.assets.resolve(second.source, alice)).toMatchObject({
      content: {
        kind: 'bytes',
        bytes: PNG,
      },
    });

    await opened.assets.delete(second.assetId, alice).result();
    expect(await collect(opened)).toMatchObject({ purgedBlobs: [digest] });
    await opened.close();
  });
});

describe('concurrent deletion and resolution', () => {
  it('lets a resolution that started first finish, and holds the blob until it does', async () => {
    const memory = createMemoryAssetStorageFixture().storage;
    const reached = deferred();
    const release = deferred();
    let park = false;
    const storage: AssetStorage = {
      ...memory,
      durability: memory.durability,
      get: async (key) => {
        if (park && key.startsWith('asset:v1:blob:')) {
          park = false;
          reached.resolve();
          await release.promise;
        }
        return memory.get(key);
      },
    };
    const opened = await open({ storage });
    const admission = await admitted(opened);
    const descriptor = await opened.assets.inspect(admission.assetId, alice);
    const digest = descriptor.digest!;

    park = true;
    const resolution = opened.assets.resolve(admission.source, alice);
    await reached.promise;

    expect(await opened.assets.delete(admission.assetId, alice).result()).toMatchObject({
      outcome: 'completed',
    });
    const whileLeased = await collect(opened);
    expect(whileLeased.leasedBlobs).toEqual([digest]);
    expect(whileLeased.purgedBlobs).toEqual([]);

    release.resolve();
    expect(await resolution).toMatchObject({ content: { kind: 'bytes', bytes: PNG } });
    expect(await collect(opened)).toMatchObject({ purgedBlobs: [digest] });

    const after = await rejectionOf(opened.assets.resolve(admission.source, alice));
    expect((after as AssetUnavailableError).state).toBe('deleted');
    await opened.close();
  });
});

describe('blob reuse during collection', () => {
  it('rewrites a blob a collection was purging when a new admission of the same bytes commits', async () => {
    const memory = createMemoryAssetStorageFixture().storage;
    const parked = deferred();
    const release = deferred();
    let parking = false;
    // Parks collection's delete of the orphaned blob once it has decided to purge it.
    const storage: AssetStorage = {
      ...memory,
      durability: memory.durability,
      delete: async (key) => {
        if (parking && key.startsWith('asset:v1:blob:')) {
          parking = false;
          parked.resolve();
          await release.promise;
        }
        return memory.delete(key);
      },
    };
    const opened = await open({ storage });
    const first = await admitted(opened);
    expect(await opened.assets.delete(first.assetId, alice).result()).toMatchObject({
      outcome: 'completed',
    });

    parking = true;
    const collection = opened.assets.collectGarbage();
    await parked.promise;
    const second = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    for (let turn = 0; turn < 5; turn++) await yieldToPortableEventLoop();
    release.resolve();

    expect(await collection.result()).toMatchObject({ outcome: 'completed' });
    expect(await second.work.result()).toMatchObject({ outcome: 'completed' });
    const resolved = await opened.assets.resolve(second.source, alice);
    expect(resolved.content).toEqual({ kind: 'bytes', bytes: PNG });
    await opened.close();
  });
});

describe('orphan cleanup', () => {
  it('purges a blob no asset owns', async () => {
    const opened = await open();
    const orphanDigest = 'sha256:' + '0'.repeat(64);
    await opened.storage.set(`asset:v1:blob:${orphanDigest}`, base64Of(textBytes('orphan')));
    expect(await collect(opened)).toMatchObject({ purgedBlobs: [orphanDigest] });
    await opened.close();
  });
});

describe('partial-upload cleanup', () => {
  it('purges an upload session that was never completed once its time-to-live elapses', async () => {
    const opened = await open({ policy: { uploadSessionTtlMilliseconds: 60_000 } });
    const session = await opened.assets.beginUpload(alice, { declaredByteLength: 10 });
    await opened.assets.appendUpload(session.uploadId, alice, textBytes('abc'));

    await opened.runtime.advance(59_999);
    expect(await collect(opened)).toMatchObject({ purgedUploads: [] });
    await opened.runtime.advance(1);
    expect(await collect(opened)).toMatchObject({ purgedUploads: [session.uploadId] });
    expect(await opened.storage.list('asset:v1:upload')).toEqual([]);
    expect(
      await rejectionOf(opened.assets.appendUpload(session.uploadId, alice, textBytes('d'))),
    ).toBeInstanceOf(AssetNotFoundError);
    await opened.close();
  });

  it('refuses to admit an upload whose bytes fall short of the declared length', async () => {
    const opened = await open();
    const session = await opened.assets.beginUpload(alice, { declaredByteLength: 10 });
    await opened.assets.appendUpload(session.uploadId, alice, textBytes('abc'));
    const admission = await opened.assets.admit(
      { source: { kind: 'upload', uploadId: session.uploadId } },
      alice,
    );
    expect(await admission.work.result()).toMatchObject({
      rejection: { code: 'upload-incomplete' },
    });
    await opened.close();
  });

  it("refuses an upload declaring more than the asset ceiling or its type's per-part limit, storing nothing", async () => {
    const opened = await open({
      policy: {
        maxAssetBytes: 64,
        limits: [{ scope: 'per-part', modality: 'image', maxBytes: 10 }],
      },
    });
    for (const request of [
      { declaredByteLength: 1_000_000_000 },
      { declaredByteLength: 20, declaredMediaType: 'image/png' },
    ]) {
      const error = await rejectionOf(opened.assets.beginUpload(alice, request));
      expect(error).toBeInstanceOf(AssetAdmissionError);
      expect((error as AssetAdmissionError).rejection.code).toBe('per-part-limit-exceeded');
    }
    expect(await opened.storage.list('asset:v1:upload')).toEqual([]);
    // Within both ceilings, an upload begins as before.
    await opened.assets.beginUpload(alice, { declaredByteLength: 20 });
    await opened.close();
  });

  it('refuses an append racing a completion instead of leaving an orphaned chunk', async () => {
    const memory = createMemoryAssetStorageFixture().storage;
    const parked = deferred();
    const release = deferred();
    let parking = true;
    // Parks the completion's first chunk read, after it has listed the chunks.
    const storage: AssetStorage = {
      ...memory,
      durability: memory.durability,
      get: async (key) => {
        if (parking && key.startsWith('asset:v1:upload-chunk:')) {
          parking = false;
          parked.resolve();
          await release.promise;
        }
        return memory.get(key);
      },
    };
    const opened = await open({ storage });
    const session = await opened.assets.beginUpload(alice, { declaredByteLength: 4 });
    await opened.assets.appendUpload(session.uploadId, alice, textBytes('abcd'));
    const admission = await opened.assets.admit(
      { source: { kind: 'upload', uploadId: session.uploadId } },
      alice,
    );
    await parked.promise;
    const racingAppend = rejectionOf(
      opened.assets.appendUpload(session.uploadId, alice, new Uint8Array()),
    );
    release.resolve();

    expect(await admission.work.result()).toMatchObject({ outcome: 'completed' });
    expect(await racingAppend).toBeInstanceOf(AssetNotFoundError);
    expect(await opened.storage.list('asset:v1:upload-chunk:')).toEqual([]);
    await opened.close();
  });

  it('purges a chunk whose upload session no longer exists', async () => {
    const opened = await open();
    await opened.storage.set('asset:v1:upload-chunk:asset-upload-lost:00000000', base64Of(PNG));
    expect(await collect(opened)).toMatchObject({ purgedUploads: ['asset-upload-lost'] });
    expect(await opened.storage.list('asset:v1:upload-chunk:')).toEqual([]);
    await opened.close();
  });

  it('discards the chunks of an aborted upload at once', async () => {
    const opened = await open();
    const session = await opened.assets.beginUpload(alice, { declaredByteLength: 10 });
    await opened.assets.appendUpload(session.uploadId, alice, textBytes('abc'));
    await opened.assets.abortUpload(session.uploadId, alice);
    expect(await opened.storage.list('asset:v1:upload-chunk:')).toEqual([]);
    await opened.close();
  });
});

describe('storage failure', () => {
  it('rejects an admission whose commit write fails, and collects the bytes it staged', async () => {
    const runtime = createManualRuntimeServices();
    const plan: FaultPlan = [
      {
        id: 'commit-fails',
        boundary: 'before-commit',
        operation: 'storage:conditionalBatch',
        // 1st conditionalBatch persists the pending record; the 2nd is the commit.
        occurrence: { kind: 'nth', n: 2 },
        effect: { kind: 'fail-before-commit', error: new Error('disk full') },
      },
    ];
    const engine = createFaultEngine(plan, runtime);
    const memory = createMemoryAssetStorageFixture().storage;
    const opened = await open({ storage: engine.wrapStorage(memory) }, runtime);

    const admission = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    expect(await admission.work.result()).toMatchObject({
      outcome: 'failed',
      rejection: { code: 'storage-failure' },
    });
    engine.assertAllFired();
    expect(await stateOf(opened, admission.assetId)).toBe('rejected');
    const report = await collect(opened);
    expect(report.purgedBlobs).toHaveLength(1);
    expect(await memory.list('asset:v1:blob:')).toEqual([]);
    await opened.close();
  });

  it('recovers an admission a failed process left pending, after a restart with the clock set back', async () => {
    const firstRuntime = createManualRuntimeServices({ identifierSeed: 'first-process' });
    const fixture = createDurableAssetStorageFixture({ runtime: firstRuntime });
    let current = fixture;
    cleanups.push(() => current.dispose());
    // The commit AND the rejection write both fail, so the record is left `pending` on disk.
    const plan: FaultPlan = [
      {
        id: 'commit-fails',
        boundary: 'before-commit',
        operation: 'storage:conditionalBatch',
        occurrence: { kind: 'nth', n: 2 },
        effect: { kind: 'fail-before-commit', error: new Error('io error') },
      },
      {
        id: 'rejection-write-fails',
        boundary: 'before-commit',
        operation: 'storage:conditionalBatch',
        occurrence: { kind: 'nth', n: 2 },
        effect: { kind: 'fail-before-commit', error: new Error('io error') },
      },
    ];
    const engine = createFaultEngine(plan, firstRuntime);
    const first = await open({ storage: engine.wrapStorage(fixture.storage) }, firstRuntime);
    const admission = await first.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    expect(await admission.work.result()).toMatchObject({ rejection: { code: 'storage-failure' } });
    engine.assertAllFired();
    const auditBefore = await first.assets.auditRecords();
    await first.close();

    current = await fixture.restart();
    const secondRuntime = createManualRuntimeServices({
      identifierSeed: 'second-process',
      origin: '2019-06-01T00:00:00.000Z',
    });
    const second = await open({ storage: current.storage }, secondRuntime);
    const pending = await second.assets.inspect(admission.assetId, aliceAdministrator, {
      projection: 'privileged',
    });
    expect(pending.state).toBe('pending');

    const report = await collect(second);
    expect(report.interruptedAdmissions).toEqual([admission.assetId]);
    expect(report.purgedBlobs).toHaveLength(1);
    const recovered = await second.assets.inspect(admission.assetId, aliceAdministrator, {
      projection: 'privileged',
    });
    expect(recovered).toMatchObject({ state: 'rejected', rejection: { code: 'interrupted' } });
    expect(recovered.revision).toBeGreaterThan(pending.revision);

    // Audit sequence continues past the first process even though the clock went backwards.
    const auditAfter = await second.assets.auditRecords();
    const lastBefore = Math.max(...auditBefore.map((record) => record.sequence));
    const added = auditAfter.slice(auditBefore.length);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((record) => record.sequence > lastBefore)).toBe(true);
    expect(auditAfter.slice(0, auditBefore.length)).toEqual([...auditBefore]);
    await second.close();
  });
});

describe('quiescence after shutdown', () => {
  it('refuses every asset operation after shutdown, so nothing commits or audits after the drain', async () => {
    const opened = await open();
    const admission = await admitted(opened);
    const session = await opened.assets.beginUpload(alice, { declaredByteLength: 4 });
    await opened.assets.shutdown();
    const audit = await opened.assets.auditRecords();

    const { assetId } = admission;
    const attempts: Array<Promise<unknown>> = [
      opened.assets.retain(assetId, alice, { holderId: 'h', until: '2030-01-01T00:00:00.000Z' }),
      opened.assets.release(assetId, alice, 'h'),
      opened.assets.placeHold(assetId, aliceAdministrator, { holdId: 'legal-1', kind: 'legal' }),
      opened.assets.releaseHold(assetId, aliceAdministrator, 'legal-1'),
      opened.assets.expire(assetId, alice),
      opened.assets.abortUpload(session.uploadId, alice),
      opened.assets.inspect(assetId, alice),
      opened.assets.resolve(admission.source, alice),
    ];
    for (const attempt of attempts) {
      expect(await rejectionOf(attempt)).toBeInstanceOf(AssetServiceClosedError);
    }
    expect(await opened.assets.auditRecords()).toHaveLength(audit.length);
    await opened.close();
  });

  it('aborts in-flight fetch, scan, and garbage-collection work on shutdown and reports nothing leaked', async () => {
    const never = new Promise<never>(() => {});
    const opened = await open({
      ports: {
        resolveHost: async () => ['93.184.216.34'],
        fetch: async ({ signal }) => {
          await new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted'))),
          );
          return never;
        },
        safetyGates: [
          {
            name: 'slow',
            inspect: async ({ signal }) => {
              await new Promise((_resolve, reject) =>
                signal.addEventListener('abort', () => reject(new Error('aborted'))),
              );
              return never;
            },
          },
        ],
      },
    });
    const fetching = await opened.assets.admit(
      { source: { kind: 'url', url: 'https://cdn.example.com/a', fetchedBy: 'host' } },
      alice,
    );
    const scanning = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    const collecting = opened.assets.collectGarbage();
    expect(opened.assets.activeWork().length).toBeGreaterThan(0);

    const report = await opened.harness.close();
    expect(report.quiescent).toBe(true);
    expect(report.assetWork).toEqual([]);
    expect(opened.assets.activeWork()).toEqual([]);
    expect(await fetching.work.result()).toMatchObject({ outcome: 'aborted' });
    expect(await scanning.work.result()).toMatchObject({ outcome: 'aborted' });
    const collected = await collecting.result();
    expect(['completed', 'aborted']).toContain(collected.outcome);
    expect(
      opened.runtime.outstandingDeferred().filter((label) => label.startsWith('asset-')),
    ).toEqual([]);
  });

  it('names asset work that ignores its abort past a bounded shutdown', async () => {
    const reached = deferred();
    const opened = await open({
      ports: {
        safetyGates: [
          {
            name: 'deaf',
            inspect: () => {
              reached.resolve();
              return new Promise(() => {});
            },
          },
        ],
      },
    });
    await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    await reached.promise;

    const report = await opened.harness.close({ timeoutMilliseconds: 50 });
    expect(report.incomplete).toContainEqual(expect.objectContaining({ kind: 'assets' }));
    expect(report.assetWork.map((leak) => leak.owner)).toContain('asset-scan');
  });

  it('clears the collection timer on shutdown, so no asset timer survives it', async () => {
    const opened = await open({ garbageCollectionIntervalMilliseconds: 1_000 });
    const armed = opened.runtime.pendingTimers().length;
    expect(opened.assets.activeTimers()).toHaveLength(1);

    const report = await opened.harness.close();
    expect(report.quiescent).toBe(true);
    expect(report.assetWork).toEqual([]);
    expect(opened.assets.activeTimers()).toEqual([]);
    expect(opened.runtime.pendingTimers().length).toBeLessThan(armed);
  });
});

describe('shutdown overlapping a call', () => {
  it('waits for an admission still persisting, then aborts the work it started', async () => {
    const fixture = createMemoryAssetStorageFixture();
    const writeReached = deferred();
    const writeGate = deferred();
    let stallNextWrite = false;
    const stalled = async () => {
      if (!stallNextWrite) return;
      stallNextWrite = false;
      writeReached.resolve();
      await writeGate.promise;
    };
    const storage: AssetStorage = {
      ...fixture.storage,
      set: async (key, value) => {
        await stalled();
        return fixture.storage.set(key, value);
      },
      conditionalBatch: async (conditions, operations) => {
        await stalled();
        return fixture.storage.conditionalBatch(conditions, operations);
      },
    };
    const opened = await open({ storage });
    stallNextWrite = true;
    const admitting = opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    await writeReached.promise;

    let shutDown = false;
    const shutdown = opened.assets.shutdown().then(() => {
      shutDown = true;
    });
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(shutDown).toBe(false);

    writeGate.resolve();
    const admission = await admitting;
    await shutdown;
    expect(await admission.work.result()).toMatchObject({ outcome: 'aborted' });
    expect(opened.assets.activeWork()).toEqual([]);
    await opened.close();
  });
});

describe('provider transfer racing deletion', () => {
  it('deletes an uploaded copy at the provider when the asset was deleted during the upload', async () => {
    const uploadReached = deferred();
    const uploadGate = deferred();
    const deletedCopies: string[] = [];
    const opened = await open({
      ports: {
        providers: {
          openai: {
            download: async () => ({ bytes: new Uint8Array() }),
            upload: async () => {
              uploadReached.resolve();
              await uploadGate.promise;
              return { providerFileId: 'file-orphan' };
            },
            delete: async ({ providerFileId }) => {
              deletedCopies.push(providerFileId);
            },
          },
        },
      },
    });
    const admission = await admitted(opened);
    const transfer = opened.assets.transferToProvider(admission.assetId, alice, {
      provider: 'openai',
    });
    await uploadReached.promise;
    expect(await opened.assets.delete(admission.assetId, alice).result()).toMatchObject({
      outcome: 'completed',
    });

    uploadGate.resolve();
    expect(await transfer.result()).toMatchObject({ outcome: 'failed' });
    expect(deletedCopies).toEqual(['file-orphan']);
    await opened.close();
  });
});

describe('targeted deletion abort', () => {
  it('commits no tombstone when the deletion is aborted before its write', async () => {
    const opened = await open();
    const admission = await admitted(opened);
    const deletion = opened.assets.delete(admission.assetId, alice);
    deletion.abort('changed my mind');

    expect(await deletion.result()).toMatchObject({
      outcome: 'aborted',
      reason: 'changed my mind',
    });
    expect(await stateOf(opened, admission.assetId)).toBe('available');
    await opened.close();
  });
});

describe('provider copies no transport can delete', () => {
  it('keep their tombstone past retention, so the provider file id is never lost', async () => {
    const opened = await open({
      policy: { tombstoneRetentionMilliseconds: 1_000 },
      ports: {
        providers: {
          archive: {
            download: async () => ({ bytes: new Uint8Array() }),
            upload: async () => ({ providerFileId: 'file-kept' }),
          },
        },
      },
    });
    const admission = await admitted(opened);
    expect(
      await opened.assets
        .transferToProvider(admission.assetId, alice, { provider: 'archive' })
        .result(),
    ).toMatchObject({ outcome: 'completed' });
    await opened.assets.delete(admission.assetId, alice).result();

    await opened.runtime.advance(5_000);
    expect(await collect(opened)).toMatchObject({ purgedTombstones: [] });
    const descriptor = await opened.assets.inspect(admission.assetId, aliceAdministrator, {
      projection: 'privileged',
    });
    expect(descriptor.projection === 'privileged' && descriptor.providerCopies).toEqual([
      { provider: 'archive', providerFileId: 'file-kept' },
    ]);
    await opened.close();
  });
});

describe('upload chunks', () => {
  it('refuses an empty chunk, storing nothing', async () => {
    const opened = await open();
    const session = await opened.assets.beginUpload(alice, { declaredByteLength: 4 });
    const refused = await rejectionOf(
      opened.assets.appendUpload(session.uploadId, alice, new Uint8Array()),
    );
    expect(refused).toBeInstanceOf(AssetAdmissionError);
    expect((refused as AssetAdmissionError).code).toBe('upload-incomplete');
    expect(await opened.storage.list(`asset:v1:upload-chunk:${session.uploadId}:`)).toEqual([]);
    await opened.close();
  });
});

describe('bounded in-memory storage capacity', () => {
  it('sizes a key named twice in one batch against its intermediate value', async () => {
    const storage = createMemoryAssetStorage({ maxBytes: 10 });
    await storage.set('k', '12345678');
    // Deleting the same key twice frees it once, so the space is still bounded afterwards.
    expect(
      await storage.conditionalBatch(
        [],
        [
          { type: 'delete', key: 'k' },
          { type: 'delete', key: 'k' },
        ],
      ),
    ).toBe(true);
    expect(await rejectionOf(storage.set('big', '1234567890'))).toBeInstanceOf(
      AssetStorageCapacityError,
    );
    // Writing one key twice counts only its final value.
    expect(
      await storage.conditionalBatch(
        [],
        [
          { type: 'set', key: 'a', value: '1234' },
          { type: 'set', key: 'a', value: '1234' },
        ],
      ),
    ).toBe(true);
  });
});

describe('Bureau shutdown report', () => {
  it('reports the assets owner failed when an asset handle fails its cleanup', async () => {
    const opened = await open({
      ports: {
        safetyGates: [
          {
            name: 'slow',
            inspect: ({ signal }) =>
              new Promise((_resolve, reject) =>
                signal.addEventListener('abort', () => reject(new Error('aborted'))),
              ),
          },
        ],
      },
    });
    const admission = await opened.assets.admit({ source: { kind: 'inline', bytes: PNG } }, alice);
    admission.work.subscribeSnapshot((snapshot) => {
      if (snapshot.status === 'settled') throw new Error('observer failed');
    });

    const report = await opened.harness.close();
    expect(report.shutdownReport.owners).toContainEqual({ kind: 'assets', outcome: 'failed' });
  });
});
