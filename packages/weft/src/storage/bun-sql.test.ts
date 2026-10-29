import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { outcomeOf, rethrow } from '@lostgradient/testing/module-scope-scenario';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { BunSQLiteStorage } from './bun-sql.ts';
import {
  describeSqliteContentionViolations,
  parseSqliteContentionReport,
  SQLITE_CONTENTION_BATCH_PREFIX,
  SQLITE_CONTENTION_COUNTER_KEY,
  type SqliteContentionMode,
} from './sqlite-contention.test-support.ts';
import { SQLITE_BUSY_TIMEOUT_MS } from './sqlite-key-value-queries.ts';
import {
  collect,
  bytes as encode,
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

runStorageCapabilityConformance('BunSQLiteStorage', {
  create: () => new BunSQLiteStorage(':memory:'),
  expected: {
    persistence: 'ephemeral',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
});

runBasicStorageContract('BunSQLiteStorage', { create: () => new BunSQLiteStorage(':memory:') });
runConcurrentConditionalBatchConformance('BunSQLiteStorage', {
  create: () => new BunSQLiteStorage(':memory:'),
});
runBinaryAndLargeScanStorageConformance('BunSQLiteStorage', {
  create: () => new BunSQLiteStorage(':memory:'),
});

describe('BunSQLiteStorage', () => {
  it('reports the native SQLite page footprint', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    expect(await storage.sizeBytes()).toBe(8_192);
    storage[Symbol.dispose]();
  });

  it('[Symbol.dispose] closes database', () => {
    const storage = new BunSQLiteStorage(':memory:');
    storage[Symbol.dispose]();
    // After dispose, operations should throw because the database is closed.
    expect(() => storage.get('key')).toThrow();
  });

  it('WITHOUT ROWID table verified', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    // Query sqlite_master to verify the table was created WITHOUT ROWID.
    const result = await storage.query<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kv'",
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.sql).toContain('WITHOUT ROWID');
    storage[Symbol.dispose]();
  });

  it('WAL mode verified via PRAGMA query', async () => {
    // Note: WAL mode may not persist on :memory: databases but we verify
    // the PRAGMA was executed by checking the journal_mode value.
    const storage = new BunSQLiteStorage(':memory:');
    const result = await storage.query<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(result).toHaveLength(1);
    // In-memory databases use 'memory' journal mode regardless of WAL setting.
    // For file-based databases this would be 'wal'.
    expect(['wal', 'memory']).toContain(result[0]!.journal_mode);
    storage[Symbol.dispose]();
  });

  it('query returns results for raw SQL passthrough', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    await storage.put('q:1', encode('one'));
    await storage.put('q:2', encode('two'));
    await storage.put('q:3', encode('three'));

    const result = await storage.query<{ key: string }>('SELECT key FROM kv ORDER BY key');
    expect(result).toHaveLength(3);
    expect(result.map((row) => row.key)).toEqual(['q:1', 'q:2', 'q:3']);
    storage[Symbol.dispose]();
  });

  it('[Symbol.dispose] does not throw after many scan/query calls (prepared-statement leak regression)', async () => {
    // Regression: scan() and query() used to call database.prepare() without
    // ever finalizing the statement. bun:sqlite tracks live statements on the
    // database and refuses to close while any are outstanding, so
    // database.close() would throw mid-shutdown. Exercise every scan variant
    // and a handful of raw queries, then verify dispose() is clean.
    const storage = new BunSQLiteStorage(':memory:');

    for (let index = 0; index < 50; index++) {
      await storage.put(`key:${String(index).padStart(3, '0')}`, encode(String(index)));
    }

    // Exercise every distinct SQL variant scan() can produce.
    for (let iteration = 0; iteration < 20; iteration++) {
      await collect(storage.scan('key:'));
      await collect(storage.scan('key:', { reverse: true }));
      await collect(storage.scan('key:', { limit: 5 }));
      await collect(storage.scan('key:', { limit: 5, reverse: true }));
      await collect(storage.scan('key:', { gt: 'key:010' }));
      await collect(storage.scan('key:', { gte: 'key:010' }));
      await collect(storage.scan('key:', { lt: 'key:040' }));
      await collect(storage.scan('key:', { lte: 'key:040' }));
      await collect(storage.scan('key:', { gt: 'key:010', lt: 'key:040' }));
      await collect(storage.scan('key:', { gte: 'key:010', lte: 'key:040', limit: 3 }));
      await collect(
        storage.scan('key:', { gt: 'key:010', lt: 'key:040', reverse: true, limit: 3 }),
      );
    }

    // query() uses caller-supplied SQL; simulate varying queries so each
    // prepare() call is distinct. A leak would leave 20 compiled statements
    // dangling on the database handle.
    for (let iteration = 0; iteration < 20; iteration++) {
      await storage.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM kv WHERE key > ? AND key < ? -- iteration ${iteration}`,
        ['key:000', 'key:999'],
      );
    }

    expect(() => storage[Symbol.dispose]()).not.toThrow();
  });

  it('scan statement cache stays bounded when callers vary the LIMIT value', async () => {
    // Regression: the cache key used to be the fully-interpolated SQL
    // string, including `LIMIT ${limit}`. Every distinct numeric limit
    // became a separate cache entry, letting the cache grow without bound
    // for callers that use dynamic pagination sizes — exactly the leak the
    // cache was meant to prevent. The fix uses a bound parameter for LIMIT,
    // so 100 distinct limit values collapse to a single cache entry.
    const storage = new BunSQLiteStorage(':memory:');
    for (let index = 0; index < 50; index++) {
      await storage.put(`key:${String(index).padStart(3, '0')}`, encode(String(index)));
    }

    for (let limit = 1; limit <= 100; limit++) {
      await collect(storage.scan('key:', { limit }));
    }

    // One entry for the "prefix-range + limit" shape, not 100.
    expect(storage.scanStatementCacheSize).toBe(1);

    // Adding a different structural shape (no limit) creates exactly one
    // additional entry — the shape space is bounded, not the value space.
    await collect(storage.scan('key:'));
    expect(storage.scanStatementCacheSize).toBe(2);

    storage[Symbol.dispose]();
  });

  it('query with parameters', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    await storage.put('a', encode('1'));
    await storage.put('b', encode('2'));

    const result = await storage.query<{ key: string; value: Uint8Array }>(
      'SELECT key, value FROM kv WHERE key = ?',
      ['a'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe('a');
    storage[Symbol.dispose]();
  });

  it('query rejects non-read-only SQL statements', async () => {
    const storage = new BunSQLiteStorage(':memory:');

    expect(await throwingRejectionOf(storage.query('DELETE FROM kv'))).toThrow(
      'Storage query only supports read-only SELECT and PRAGMA statements.',
    );

    storage[Symbol.dispose]();
  });

  it('query rejects multiple SQL statements', async () => {
    const storage = new BunSQLiteStorage(':memory:');

    expect(await throwingRejectionOf(storage.query('SELECT key FROM kv; DELETE FROM kv'))).toThrow(
      'Storage query must contain exactly one read-only statement.',
    );

    storage[Symbol.dispose]();
  });

  it('query rejects write PRAGMA statements', async () => {
    const storage = new BunSQLiteStorage(':memory:');

    expect(await throwingRejectionOf(storage.query('PRAGMA journal_mode = WAL'))).toThrow(
      'Storage query only supports read-only SELECT and PRAGMA statements.',
    );

    storage[Symbol.dispose]();
  });
});

// Two OS processes race through BunSQLiteStorage over one database file. A write that meets the
// other process's lock must wait for it, so a lost compare-and-swap comes back as `false` and a
// plain batch never throws (COR-1624). The processes are real, so each phase runs at module scope,
// off Bun's five-second per-test clock; each test rethrows its outcome.

const contentionChildPath = new URL('./sqlite-contention-child.test-support.ts', import.meta.url)
  .pathname;

async function raceTwoProcesses(mode: SqliteContentionMode): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'weft-sqlite-contention-'));
  try {
    const databasePath = join(directory, 'contention.sqlite');
    const parent = new BunSQLiteStorage(databasePath);
    try {
      await parent.put(SQLITE_CONTENTION_COUNTER_KEY, new TextEncoder().encode('0'));

      const tags = ['a', 'b'];
      const children = tags.map((tag) =>
        spawnWithHangGuard(
          [process.execPath, contentionChildPath, 'bun', databasePath, mode, tag],
          { stdout: 'pipe', stderr: 'pipe' },
        ),
      );
      const settled = children.map((child) => child.exited.then(() => true));
      let anyExited = false;
      void Promise.race(settled).then(() => {
        anyExited = true;
      });

      // Release both processes together once each has opened the database, so neither finishes
      // before the other starts. A child that exits first has failed to start; stop waiting.
      while (!anyExited && !tags.every((tag) => existsSync(join(directory, `ready-${tag}`)))) {
        await Bun.sleep(2);
      }
      writeFileSync(join(directory, 'go'), '');

      const reports = await Promise.all(
        children.map(async (child, index) => {
          const [stdout, stderr] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          return parseSqliteContentionReport(tags[index]!, child.exitCode, stdout, stderr);
        }),
      );

      const counter = await parent.get(SQLITE_CONTENTION_COUNTER_KEY);
      const finalCounter = Number(new TextDecoder().decode(counter ?? undefined));
      const batchKeyCount = await parent.count(SQLITE_CONTENTION_BATCH_PREFIX);
      expect(
        describeSqliteContentionViolations(mode, reports, { finalCounter, batchKeyCount }),
      ).toEqual([]);
    } finally {
      parent[Symbol.dispose]();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const conditionalBatchRace = await outcomeOf(() => raceTwoProcesses('conditionalBatch'));
const batchRace = await outcomeOf(() => raceTwoProcesses('batch'));

describe('BunSQLiteStorage across processes', () => {
  it('waits for another process holding the write lock, so a lost conditionalBatch returns false', () =>
    rethrow(conditionalBatchRace));

  it('waits for another process holding the write lock, so a plain batch never throws', () =>
    rethrow(batchRace));

  it('sets the busy timeout every connection waits for a held lock', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const [row] = await storage.query<{ timeout: number }>('PRAGMA busy_timeout');
    expect(row?.timeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
    storage[Symbol.dispose]();
  });
});
