import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  describeSqliteContentionViolations,
  parseSqliteContentionReport,
  SQLITE_CONTENTION_BATCH_PREFIX,
  SQLITE_CONTENTION_COUNTER_KEY,
  sqliteContentionChildPath,
  type SqliteContentionMode,
  type SqliteContentionReport,
} from '@lostgradient/storage/testing/sqlite-contention';
import { NodeSQLiteStorage } from './node-sqlite.ts';

const adapterModule = import.meta.resolve('./node-sqlite.ts');

/** A racing child's exit, with what it wrote. A hung child is killed after the guard. */
function runRacingProcess(
  databasePath: string,
  mode: SqliteContentionMode,
  tag: string,
): { exited: Promise<SqliteContentionReport>; hasExited: () => boolean } {
  const child = spawn(
    process.execPath,
    [sqliteContentionChildPath, adapterModule, 'NodeSQLiteStorage', databasePath, mode, tag],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  let exited = false;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const hangGuard = setTimeout(() => child.kill('SIGKILL'), 120_000);
  return {
    hasExited: () => exited,
    exited: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => {
        exited = true;
        clearTimeout(hangGuard);
        try {
          resolve(parseSqliteContentionReport(tag, exitCode, stdout, stderr));
        } catch (error) {
          reject(error);
        }
      });
    }),
  };
}

