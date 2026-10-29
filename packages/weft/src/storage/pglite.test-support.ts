import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll } from 'bun:test';

import type { PostgresPool } from '@lostgradient/storage/sql';
import { pgliteAsPostgresPool } from '@lostgradient/storage/testing';

export type PGliteTestFixture = {
  readonly database: PGlite;
  readonly pool: PostgresPool;
  reset(): Promise<void>;
};

type PGliteTestLifecycle = {
  beforeAll(callback: () => void | Promise<void>): void;
  afterAll(callback: () => void | Promise<void>): void;
};

/**
 * Own a shared in-memory Postgres for a test file. Booting PGlite is expensive,
 * so cases reuse one database and reset the shared `kv` table between runs.
 */
export function createPGliteTestFixture(
  lifecycle: PGliteTestLifecycle = { afterAll, beforeAll },
): PGliteTestFixture {
  let database: PGlite | undefined;

  lifecycle.beforeAll(async () => {
    database = await new PGlite();
    await database.query('SELECT 1');
  });

  lifecycle.afterAll(async () => {
    await database?.close();
    database = undefined;
  });

  function getDatabase(): PGlite {
    if (!database) {
      throw new Error('PGlite test fixture is not running');
    }
    return database;
  }

  return {
    get database() {
      return getDatabase();
    },
    pool: pgliteAsPostgresPool(getDatabase),
    async reset() {
      const activeDatabase = getDatabase();
      await activeDatabase.query(
        'CREATE TABLE IF NOT EXISTS kv (key TEXT COLLATE "C" PRIMARY KEY, value BYTEA NOT NULL)',
      );
      await activeDatabase.query('DELETE FROM kv');
    },
  };
}
