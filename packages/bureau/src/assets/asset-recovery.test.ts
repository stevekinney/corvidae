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
  AssetHeldError,
  AssetNotFoundError,
  AssetUnavailableError,
  type AssetStorage,
  type BureauAssetOptions,
} from './index';

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