/** Two OS processes race through NodeSQLiteStorage over one file, as the Bun suite does. */
async function raceTwoProcesses(mode: SqliteContentionMode): Promise<string[]> {
  const directory = mkdtempSync(join(tmpdir(), 'weft-node-sqlite-contention-'));
  try {
    const databasePath = join(directory, 'contention.sqlite');
    const parent = new NodeSQLiteStorage(databasePath);
    try {
      await parent.put(SQLITE_CONTENTION_COUNTER_KEY, new TextEncoder().encode('0'));

      const tags = ['a', 'b'];
      const children = tags.map((tag) => runRacingProcess(databasePath, mode, tag));
      // Release both processes together once each has opened the database. A child that exits
      // before it is ready has failed to start, so stop waiting and let its report explain.
      while (
        !children.some((child) => child.hasExited()) &&
        !tags.every((tag) => existsSync(join(directory, `ready-${tag}`)))
      ) {
        await sleep(2);
      }
      writeFileSync(join(directory, 'go'), '');
      const reports = await Promise.all(children.map((child) => child.exited));

      const counter = await parent.get(SQLITE_CONTENTION_COUNTER_KEY);
      const finalCounter = Number(new TextDecoder().decode(counter ?? undefined));
      let batchKeyCount = 0;
      for await (const key of parent.scan(SQLITE_CONTENTION_BATCH_PREFIX)) {
        void key;
        batchKeyCount += 1;
      }
      return describeSqliteContentionViolations(mode, reports, { finalCounter, batchKeyCount });
    } finally {
      parent[Symbol.dispose]();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

await describe('NodeSQLiteStorage (integration)', async () => {
  let storage: NodeSQLiteStorage;

  beforeEach(() => {
    storage = new NodeSQLiteStorage(':memory:');
  });

  afterEach(() => {
    storage[Symbol.dispose]();
  });

  await describe('get / put / delete', async () => {
    await it('returns null for a missing key', async () => {
      assert.equal(await storage.get('missing'), null);
    });

    await it('stores and retrieves a value', async () => {
      const value = new Uint8Array([1, 2, 3]);
      await storage.put('key1', value);
      const result = await storage.get('key1');
      assert.deepEqual(result, value);
    });

    await it('overwrites an existing key', async () => {
      await storage.put('key1', new Uint8Array([1]));
      await storage.put('key1', new Uint8Array([2]));
      const result = await storage.get('key1');
      assert.deepEqual(result, new Uint8Array([2]));
    });

    await it('deletes a key', async () => {
      await storage.put('key1', new Uint8Array([1]));
      await storage.delete('key1');
      assert.equal(await storage.get('key1'), null);
    });

    await it('delete on missing key is a no-op', async () => {
      // Should not throw.
      await storage.delete('nonexistent');
    });
  });

  await describe('scan', async () => {
    beforeEach(async () => {
      await storage.put('a:1', new Uint8Array([1]));
      await storage.put('a:2', new Uint8Array([2]));
      await storage.put('a:3', new Uint8Array([3]));
      await storage.put('b:1', new Uint8Array([4]));
    });

    await it('scans all keys with a matching prefix', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:')) {
        results.push(entry);
      }
      assert.equal(results.length, 3);
      assert.equal(results[0]![0], 'a:1');
      assert.equal(results[1]![0], 'a:2');
      assert.equal(results[2]![0], 'a:3');
    });

    await it('respects limit', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 2 })) {
        results.push(entry);
      }
      assert.equal(results.length, 2);
    });

    await it('supports reverse ordering', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { reverse: true })) {
        results.push(entry);
      }
      assert.equal(results[0]![0], 'a:3');
      assert.equal(results[2]![0], 'a:1');
    });

    await it('supports gt option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { gt: 'a:1' })) {
        results.push(entry);
      }
      assert.equal(results.length, 2);
      assert.equal(results[0]![0], 'a:2');
    });

    await it('supports lt option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { lt: 'a:3' })) {
        results.push(entry);
      }
      assert.equal(results.length, 2);
      assert.equal(results[1]![0], 'a:2');
    });

    await it('supports gte option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { gte: 'a:2' })) {
        results.push(entry);
      }
      assert.equal(results.length, 2);
      assert.equal(results[0]![0], 'a:2');
    });

    await it('supports lte option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { lte: 'a:2' })) {
        results.push(entry);
      }
      assert.equal(results.length, 2);
      assert.equal(results[1]![0], 'a:2');
    });

    await it('returns empty for non-matching prefix', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('z:')) {
        results.push(entry);
      }
      assert.equal(results.length, 0);
    });

    await it('caches scan statements', async () => {
      // Run two scans with the same shape but different parameters.
      const results1: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 1 })) {
        results1.push(entry);
      }
      const results2: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 2 })) {
        results2.push(entry);
      }

      // Same SQL shape → single cache entry.
      assert.equal(storage.scanStatementCacheSize, 1);
      assert.equal(results1.length, 1);
      assert.equal(results2.length, 2);
    });
  });

  await describe('batch', async () => {
    await it('applies multiple operations atomically', async () => {
      await storage.batch([
        { type: 'put', key: 'k1', value: new Uint8Array([10]) },
        { type: 'put', key: 'k2', value: new Uint8Array([20]) },
        { type: 'put', key: 'k3', value: new Uint8Array([30]) },
      ]);

      assert.deepEqual(await storage.get('k1'), new Uint8Array([10]));
      assert.deepEqual(await storage.get('k2'), new Uint8Array([20]));
      assert.deepEqual(await storage.get('k3'), new Uint8Array([30]));
    });

    await it('handles mixed put and delete operations', async () => {
      await storage.put('existing', new Uint8Array([1]));
      await storage.batch([
        { type: 'put', key: 'new', value: new Uint8Array([2]) },
        { type: 'delete', key: 'existing' },
      ]);

      assert.deepEqual(await storage.get('new'), new Uint8Array([2]));
      assert.equal(await storage.get('existing'), null);
    });

    await it('handles empty batch', async () => {
      // Should not throw.
      await storage.batch([]);
    });
  });

  await describe('conditionalBatch', async () => {
    await it('commits operations when every condition matches', async () => {
      await storage.put('expected', new Uint8Array([1]));

      const committed = await storage.conditionalBatch(
        [{ key: 'expected', expectedValue: new Uint8Array([1]) }],
        [{ type: 'put', key: 'written', value: new Uint8Array([2]) }],
      );

      assert.equal(committed, true);
      assert.deepEqual(await storage.get('written'), new Uint8Array([2]));
    });

    await it('returns false and skips writes when a condition does not match', async () => {
      await storage.put('expected', new Uint8Array([1]));

      const committed = await storage.conditionalBatch(
        [{ key: 'expected', expectedValue: new Uint8Array([9]) }],
        [{ type: 'put', key: 'skipped', value: new Uint8Array([2]) }],
      );

      assert.equal(committed, false);
      assert.equal(await storage.get('skipped'), null);
    });

    await it('supports delete operations inside a committed conditional batch', async () => {
      await storage.put('delete-me', new Uint8Array([1]));

      const committed = await storage.conditionalBatch(
        [{ key: 'missing', expectedValue: null }],
        [{ type: 'delete', key: 'delete-me' }],
      );

      assert.equal(committed, true);
      assert.equal(await storage.get('delete-me'), null);
    });
  });

  await describe('dispose', async () => {
    await it('closes the database cleanly', () => {
      const instance = new NodeSQLiteStorage(':memory:');
      // Should not throw.
      instance[Symbol.dispose]();
    });
  });

  await describe('across processes', async () => {
    await it('waits for another process holding the write lock, so a lost conditionalBatch returns false', async () => {
      assert.deepEqual(await raceTwoProcesses('conditionalBatch'), []);
    });

    await it('waits for another process holding the write lock, so a plain batch never throws', async () => {
      assert.deepEqual(await raceTwoProcesses('batch'), []);
    });
  });
});
