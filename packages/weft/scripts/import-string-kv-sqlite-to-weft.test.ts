import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { linkSync, symlinkSync } from 'node:fs';

import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
} from '@lostgradient/storage/testing';
import { BunSQLiteStorage } from '../src/storage/bun-sql.ts';
import { runImportStringKeyValueCommand } from './import-string-kv-sqlite-to-weft.ts';

function createSqliteFixture(prefix: string) {
  return createDiskBackedTestFixture({
    prefix,
    suffix: '.db',
    sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
  });
}

function seedSourceDatabase(path: string, tableName = 'kv'): void {
  const database = new Database(path);
  try {
    database.exec(`CREATE TABLE ${tableName} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    database
      .prepare(`INSERT INTO ${tableName} (key, value) VALUES (?, ?)`)
      .run('session:1', 'hello');
    database
      .prepare(`INSERT INTO ${tableName} (key, value) VALUES (?, ?)`)
      .run('session:2', 'world');
  } finally {
    database.close();
  }
}

type CommandResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Runs the import command in process with `console` captured. Spawning
 * `bun scripts/import-string-kv-sqlite-to-weft.ts` would put a Bun boot inside every test's
 * 5 s budget, which times out under host load.
 */
async function runImportScript(arguments_: string[]): Promise<CommandResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]): void => {
    stdout.push(values.map(String).join(' '));
  };
  console.error = (...values: unknown[]): void => {
    stderr.push(values.map(String).join(' '));
  };
  try {
    const exitCode = await runImportStringKeyValueCommand(arguments_);
    return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

function createSameFileLink(sourcePath: string, targetPath: string): void {
  try {
    symlinkSync(sourcePath, targetPath);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    linkSync(sourcePath, targetPath);
  }
}

describe('import-string-kv-sqlite-to-weft', () => {
  it('copies source kv rows into a prefixed Weft SQLite target', async () => {
    const source = createSqliteFixture('string-kv-source');
    const target = createSqliteFixture('string-kv-target');
    seedSourceDatabase(source.path);

    try {
      const result = await runImportScript([
        '--source',
        source.path,
        '--target',
        target.path,
        '--target-prefix',
        'app:my-service',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Copied 2 text key-value rows');

      using storage = new BunSQLiteStorage(target.path);
      expect(decode(await storage.get('app:my-service:session:1'))).toBe('hello');
      expect(decode(await storage.get('app:my-service:session:2'))).toBe('world');
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('rejects source and target paths that resolve to the same database file', async () => {
    const source = createSqliteFixture('string-kv-same-path');
    seedSourceDatabase(source.path);

    try {
      const result = await runImportScript([
        '--source',
        source.path,
        '--target',
        source.path,
        '--target-prefix',
        'app:my-service',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Source and target SQLite paths must be different');
    } finally {
      source.cleanup();
    }
  });

  it('rejects source and target paths that point at the same file through a symlink', async () => {
    const source = createSqliteFixture('string-kv-symlink-source');
    const symlink = createSqliteFixture('string-kv-symlink-target');
    seedSourceDatabase(source.path);

    try {
      symlink.cleanup();
      createSameFileLink(source.path, symlink.path);
      const result = await runImportScript([
        '--source',
        source.path,
        '--target',
        symlink.path,
        '--target-prefix',
        'app:my-service',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Source and target SQLite paths must be different');
    } finally {
      source.cleanup();
      symlink.cleanup();
    }
  });

  it('rejects target prefixes that normalize to empty', async () => {
    const source = createSqliteFixture('string-kv-empty-prefix-source');
    const target = createSqliteFixture('string-kv-empty-prefix-target');
    seedSourceDatabase(source.path);

    try {
      const result = await runImportScript([
        '--source',
        source.path,
        '--target',
        target.path,
        '--target-prefix',
        ':',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Target prefix must not be empty');
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('rejects a missing source table before writing target rows', async () => {
    const source = createSqliteFixture('string-kv-missing-source-table');
    const target = createSqliteFixture('string-kv-missing-target-table');
    const database = new Database(source.path);
    database.close();

    try {
      const result = await runImportScript([
        '--source',
        source.path,
        '--target',
        target.path,
        '--target-prefix',
        'app:my-service',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Source SQLite database does not contain table "kv"');
      using storage = new BunSQLiteStorage(target.path);
      expect(await Array.fromAsync(storage.scan('app:my-service:'))).toEqual([]);
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('rejects unsafe source table names', async () => {
    const source = createSqliteFixture('string-kv-invalid-table-source');
    const target = createSqliteFixture('string-kv-invalid-table-target');
    seedSourceDatabase(source.path);

    try {
      const result = await runImportScript([
        '--source',
        source.path,
        '--target',
        target.path,
        '--target-prefix',
        'app:my-service',
        '--source-table',
        'kv;DROP TABLE kv',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Source table name must be a SQLite identifier');
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('rejects target prefixes in Weft reserved keyspace', async () => {
    const source = createSqliteFixture('string-kv-reserved-prefix-source');
    const target = createSqliteFixture('string-kv-reserved-prefix-target');
    seedSourceDatabase(source.path);

    try {
      const result = await runImportScript([
        '--source',
        source.path,
        '--target',
        target.path,
        '--target-prefix',
        'wf',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Text key-value import target key "wf:session:1" uses a Weft-reserved key prefix',
      );
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('refuses to overwrite existing target keys', async () => {
    const source = createSqliteFixture('string-kv-overwrite-source');
    const target = createSqliteFixture('string-kv-overwrite-target');
    seedSourceDatabase(source.path);
    {
      using storage = new BunSQLiteStorage(target.path);
      await storage.put('app:my-service:session:1', new TextEncoder().encode('existing'));
    }

    try {
      const result = await runImportScript([
        '--source',
        source.path,
        '--target',
        target.path,
        '--target-prefix',
        'app:my-service',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Target storage already contains key "app:my-service:session:1"',
      );
      using storage = new BunSQLiteStorage(target.path);
      expect(decode(await storage.get('app:my-service:session:1'))).toBe('existing');
      expect(await storage.get('app:my-service:session:2')).toBeNull();
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('prints usage and exits 0 for --help', async () => {
    const result = await runImportScript(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Usage:');
  });

  it('prints usage and exits 1 when a required option is missing', async () => {
    const result = await runImportScript(['--source', 'only-a-source.db']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--target-prefix <prefix>  Required.');
  });

  it('rejects a source table whose value column is not text', async () => {
    const source = createSqliteFixture('string-kv-non-text-source');
    const target = createSqliteFixture('string-kv-non-text-target');
    const database = new Database(source.path);
    try {
      database.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
      database.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('session:1', 1);
    } finally {
      database.close();
    }

    try {
      const result = await runImportScript([
        '--source',
        source.path,
        '--target',
        target.path,
        '--target-prefix',
        'app:my-service',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Source table "kv" must expose string key and value columns named "key" and "value".',
      );
    } finally {
      source.cleanup();
      target.cleanup();
    }
  });

  it('exits 1 when the target directory does not exist', async () => {
    const source = createSqliteFixture('string-kv-missing-target-directory');
    seedSourceDatabase(source.path);

    try {
      const result = await runImportScript([
        '--source',
        source.path,
        '--target',
        `${source.path}-missing-directory/target.db`,
        '--target-prefix',
        'app:my-service',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
    } finally {
      source.cleanup();
    }
  });
});
