import { afterEach, describe, expect, it } from 'bun:test';

import {
  benchmarkWorkload,
  generateCheckpointValue,
  runArchitectureBenchmark,
  runBatchWriteBenchmark,
  TARGET_WRITES_PER_SECOND,
} from '../../src/storage/bun-sql-workload.test-support.ts';
import { BunSQLiteStorage } from '../../src/storage/bun-sql.ts';
import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
} from '../../src/testing/storage-backends.test-support.ts';

/**
 * The throughput gate, declared through `skipIf` so `WEFT_SQLITE_ARCHITECTURE_BENCHMARK=1`
 * actually governs it. It lives here, outside weft's default `test` run (a `*.bench.ts` file is
 * never discovered by it), because a median-throughput assertion measures the host as much as the code;
 * the integrity tests in `src/storage/bun-sql-integrity.test.ts` stay in the default suite.
 */
const runSQLiteArchitectureBenchmark = it.skipIf(!runArchitectureBenchmark);

describe('BunSQLiteStorage benchmark', () => {
  const fixtureCleanups: Array<() => void> = [];

  function createStorage(): BunSQLiteStorage {
    const fixture = createDiskBackedTestFixture({
      prefix: 'sqlite-bench',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    fixtureCleanups.push(fixture.cleanup);
    return new BunSQLiteStorage(fixture.path);
  }

  afterEach(() => {
    for (const cleanup of fixtureCleanups) {
      cleanup();
    }
    fixtureCleanups.length = 0;
  });

  runSQLiteArchitectureBenchmark(
    `median batch writes exceed ${TARGET_WRITES_PER_SECOND.toLocaleString()} writes/sec`,
    async () => {
      const storage = createStorage();
      const value = generateCheckpointValue();

      const { medianWritesPerSecond } = await runBatchWriteBenchmark(
        storage,
        value,
        benchmarkWorkload,
      );
      expect(medianWritesPerSecond).toBeGreaterThanOrEqual(TARGET_WRITES_PER_SECOND);

      storage[Symbol.dispose]();
    },
  );
});
