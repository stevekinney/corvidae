import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { storageScanWithMetadata, storageStat } from '@lostgradient/storage';
import {
  collect,
  decodeText,
  bytes as encode,
  runStorageWriteTimeContract,
} from '@lostgradient/storage/testing';
import { BunSQLiteStorage } from './bun-sql.ts';

runStorageWriteTimeContract('BunSQLiteStorage', {
  create: (now) => new BunSQLiteStorage(':memory:', { now }),
});

function withDatabaseFile(run: (path: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'weft-sqlite-write-time-'));
  return run(join(directory, 'storage.db')).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

describe('BunSQLiteStorage write times', () => {
  it('reads the write time from Date.now when no clock is given', async () => {
    using storage = new BunSQLiteStorage(':memory:');
    await storage.put('key', encode('value'));
    const metadata = await storageStat(storage, 'key');
    expect(Number.isInteger(metadata?.updatedAt)).toBe(true);
  });

  it('opens a file written before write times, keeps its rows readable, and stamps new writes', () =>
    withDatabaseFile(async (path) => {
      // The table every earlier release created: two columns, no write time.
      const older = new Database(path);
      older.exec(
        'CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID; ' +
          "INSERT INTO kv (key, value) VALUES ('memory:goals', X'6f6c64')",
      );
      older.close();

      {
        using storage = new BunSQLiteStorage(path, { now: () => 9_000 });
        expect(decodeText((await storage.get('memory:goals'))!)).toBe('old');
        expect(await storageStat(storage, 'memory:goals')).toEqual({ updatedAt: null });

        await storage.put('memory:preferences', encode('new'));
        const entries = await collect(storageScanWithMetadata(storage, 'memory:'));
        expect(entries.map(([key, value, metadata]) => [key, decodeText(value), metadata])).toEqual(
          [
            ['memory:goals', 'old', { updatedAt: null }],
            ['memory:preferences', 'new', { updatedAt: 9_000 }],
          ],
        );

        const [table] = await storage.query<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kv'",
        );
        expect(table?.sql).toContain('WITHOUT ROWID');
        expect(table?.sql).toContain('updated_at INTEGER');
      }

      // Opening it again finds the column already there and keeps every time it recorded.
      using reopened = new BunSQLiteStorage(path, { now: () => 10_000 });
      expect(await storageStat(reopened, 'memory:preferences')).toEqual({ updatedAt: 9_000 });
      await reopened.put('memory:goals', encode('rewritten'));
      expect(await storageStat(reopened, 'memory:goals')).toEqual({ updatedAt: 10_000 });
    }));
});
