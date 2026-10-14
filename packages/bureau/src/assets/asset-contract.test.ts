/**
 * COR-794 — the managed-asset contract: admission from each of the five
 * sources, the immutable descriptor and its two projections, admission
 * validation of media facts and limits, the injected storage interface over
 * a bounded in-memory fixture and a durable-contract fixture, the
 * reference-not-bytes guarantee for conversation state, and the started-work
 * contract of every asynchronous asset operation.
 *
 * Every Bureau here is closed through `harness.close()`, which runs
 * `assertBureauQuiescent` and rejects with `BureauQuiescenceError` if any
 * asset task, timer, or storage call outlived shutdown.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { waitForRunState } from '@lostgradient/operative';
import type { BatchOperation, Storage } from '@lostgradient/weft';
import { type ContentSource, type Modality } from 'conversationalist';

import type { AssetStorageFixture } from '../test/asset-storage-fixtures';
import { createMemoryStorageFixture } from '../test/storage-fixtures';
import {
  createDurableAssetStorageFixture,
  createMemoryAssetStorageFixture,
} from '../test/asset-storage-fixtures';
import {
  abortable,
  alice,
  aliceAdministrator,
  type AssetHarness,
  auditor,
  base64Of,
  bob,
  createAssetHarness,
  deferred,
  isoMediaBytes,
  mallory,
  objectStreamPdfBytes,
  pdfBytes,
  pngBytes,
  scriptedFetcher,
  scriptedResolver,
  textBytes,
  wavBytes,
  webpBytes,
  zipBytes,
} from '../testing/asset-fixtures.test-support';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  AssetAccessDeniedError,
  AssetAdmissionError,
  AssetNotFoundError,
  type AssetEvent,
  type AssetWorkKind,
  type BureauAssetOptions,
  managedAssetSource,
} from '../index';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function open(
  options: BureauAssetOptions,
  runtime = createManualRuntimeServices(),
): Promise<AssetHarness> {
  const opened = await createAssetHarness(options, runtime);
  let closed = false;
  cleanups.push(async () => {
    if (!closed) await opened.harness.close();
  });
  return {
    ...opened,
    harness: {
      ...opened.harness,
      close: async (shutdownOptions) => {
        closed = true;
        return opened.harness.close(shutdownOptions);
      },
    },
  };
}

function memoryFixture(maxBytes?: number): AssetStorageFixture {
  const fixture = createMemoryAssetStorageFixture(maxBytes === undefined ? {} : { maxBytes });
  cleanups.push(() => fixture.dispose());
  return fixture;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('admission API', () => {
  it('returns a pending, persisted identity immediately and finishes admission asynchronously', async () => {
    const scanReached = deferred();
    const releaseScan = deferred();
    const { assets, harness } = await open({
      storage: memoryFixture().storage,
      ports: {
        safetyGates: [
          {
            name: 'held-scanner',
            inspect: async ({ signal }) => {
              scanReached.resolve();
              await abortable(releaseScan.promise, signal);
              return { verdict: 'clean' };
            },
          },
        ],
      },
    });

    const bytes = pngBytes(4, 3);
    const admission = await assets.admit(
      { source: { kind: 'inline', bytes }, declaredMediaType: 'image/png' },
      alice,
    );
    await scanReached.promise;

    expect(admission.descriptor.state).toBe('pending');
    expect(admission.descriptor.revision).toBe(1);
    expect(admission.source).toEqual({
      kind: 'managed-asset',
      assetId: admission.assetId,
      revision: 1,
    });
    expect(admission.work.snapshot().status).toBe('pending');
    expect(await assets.inspect(admission.assetId, alice)).toMatchObject({ state: 'pending' });

    releaseScan.resolve();
    const result = await admission.work.result();
    expect(result.outcome).toBe('completed');
    const available = await assets.inspect(admission.assetId, aliceAdministrator, {
      projection: 'privileged',
    });
    expect(available).toMatchObject({
      projection: 'privileged',
      state: 'available',
      revision: 2,
      custody: 'bureau',
      digest: await sha256(bytes),
      mediaType: 'image/png',
      modality: 'image',
      mimeFamily: 'image',
      byteLength: bytes.byteLength,
      owner: 'alice',
      provenance: { kind: 'inline' },
      media: { width: 4, height: 3 },
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    await harness.close();
  });

  it('admitAll refuses every part before persisting or starting any when one part is refused', async () => {
    const fixture = memoryFixture();
    const { assets, harness } = await open({
      storage: fixture.storage,
      policy: { maxInlineBytes: 64 },
    });
    const error = await rejectionOf(
      assets.admitAll(
        [
          { source: { kind: 'inline', bytes: pngBytes(1, 1) } },
          { source: { kind: 'inline', bytes: pngBytes(1, 1, 200) } },
        ],
        alice,
      ),
    );
    expect((error as AssetAdmissionError).rejection.code).toBe('per-part-limit-exceeded');
    expect(assets.activeWork()).toEqual([]);
    expect(await fixture.storage.list('asset:v1:record:')).toEqual([]);
    await harness.close();
  });

  it('refuses inline bytes above the inline ceiling before persisting anything', async () => {
    const fixture = memoryFixture();
    const { assets, harness } = await open({
      storage: fixture.storage,
      policy: { maxInlineBytes: 8 },
    });

    const error = await rejectionOf(
      assets.admit({ source: { kind: 'inline', bytes: textBytes('0123456789') } }, alice),
    );

    expect(error).toBeInstanceOf(AssetAdmissionError);
    expect((error as AssetAdmissionError).code).toBe('per-part-limit-exceeded');
    expect(await fixture.storage.list('asset:v1:record:')).toEqual([]);
    expect(await fixture.storage.list('asset:v1:blob:')).toEqual([]);
    await harness.close();
  });

  it('admits an upload completion, assembling the chunks and retiring the session', async () => {
    const fixture = memoryFixture();
    const { assets, harness } = await open({ storage: fixture.storage });
    const bytes = textBytes('hello, chunked world');
    const session = await assets.beginUpload(alice, {
      declaredMediaType: 'text/plain',
      declaredByteLength: bytes.byteLength,
    });
    await assets.appendUpload(session.uploadId, alice, bytes.subarray(0, 7));
    const appended = await assets.appendUpload(session.uploadId, alice, bytes.subarray(7));
    expect(appended.receivedBytes).toBe(bytes.byteLength);

    const admission = await assets.admit(
      { source: { kind: 'upload', uploadId: session.uploadId } },
      alice,
    );
    expect(await admission.work.result()).toMatchObject({ outcome: 'completed' });

    const resolved = await assets.resolve(admission.source, alice);
    expect(resolved.content).toEqual({ kind: 'bytes', bytes });
    expect(resolved.descriptor.provenanceKind).toBe('upload');
    expect(await fixture.storage.list('asset:v1:upload')).toHaveLength(0);
    await harness.close();
  });

  it('admits an authorized URL through the host fetch port, keeping only the origin as provenance', async () => {
    const bytes = pngBytes(2, 2);
    const resolver = scriptedResolver({ 'cdn.example.com': [['93.184.216.34']] });
    const fetcher = scriptedFetcher({
      'https://cdn.example.com/images/cat.png?revision=c0ffee': {
        status: 200,
        contentType: 'image/png',
        body: bytes,
      },
    });
    const { assets, harness } = await open({
      storage: memoryFixture().storage,
      ports: { resolveHost: resolver.resolveHost, fetch: fetcher.fetch },
    });

    const admission = await assets.admit(
      {
        source: {
          kind: 'url',
          url: 'https://cdn.example.com/images/cat.png?revision=c0ffee',
          fetchedBy: 'host',
        },
      },
      alice,
    );
    expect(await admission.work.result()).toMatchObject({ outcome: 'completed' });

    const descriptor = await assets.inspect(admission.assetId, aliceAdministrator, {
      projection: 'privileged',
    });
    expect(descriptor.projection === 'privileged' && descriptor.provenance).toEqual({
      kind: 'url',
      origin: 'https://cdn.example.com',
      fetchedBy: 'host',
      redirects: 0,
    });
    expect(fetcher.requests[0]?.address).toBe('93.184.216.34');
    await harness.close();
  });

  it('admits a provider file identifier through the provider transport', async () => {
    const bytes = pdfBytes(2);
    const { assets, harness } = await open({
      storage: memoryFixture().storage,
      ports: {
        providers: {
          anthropic: {
            download: async ({ providerFileId }) => {
              expect(providerFileId).toBe('file_123');
              return { bytes, mediaType: 'application/pdf' };
            },
            upload: async () => ({ providerFileId: 'unused' }),
          },
        },
      },
    });

    const admission = await assets.admit(
      { source: { kind: 'provider-file', provider: 'anthropic', providerFileId: 'file_123' } },
      alice,
    );
    expect(await admission.work.result()).toMatchObject({ outcome: 'completed' });
    const descriptor = await assets.inspect(admission.assetId, alice);
    expect(descriptor).toMatchObject({
      state: 'available',
      mediaType: 'application/pdf',
      modality: 'document',
      provenanceKind: 'provider-file',
    });
    await harness.close();
  });

  it('admits an existing asset reference as a new identity sharing one stored blob', async () => {
    const fixture = memoryFixture();
    const { assets, harness } = await open({ storage: fixture.storage });
    const original = await assets.admit(
      { source: { kind: 'inline', bytes: pngBytes(1, 1) }, readers: ['bob'] },
      alice,
    );
    await original.work.result();

    const copy = await assets.admit(
      { source: { kind: 'managed-asset', assetId: original.assetId } },
      bob,
    );
    expect(await copy.work.result()).toMatchObject({ outcome: 'completed' });

    const copied = await assets.inspect(copy.assetId, bob);
    const source = await assets.inspect(original.assetId, alice);
    expect(copy.assetId).not.toBe(original.assetId);
    expect(copied.owner).toBe('bob');
    expect(copied.digest).toBe(source.digest);
    expect(copied.provenanceKind).toBe('asset-reference');
    expect(await fixture.storage.list('asset:v1:blob:')).toHaveLength(1);

    // A principal who cannot read the source cannot launder it through a reference.
    const denied = await rejectionOf(
      assets.admit({ source: { kind: 'managed-asset', assetId: original.assetId } }, mallory),
    );
    expect(denied).toBeInstanceOf(AssetNotFoundError);
    await harness.close();
  });
});

describe('AssetDescriptor', () => {
  it('is a frozen snapshot whose revision only ever increases', async () => {
    const { assets, harness, runtime } = await open({ storage: memoryFixture().storage });
    const admission = await assets.admit(
      { source: { kind: 'inline', bytes: pngBytes(1, 1) } },
      alice,
    );
    await admission.work.result();

    const first = await assets.inspect(admission.assetId, alice);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.retention)).toBe(true);

    const until = new Date(runtime.clock.now() + 60_000).toISOString();
    const retained = await assets.retain(admission.assetId, alice, { holderId: 'run-1', until });
    const held = await assets.placeHold(admission.assetId, aliceAdministrator, {
      holdId: 'case-7',
      kind: 'legal',
    });
    const released = await assets.releaseHold(admission.assetId, aliceAdministrator, 'case-7');
    const revisions = [first.revision, retained.revision, held.revision, released.revision];
    expect(revisions).toEqual(revisions.toSorted((left, right) => left - right));
    expect(new Set(revisions).size).toBe(revisions.length);
    // The earlier snapshot is untouched by later transitions.
    expect(first.projection === 'general' && first.retention.referenceCount).toBe(0);
    await harness.close();
  });

  it('is expressed in conversationalist ContentSource, Modality, and MediaLimits terms', async () => {
    const { assets, harness } = await open({
      storage: memoryFixture().storage,
      policy: { limits: [{ scope: 'per-part', modality: 'audio', maxDurationSeconds: 60 }] },
      ports: { extractMetadata: async () => ({ durationSeconds: 12 }) },
    });
    const admission = await assets.admit({ source: { kind: 'inline', bytes: wavBytes() } }, alice);
    await admission.work.result();
    const descriptor = await assets.inspect(admission.assetId, alice);

    const source: ContentSource = descriptor.source;
    const modality: Modality | undefined = descriptor.modality;
    expect(source).toEqual(managedAssetSource(descriptor));
    expect(source.kind).toBe('managed-asset');
    expect(modality).toBe('audio');
    expect(assets.policy.limits).toEqual([
      { scope: 'per-part', modality: 'audio', maxDurationSeconds: 60 },
    ]);
    await harness.close();
  });

  it('enforces the same persisted resource authorization for both projections, before and after a restart', async () => {
    const firstRuntime = createManualRuntimeServices({ identifierSeed: 'before-restart' });
    const fixture = createDurableAssetStorageFixture({ runtime: firstRuntime });
    let current = fixture;
    cleanups.push(() => current.dispose());

    async function outcomes(assets: AssetHarness['assets'], assetId: string) {
      const read = async (
        principal: { id: string; privileged?: boolean },
        projection: 'general' | 'privileged',
      ) => {
        try {
          const descriptor = await assets.inspect(assetId, principal, { projection });
          return descriptor.projection;
        } catch (error) {
          return (error as Error).name;
        }
      };
      return {
        ownerGeneral: await read(alice, 'general'),
        ownerPrivileged: await read(aliceAdministrator, 'privileged'),
        readerGeneral: await read(bob, 'general'),
        readerPrivilegedWithoutCapability: await read(bob, 'privileged'),
        strangerGeneral: await read(mallory, 'general'),
        strangerPrivilegedWithCapability: await read(auditor, 'privileged'),
      };
    }

    const first = await open({ storage: fixture.storage }, firstRuntime);
    const admission = await first.assets.admit(
      { source: { kind: 'inline', bytes: pngBytes(2, 2) }, readers: ['bob'] },
      alice,
    );
    await admission.work.result();
    const before = await outcomes(first.assets, admission.assetId);
    await first.harness.close();

    current = await fixture.restart();
    const second = await open(
      { storage: current.storage },
      createManualRuntimeServices({ identifierSeed: 'after-restart' }),
    );
    const after = await outcomes(second.assets, admission.assetId);

    expect(before).toEqual({
      ownerGeneral: 'general',
      ownerPrivileged: 'privileged',
      readerGeneral: 'general',
      readerPrivilegedWithoutCapability: AssetAccessDeniedError.name,
      strangerGeneral: AssetNotFoundError.name,
      strangerPrivilegedWithCapability: AssetNotFoundError.name,
    });
    expect(after).toEqual(before);
    await second.harness.close();
  });

  it('keeps the general projection free of readers, provenance, and safety detail', async () => {
    const { assets, harness } = await open({ storage: memoryFixture().storage });
    const admission = await assets.admit(
      { source: { kind: 'inline', bytes: pngBytes(1, 1) }, readers: ['bob', 'carol'] },
      alice,
    );
    await admission.work.result();

    const general = await assets.inspect(admission.assetId, bob);
    expect(general.projection).toBe('general');
    expect(general.authorization).toEqual({ access: 'reader' });
    expect(Object.keys(general)).not.toContain('provenance');
    expect(Object.keys(general)).not.toContain('safety');
    expect(JSON.stringify(general)).not.toContain('carol');
    await harness.close();
  });
});

describe('admission validation', () => {
  async function rejectionFor(
    options: BureauAssetOptions,
    request: Parameters<AssetHarness['assets']['admit']>[0],
  ) {
    const { assets, harness } = await open(options);
    const admission = await assets.admit(request, alice);
    const result = await admission.work.result();
    const descriptor = await assets.inspect(admission.assetId, alice);
    await harness.close();
    return { result, descriptor };
  }

  it('rejects a declared media type that the detected bytes contradict', async () => {
    const { result, descriptor } = await rejectionFor(
      { storage: memoryFixture().storage },
      { source: { kind: 'inline', bytes: pdfBytes(1) }, declaredMediaType: 'image/png' },
    );
    expect(result).toMatchObject({ outcome: 'failed', rejection: { code: 'media-type-mismatch' } });
    expect(descriptor.state).toBe('rejected');
    expect(descriptor.rejection?.code).toBe('media-type-mismatch');
  });

  it('rejects a detected media type outside the allowlist', async () => {
    const { result } = await rejectionFor(
      { storage: memoryFixture().storage, policy: { allowedMediaTypes: ['image/png'] } },
      { source: { kind: 'inline', bytes: pdfBytes(1) } },
    );
    expect(result).toMatchObject({ rejection: { code: 'media-type-not-allowed' } });
  });

  it('enforces per-part byte limits from MediaLimits', async () => {
    const { result } = await rejectionFor(
      {
        storage: memoryFixture().storage,
        policy: { limits: [{ scope: 'per-part', modality: 'image', maxBytes: 20 }] },
      },
      { source: { kind: 'inline', bytes: pngBytes(1, 1, 64) } },
    );
    expect(result).toMatchObject({ rejection: { code: 'per-part-limit-exceeded' } });
  });

  it('enforces aggregate byte limits across the parts admitted together', async () => {
    const { assets, harness } = await open({
      storage: memoryFixture().storage,
      policy: { limits: [{ scope: 'aggregate', modality: 'image', maxBytes: 100 }] },
    });
    const admissions = await assets.admitAll(
      [
        { source: { kind: 'inline', bytes: pngBytes(1, 1, 40) } },
        { source: { kind: 'inline', bytes: pngBytes(1, 1, 40) } },
      ],
      alice,
    );
    const outcomes = await Promise.all(admissions.map((admission) => admission.work.result()));
    expect(outcomes[0]?.outcome).toBe('completed');
    expect(outcomes[1]).toMatchObject({ rejection: { code: 'aggregate-limit-exceeded' } });
    await harness.close();
  });

  it('settles a part aborted while it waits on the aggregate budget at once, reserving and starting nothing', async () => {
    // Three PNGs of 43, 44, and 45 bytes under a 90-byte aggregate image limit:
    // parts 0 and 2 fit together only if the aborted part 1 reserves nothing.
    const parts = [10, 11, 12].map((padding) => pngBytes(1, 1, padding));
    const firstExtraction = deferred();
    const releaseFirst = deferred();
    const scanned: number[] = [];
    const { assets, harness } = await open({
      storage: memoryFixture().storage,
      policy: { limits: [{ scope: 'aggregate', modality: 'image', maxBytes: 90 }] },
      ports: {
        extractMetadata: async ({ bytes, signal }) => {
          if (bytes.byteLength === parts[0]!.byteLength) {
            firstExtraction.resolve();
            await abortable(releaseFirst.promise, signal);
          }
          return {};
        },
        safetyGates: [
          {
            name: 'counter',
            inspect: async ({ bytes }) => {
              scanned.push(bytes.byteLength);
              return { verdict: 'clean' };
            },
          },
        ],
      },
    });
    const admissions = await assets.admitAll(
      parts.map((bytes) => ({ source: { kind: 'inline' as const, bytes } })),
      alice,
    );
    await firstExtraction.promise;
    // Let part 1 run its own extraction and park on part 0's budget decision.
    for (let turn = 0; turn < 5; turn++) await yieldToPortableEventLoop();

    admissions[1]!.work.abort('caller gave up');
    let settledBeforeRelease = false;
    void admissions[1]!.work.result().then(() => {
      settledBeforeRelease = true;
    });
    await yieldToPortableEventLoop();
    expect(settledBeforeRelease).toBe(true);
    expect(await admissions[1]!.work.result()).toEqual({
      outcome: 'aborted',
      reason: 'caller gave up',
    });
    expect(await admissions[1]!.work.closed()).toEqual({ status: 'completed' });

    releaseFirst.resolve();
    expect(await admissions[0]!.work.result()).toMatchObject({ outcome: 'completed' });
    expect(await admissions[2]!.work.result()).toMatchObject({ outcome: 'completed' });
    expect(scanned.toSorted((left, right) => left - right)).toEqual([
      parts[0]!.byteLength,
      parts[2]!.byteLength,
    ]);
    const audit = await assets.auditRecords();
    const scansStarted = audit.filter(
      (record) =>
        record.type === 'asset.work.started' &&
        record.workKind === 'scan' &&
        record.assetId === admissions[1]!.assetId,
    );
    expect(scansStarted).toEqual([]);
    await harness.close();
  });

  it('rejects image dimensions beyond maxPixels', async () => {
    const { result } = await rejectionFor(
      {
        storage: memoryFixture().storage,
        policy: { limits: [{ scope: 'per-part', modality: 'image', maxPixels: 100 }] },
      },
      { source: { kind: 'inline', bytes: pngBytes(20, 20) } },
    );
    expect(result).toMatchObject({ rejection: { code: 'dimensions-exceeded' } });
  });

  it('rejects media duration beyond maxDurationSeconds when the extractor reports one', async () => {
    const { result } = await rejectionFor(
      {
        storage: memoryFixture().storage,
        policy: { limits: [{ scope: 'per-part', modality: 'audio', maxDurationSeconds: 30 }] },
        ports: { extractMetadata: async () => ({ durationSeconds: 31 }) },
      },
      { source: { kind: 'inline', bytes: wavBytes() } },
    );
    expect(result).toMatchObject({ rejection: { code: 'duration-exceeded' } });
  });

  it('rejects a document whose page count exceeds maxPageCount', async () => {
    const { result } = await rejectionFor(
      {
        storage: memoryFixture().storage,
        policy: { limits: [{ scope: 'per-part', modality: 'document', maxPageCount: 3 }] },
      },
      { source: { kind: 'inline', bytes: pdfBytes(4) } },
    );
    expect(result).toMatchObject({ rejection: { code: 'page-count-exceeded' } });
  });
});

describe('admission validation fails closed on unmeasured facts', () => {
  async function outcomeOf(
    options: Omit<BureauAssetOptions, 'storage'>,
    request: Parameters<AssetHarness['assets']['admit']>[0],
  ) {
    const { assets, harness } = await open({ ...options, storage: memoryFixture().storage });
    const admission = await assets.admit(request, alice);
    const result = await admission.work.result();
    const descriptor = await assets.inspect(admission.assetId, alice);
    await harness.close();
    return { result, descriptor };
  }
  const maxPixels = {
    limits: [{ scope: 'per-part' as const, modality: 'image' as const, maxPixels: 100 }],
  };

  it('measures WebP dimensions and enforces maxPixels on them', async () => {
    const large = await outcomeOf(
      { policy: maxPixels },
      { source: { kind: 'inline', bytes: webpBytes(20, 20) } },
    );
    expect(large.result).toMatchObject({ rejection: { code: 'dimensions-exceeded' } });
    const small = await outcomeOf(
      { policy: maxPixels },
      { source: { kind: 'inline', bytes: webpBytes(5, 5) } },
    );
    expect(small.result.outcome).toBe('completed');
  });

  it('refuses an image whose dimensions nothing measured, unless the extractor reports them', async () => {
    const request = {
      source: { kind: 'inline' as const, bytes: isoMediaBytes('avif') },
      declaredMediaType: 'image/avif',
    };
    const unmeasured = await outcomeOf({ policy: maxPixels }, request);
    expect(unmeasured.result).toMatchObject({ rejection: { code: 'media-facts-unmeasured' } });
    expect(unmeasured.descriptor.rejection?.code).toBe('media-facts-unmeasured');
    const measured = await outcomeOf(
      { policy: maxPixels, ports: { extractMetadata: async () => ({ width: 4, height: 4 }) } },
      request,
    );
    expect(measured.result.outcome).toBe('completed');
    expect(measured.descriptor.modality).toBe('image');
  });

  it('refuses a PDF whose pages sit in compressed object streams under maxPageCount', async () => {
    const { result } = await outcomeOf(
      { policy: { limits: [{ scope: 'per-part', modality: 'document', maxPageCount: 3 }] } },
      { source: { kind: 'inline', bytes: objectStreamPdfBytes() } },
    );
    expect(result).toMatchObject({ rejection: { code: 'media-facts-unmeasured' } });
  });

  it('refuses audio with no measured duration under a per-part or aggregate duration limit', async () => {
    for (const scope of ['per-part', 'aggregate'] as const) {
      const { result } = await outcomeOf(
        { policy: { limits: [{ scope, modality: 'audio', maxDurationSeconds: 30 }] } },
        { source: { kind: 'inline', bytes: wavBytes() } },
      );
      expect(result).toMatchObject({ rejection: { code: 'media-facts-unmeasured' } });
    }
  });
});

describe('container media types', () => {
  async function admitted(bytes: Uint8Array, declaredMediaType: string) {
    const { assets, harness } = await open({ storage: memoryFixture().storage });
    const admission = await assets.admit(
      { source: { kind: 'inline', bytes }, declaredMediaType },
      alice,
    );
    const result = await admission.work.result();
    const descriptor = await assets.inspect(admission.assetId, alice);
    await harness.close();
    return { result, descriptor };
  }

  it('accepts a declared OOXML, ODF, or EPUB document over ZIP bytes as a document', async () => {
    for (const declared of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.oasis.opendocument.text',
      'application/epub+zip',
    ]) {
      const { result, descriptor } = await admitted(zipBytes(), declared);
      expect(result.outcome).toBe('completed');
      expect(descriptor).toMatchObject({ mediaType: declared, modality: 'document' });
    }
  });

  it('accepts MP4 audio and QuickTime declarations over an audio/video ftyp box', async () => {
    for (const [brand, declared, modality] of [
      ['M4A ', 'audio/mp4', 'audio'],
      ['isom', 'audio/x-m4a', 'audio'],
      ['isom', 'video/quicktime', 'video'],
    ] as const) {
      const { result, descriptor } = await admitted(isoMediaBytes(brand), declared);
      expect(result.outcome).toBe('completed');
      expect(descriptor.modality).toBe(modality);
    }
  });

  it('still refuses a declaration the container cannot carry', async () => {
    for (const [bytes, declared] of [
      [zipBytes(), 'image/png'],
      [isoMediaBytes('isom'), 'image/avif'],
      [isoMediaBytes('avif'), 'video/mp4'],
    ] as const) {
      const { result } = await admitted(bytes, declared);
      expect(result).toMatchObject({ rejection: { code: 'media-type-mismatch' } });
    }
  });
});

describe('storage interface fixtures', () => {
  const fixtures: Array<[string, () => AssetStorageFixture]> = [
    ['bounded in-memory', () => memoryFixture()],
    [
      'durable contract',
      () => {
        const fixture = createDurableAssetStorageFixture({
          runtime: createManualRuntimeServices(),
        });
        cleanups.push(() => fixture.dispose());
        return fixture;
      },
    ],
  ];

  for (const [name, create] of fixtures) {
    it(`${name}: admits, resolves, and deletes through the one storage interface`, async () => {
      const fixture = create();
      const { assets, harness } = await open({ storage: fixture.storage });
      const bytes = textBytes('stored through the injected interface');
      const admission = await assets.admit({ source: { kind: 'inline', bytes } }, alice);
      await admission.work.result();

      expect(await assets.resolve(admission.source, alice)).toMatchObject({
        content: {
          kind: 'bytes',
          bytes,
        },
      });
      expect(await assets.delete(admission.assetId, alice).result()).toMatchObject({
        outcome: 'completed',
      });
      await harness.close();
      // Shutdown drained every storage call the service started, audit writes included.
      expect(fixture.openHandles()).toEqual([]);
    });
  }

  it('bounded in-memory: a write beyond capacity fails admission as a storage failure', async () => {
    const { assets, harness } = await open({ storage: memoryFixture(2_000).storage });
    const admission = await assets.admit(
      { source: { kind: 'inline', bytes: textBytes('x'.repeat(4_000)) } },
      alice,
    );
    expect(await admission.work.result()).toMatchObject({
      outcome: 'failed',
      rejection: { code: 'storage-failure' },
    });
    await harness.close();
  });
});

/** Wraps Bureau's own storage so every value it ever writes — not just what survives — is recorded. */
function recordingWrites(storage: Storage, writes: Array<{ key: string; text: string }>): Storage {
  const decoder = new TextDecoder();
  const record = (key: string, value: Uint8Array) =>
    writes.push({ key, text: decoder.decode(value) });
  const recordBatch = (operations: readonly BatchOperation[]) => {
    for (const operation of operations) {
      if (operation.type === 'put') record(operation.key, operation.value);
    }
  };
  return new Proxy(storage, {
    get(target, property) {
      if (property === 'put') {
        return (key: string, value: Uint8Array) => {
          record(key, value);
          return target.put(key, value);
        };
      }
      if (property === 'batch') {
        return (operations: BatchOperation[]) => {
          recordBatch(operations);
          return target.batch(operations);
        };
      }
      if (property === 'conditionalBatch' && target.conditionalBatch) {
        const conditionalBatch = target.conditionalBatch.bind(target);
        return (...parameters: Parameters<typeof conditionalBatch>) => {
          recordBatch(parameters[1]);
          return conditionalBatch(...parameters);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('conversation state holds references, not bytes', () => {
  it('writes only the reference into every Bureau session snapshot, and stores the payload once', async () => {
    const fixture = memoryFixture();
    const writes: Array<{ key: string; text: string }> = [];
    const bureauStorage = createMemoryStorageFixture({
      wrapStorage: (storage) => recordingWrites(storage, writes),
    });
    const { assets, harness } = await createAssetHarness(
      { storage: fixture.storage },
      createManualRuntimeServices(),
      bureauStorage,
    );
    cleanups.push(() => harness.close().then(() => undefined));
    const bytes = pngBytes(8, 8, 512);
    const payload = base64Of(bytes);
    const admission = await assets.admit({ source: { kind: 'inline', bytes } }, alice);
    await admission.work.result();

    // Two turns on one Bureau session, each naming the asset by its managed-asset reference.
    const sessionId = 'asset-conversation';
    const reference = JSON.stringify(admission.source);
    for (let turn = 0; turn < 2; turn++) {
      const run = await harness.startSession({
        message: `turn ${turn}: describe ${reference}`,
        sessionId,
      });
      await waitForRunState(harness.bureau, run.id);
    }
    const session = await harness.bureau.getSession(sessionId);
    const userTurns = Object.values(session!.conversationHistory.messages).filter(
      (message) => message.role === 'user',
    );
    expect(userTurns).toHaveLength(2);

    // Every value Bureau ever wrote to its own storage — each session snapshot, run record, and outbox entry.
    for (const write of writes) expect(write.text).not.toContain(payload);
    const snapshotsNamingTheAsset = writes.filter(
      (write) => write.key.startsWith('agent-session') && write.text.includes(admission.assetId),
    );
    // One snapshot per turn at least, so the scan above is not vacuous.
    expect(snapshotsNamingTheAsset.length).toBeGreaterThanOrEqual(2);

    const holders: string[] = [];
    for (const key of await fixture.storage.list('')) {
      const value = await fixture.storage.get(key);
      if (value?.includes(payload)) holders.push(key);
    }
    expect(holders).toEqual([expect.stringMatching(/^asset:v1:blob:/)]);
    await harness.close();
  });
});

describe('started work', () => {
  /** Each kind's work is parked on a cooperative port until released, so its pending state is observable. */
  const scenarios: Record<
    Exclude<AssetWorkKind, 'admission'>,
    (gate: { reached: () => void; wait: (signal: AbortSignal) => Promise<void> }) => {
      options: Omit<BureauAssetOptions, 'storage'>;
      start: (assets: AssetHarness['assets']) => Promise<string>;
    }
  > = {
    upload: () => ({
      options: { ports: { safetyGates: [] } },
      start: async (assets) => {
        const session = await assets.beginUpload(alice, { declaredByteLength: 4 });
        await assets.appendUpload(session.uploadId, alice, textBytes('abcd'));
        const admission = await assets.admit(
          { source: { kind: 'upload', uploadId: session.uploadId } },
          alice,
        );
        return admission.work.workId;
      },
    }),
    fetch: (gate) => ({
      options: {
        ports: {
          resolveHost: async () => ['93.184.216.34'],
          fetch: async ({ signal }) => {
            gate.reached();
            await gate.wait(signal);
            return { status: 200, body: textBytes('fetched') };
          },
        },
      },
      start: (assets) =>
        workIdOf(
          assets.admit(
            { source: { kind: 'url', url: 'https://example.com/a', fetchedBy: 'host' } },
            alice,
          ),
        ),
    }),
    scan: (gate) => ({
      options: {
        ports: {
          safetyGates: [
            {
              name: 'gate',
              inspect: async ({ signal }) => {
                gate.reached();
                await gate.wait(signal);
                return { verdict: 'clean' };
              },
            },
          ],
        },
      },
      start: (assets) =>
        workIdOf(assets.admit({ source: { kind: 'inline', bytes: textBytes('scan me') } }, alice)),
    }),
    'metadata-extraction': (gate) => ({
      options: {
        ports: {
          extractMetadata: async ({ signal }) => {
            gate.reached();
            await gate.wait(signal);
            return {};
          },
        },
      },
      start: (assets) =>
        workIdOf(
          assets.admit({ source: { kind: 'inline', bytes: textBytes('extract me') } }, alice),
        ),
    }),
    transform: (gate) => ({
      options: {
        ports: {
          transformers: {
            upper: async ({ bytes, signal }) => {
              gate.reached();
              await gate.wait(signal);
              return { bytes, mediaType: 'text/plain' };
            },
          },
        },
      },
      start: async (assets) => {
        const admission = await assets.admit(
          { source: { kind: 'inline', bytes: textBytes('t') } },
          alice,
        );
        await admission.work.result();
        return workIdOf(assets.transform(admission.assetId, alice, { transform: 'upper' }));
      },
    }),
    'provider-transfer': (gate) => ({
      options: {
        ports: {
          providers: {
            openai: {
              download: async () => ({ bytes: new Uint8Array() }),
              upload: async ({ signal }) => {
                gate.reached();
                await gate.wait(signal);
                return { providerFileId: 'file-1' };
              },
            },
          },
        },
      },
      start: async (assets) => {
        const admission = await assets.admit(
          { source: { kind: 'inline', bytes: textBytes('p') } },
          alice,
        );
        await admission.work.result();
        return assets.transferToProvider(admission.assetId, alice, { provider: 'openai' }).workId;
      },
    }),
    deletion: (gate) => ({
      options: {
        ports: {
          providers: {
            openai: {
              download: async () => ({ bytes: new Uint8Array() }),
              upload: async () => ({ providerFileId: 'file-2' }),
              delete: async ({ signal }) => {
                gate.reached();
                await gate.wait(signal);
              },
            },
          },
        },
      },
      start: async (assets) => {
        const admission = await assets.admit(
          { source: { kind: 'inline', bytes: textBytes('d') } },
          alice,
        );
        await admission.work.result();
        await assets.transferToProvider(admission.assetId, alice, { provider: 'openai' }).result();
        return assets.delete(admission.assetId, alice).workId;
      },
    }),
    'garbage-collection': () => ({
      options: {},
      start: async (assets) => assets.collectGarbage().workId,
    }),
  };

  for (const [kind, scenario] of Object.entries(scenarios) as Array<
    [Exclude<AssetWorkKind, 'admission'>, (typeof scenarios)[keyof typeof scenarios]]
  >) {
    it(`${kind}: exposes identity, state, events, result, targeted abort, and cleanup acknowledgement`, async () => {
      const reached = deferred();
      const release = deferred();
      const configured = scenario({
        reached: () => reached.resolve(),
        wait: (signal) => abortable(release.promise, signal),
      });
      const fixture = memoryFixture();
      // Upload and garbage collection park on storage rather than on a port.
      const parkOn =
        kind === 'upload'
          ? 'asset:v1:upload-chunk:'
          : kind === 'garbage-collection'
            ? 'asset:v1:record:'
            : undefined;
      const storage = parkOn
        ? parkStorage(fixture, parkOn, kind === 'upload' ? 'get' : 'list', reached, release)
        : fixture.storage;
      const { assets, harness } = await open({ ...configured.options, storage });
      const events: AssetEvent[] = [];
      const unsubscribe = assets.subscribe((event) => events.push(event));

      const startedId = await configured.start(assets);
      await reached.promise;
      const work = assets.activeWork().find((snapshot) => snapshot.workKind === kind);
      expect(work).toBeDefined();
      expect(work!.id === startedId || work!.parentId === startedId).toBe(true);
      expect(work).toMatchObject({
        kind: `asset-${kind}`,
        status: 'pending',
        cancellable: true,
        detached: false,
        durability: 'process-local',
      });
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'asset.work.started', workId: work!.id, workKind: kind }),
      );

      const handle = assets.work(work!.id)!;
      const seen: string[] = [];
      handle.subscribeSnapshot((snapshot) => seen.push(snapshot.status));
      expect(assets.abort(work!.id, 'test abort')).toBe(true);
      // Aborting twice is a no-op.
      handle.abort('again');

      const result = await handle.result();
      expect(result).toEqual({ outcome: 'aborted', reason: 'test abort' });
      release.resolve();
      expect(await handle.closed()).toEqual({ status: 'completed' });
      expect(seen).toEqual(['pending', 'settled']);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'asset.work.settled',
          workId: work!.id,
          outcome: 'aborted',
        }),
      );
      unsubscribe();
      await harness.close();
    });
  }
});

async function workIdOf(admission: Promise<{ readonly work: { readonly workId: string } }>) {
  const admitted = await admission;
  return admitted.work.workId;
}

/** Parks the first `verb` call whose key starts with `prefix` until `release` resolves. */
function parkStorage(
  fixture: AssetStorageFixture,
  prefix: string,
  verb: 'get' | 'list',
  reached: { resolve: () => void },
  release: { promise: Promise<void> },
): AssetStorageFixture['storage'] {
  let parked = false;
  const storage = fixture.storage;
  const park = async () => {
    parked = true;
    reached.resolve();
    await release.promise;
  };
  return {
    ...storage,
    durability: storage.durability,
    get: async (key) => {
      if (verb === 'get' && !parked && key.startsWith(prefix)) await park();
      return storage.get(key);
    },
    list: async (listPrefix) => {
      if (verb === 'list' && !parked && listPrefix.startsWith(prefix)) await park();
      return storage.list(listPrefix);
    },
  };
}
