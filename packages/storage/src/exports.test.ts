import { describe, expect, it } from 'bun:test';

import * as storage from './index.ts';
import * as sql from './sql/index.ts';
import * as testing from './testing/index.ts';
import * as sqliteContention from './testing/sqlite-contention.test-support.ts';

function expectExports(entry: object, names: readonly string[]): void {
  for (const name of names) expect(Reflect.has(entry, name), name).toBe(true);
}

describe('@lostgradient/storage entries', () => {
  it('exports the protocol from the main entry', () => {
    expectExports(storage, [
      'MAX_BATCH_OPERATIONS',
      'MAX_SCAN_LIMIT',
      'StorageBatchOperationLimitExceededError',
      'assertStorageBatchOperationCount',
      'resolvePrefixRangeEnd',
      'matchesScanOptions',
      'storageValuesEqual',
      'storageHas',
      'storageKeys',
      'storageCount',
      'storageDeletePrefix',
      'storageBatch',
      'storageConditionalBatch',
      'requireStorageCapability',
      'assertDurableStorageForRecovery',
      'storageDeleteRange',
      'normalizeDeleteRangeOptions',
      'resolveDeleteRangeBounds',
      'storageHasCore',
      'storageCountCore',
      'storageDeletePrefixCore',
      'storageDeleteRangeCore',
      'ScopedStorage',
      'scopedStorage',
      'MemoryStorage',
      'textValueStore',
      'copyTextKeyValueRowsToStorage',
      'encodeStorageKeyComponent',
      'decodeStorageKeyComponent',
      'tryDecodeStorageKeyComponent',
      'formatSortableStorageTimestamp',
      'encodeBytesToBase64',
      'decodeBase64ToBytes',
      'isRecord',
    ]);
    expect(Reflect.has(storage, 'KEYS')).toBe(false);
  });

  it('exports what the SQL adapters share from the sql entry', () => {
    expectExports(sql, [
      'PostgresKeyValueStorage',
      'createLazyPostgresPool',
      'buildPostgresKeyValueQueries',
      'resolvePostgresTableReference',
      'assertReadOnlyQuery',
      'conditionsHold',
      'writeBatchNetEffect',
      'resolveBatchNetEffect',
    ]);
  });

  it('exports the contract runners and shared test support from the testing entry', () => {
    expectExports(testing, [
      'runBasicStorageContract',
      'runStorageCapabilityConformance',
      'runBinaryAndLargeScanStorageConformance',
      'runConcurrentConditionalBatchConformance',
      'pgliteAsPostgresPool',
      'createDiskBackedTestFixture',
      'sqliteDatabaseSidecarSuffixes',
      'sqliteContentionChildPath',
      'parseSqliteContentionReport',
      'describeSqliteContentionViolations',
      'FixtureScope',
      'closeIfOpen',
      'makeNullValueFailingBatch',
      'isFullyCheckpointed',
      'describeBatchAtomicitySuite',
      'describeWalDurabilitySuite',
      'runMidTransactionKillSuite',
    ]);
  });

  it('exports the contention support alone from a subpath Node can load without bun:test', () => {
    expectExports(sqliteContention, [
      'sqliteContentionChildPath',
      'parseSqliteContentionReport',
      'describeSqliteContentionViolations',
    ]);
  });

  it('keeps the storage key helpers workspace consumers use', () => {
    const encoded = storage.encodeStorageKeyComponent('memory:tenant/item');
    expect(encoded).toBe('memory%3Atenant%2Fitem');
    expect(storage.decodeStorageKeyComponent(encoded)).toBe('memory:tenant/item');
    expect(storage.tryDecodeStorageKeyComponent('%GG')).toBeNull();
    expect(storage.formatSortableStorageTimestamp(123)).toBe('0000000000000123');
  });
});
