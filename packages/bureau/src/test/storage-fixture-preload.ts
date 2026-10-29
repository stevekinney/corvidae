/**
 * Bureau's test preload (COR-1767). Fails the run, naming where each one was created, when a
 * storage fixture is still registered after the tests in this worker have finished: a fixture
 * that was never disposed leaves its database handles open and its files on disk.
 *
 * The registry is on `globalThis` (see `storage-fixtures.ts`), so this sees the fixtures every
 * test file in the worker created even when the runner evaluates modules once per file.
 *
 * @module test/storage-fixture-preload
 */
import { afterAll } from 'bun:test';

import { undisposedStorageFixtures } from './storage-fixtures';

afterAll(() => {
  const undisposed = undisposedStorageFixtures();
  if (undisposed.length > 0) {
    throw new Error(
      `${undisposed.length} storage fixture(s) were never disposed. Dispose each with \`await using\`, \`dispose()\`, or an \`afterEach\`:\n${undisposed.join('\n')}`,
    );
  }
});
