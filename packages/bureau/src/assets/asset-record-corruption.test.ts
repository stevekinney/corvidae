/**
 * COR-1581 — a stored asset record that cannot be read as one fails with its own typed error, so
 * a caller can tell a record someone must repair (permanent) from a backend that is merely
 * unavailable (transient). The shape check covers what the service reads; a stored `null` is no
 * record at all, so it stays not found.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import {
  AssetNotFoundError,
  AssetRecordCorruptError,
  AssetUnavailableError,
  type AssetStorage,
} from '../index';
import { alice, createAssetHarness, pngBytes } from '../testing/asset-fixtures.test-support';
import { createMemoryAssetStorageFixture } from '../test/asset-storage-fixtures';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import { KEYS } from './records';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function openWithAsset() {
  const fixture = createMemoryAssetStorageFixture({});
  cleanups.push(() => fixture.dispose());
  const opened = await createAssetHarness({ storage: fixture.storage });
  cleanups.push(async () => {
    await opened.harness.close();
  });
  const admission = await opened.assets.admit(
    { source: { kind: 'inline', bytes: pngBytes(2, 2) } },
    alice,
  );
  const result = await admission.work.result();
  if (result.outcome !== 'completed') throw new Error('the admission did not complete');
  return { ...opened, storage: fixture.storage, assetId: admission.assetId };
}

async function storedRecord(
  storage: AssetStorage,
  assetId: string,
): Promise<Record<string, unknown>> {
  return JSON.parse((await storage.get(KEYS.record(assetId)))!) as Record<string, unknown>;
}

const reference = { holderId: 'holder-1', until: '2030-01-01T00:00:00.000Z' };

const corruptions: ReadonlyArray<
  readonly [name: string, corrupt: (record: Record<string, unknown>) => string]
> = [
  ['JSON that does not parse', () => '{not json'],
  ['a JSON value that is not an object', () => '42'],
  ['a JSON array', () => '[]'],
  ['a version other than 1', (record) => JSON.stringify({ ...record, version: 2 })],
  ['a missing version', ({ version: _version, ...rest }) => JSON.stringify(rest)],
  ['a missing owner', ({ ownerId: _owner, ...rest }) => JSON.stringify(rest)],
  ['a numeric asset id', (record) => JSON.stringify({ ...record, assetId: 7 })],
  ['a string revision', (record) => JSON.stringify({ ...record, revision: '1' })],
  ['references that are not an array', (record) => JSON.stringify({ ...record, references: {} })],
  ['a missing readers array', ({ readers: _readers, ...rest }) => JSON.stringify(rest)],
  ['a missing media object', ({ media: _media, ...rest }) => JSON.stringify(rest)],
  ['media that is an array', (record) => JSON.stringify({ ...record, media: [] })],
  ['a missing holds array', ({ holds: _holds, ...rest }) => JSON.stringify(rest)],
  ['a missing safety array', ({ safety: _safety, ...rest }) => JSON.stringify(rest)],
  [
    'a missing providerCopies array',
    ({ providerCopies: _copies, ...rest }) => JSON.stringify(rest),
  ],
  [
    'a reference without a holderId',
    (record) => JSON.stringify({ ...record, references: [{ until: reference.until }] }),
  ],
  [
    'a reference without an until',
    (record) => JSON.stringify({ ...record, references: [{ holderId: 'h' }] }),
  ],
  [
    'a reference that is not an object',
    (record) => JSON.stringify({ ...record, references: ['h'] }),
  ],
];

describe('a corrupt stored asset record', () => {
  it.each(corruptions)(
    'fails retain, inspect and resolve with AssetRecordCorruptError for %s',
    async (_name, corrupt) => {
      const opened = await openWithAsset();
      const record = await storedRecord(opened.storage, opened.assetId);
      await opened.storage.set(KEYS.record(opened.assetId), corrupt(record));

      for (const operation of [
        () => opened.assets.retain(opened.assetId, alice, reference),
        () => opened.assets.inspect(opened.assetId, alice),
        () => opened.assets.resolve({ kind: 'managed-asset', assetId: opened.assetId }, alice),
      ]) {
        const error = await rejectionOf(operation());
        expect(error).toBeInstanceOf(AssetRecordCorruptError);
        expect((error as AssetRecordCorruptError).assetId).toBe(opened.assetId);
      }
    },
  );

  it('names the asset and the member, never the record', async () => {
    const opened = await openWithAsset();
    const record = await storedRecord(opened.storage, opened.assetId);
    await opened.storage.set(
      KEYS.record(opened.assetId),
      JSON.stringify({ ...record, ownerId: undefined, revision: 'secret-looking-value' }),
    );

    const error = await rejectionOf(opened.assets.inspect(opened.assetId, alice));

    expect(error).toBeInstanceOf(AssetRecordCorruptError);
    expect((error as Error).message).toContain(opened.assetId);
    expect((error as Error).message).not.toContain('secret-looking-value');
  });

  it('is not confused with a record that is merely not available to the caller', async () => {
    const opened = await openWithAsset();
    const record = await storedRecord(opened.storage, opened.assetId);
    await opened.storage.set(
      KEYS.record(opened.assetId),
      JSON.stringify({ ...record, state: 'expired' }),
    );

    expect(
      await rejectionOf(opened.assets.retain(opened.assetId, alice, reference)),
    ).toBeInstanceOf(AssetUnavailableError);
  });

  it('keeps a stored null record as not found', async () => {
    const opened = await openWithAsset();
    await opened.storage.set(KEYS.record(opened.assetId), 'null');

    expect(
      await rejectionOf(opened.assets.retain(opened.assetId, alice, reference)),
    ).toBeInstanceOf(AssetNotFoundError);
    expect(await rejectionOf(opened.assets.inspect(opened.assetId, alice))).toBeInstanceOf(
      AssetNotFoundError,
    );
  });

  it('accepts a well-formed record', async () => {
    const opened = await openWithAsset();

    const descriptor = await opened.assets.retain(opened.assetId, alice, reference);

    expect(descriptor.assetId).toBe(opened.assetId);
  });
});
