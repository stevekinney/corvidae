import { afterAll, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';
import {
  openPostgresTestDatabase,
  requireOpenedPostgresTestDatabase,
} from './postgres-server.test-support.ts';
import { PostgresStorage } from './postgres.ts';

const INSTANCES = 4;
const ROUNDS = 20;

// Opened at load, before any hook is timed — see `openPostgresTestDatabase`.
const database = await openPostgresTestDatabase();

/**
 * Several storages whose first operation runs at the same moment against a database
 * that lacks the key-value table (or its schema) used to race inside
 * `CREATE [SCHEMA|TABLE] IF NOT EXISTS`: the loser failed with a unique violation on
 * `pg_type_typname_nsp_index` / `pg_namespace_nspname_index`, because those statements
 * are not safe to run concurrently on separate connections.
 */
describe.skipIf(database === null)('PostgresStorage concurrent first use (live pg)', () => {
  const live = () => requireOpenedPostgresTestDatabase(database);
  afterAll(() => live()[Symbol.asyncDispose]());

  /** Run the first `get` of `INSTANCES` fresh storages together and settle every one. */
  async function firstGetsTogether(options: {
    table: string;
    schema?: string;
  }): Promise<PromiseSettledResult<Uint8Array | null>[]> {
    const storages = Array.from(
      { length: INSTANCES },
      () => new PostgresStorage({ url: live().url, ...options }),
    );
    try {
      return await Promise.allSettled(storages.map((storage) => storage.get('missing')));
    } finally {
      await Promise.all(storages.map((storage) => storage[Symbol.asyncDispose]()));
    }
  }

  function describeFailures(results: PromiseSettledResult<unknown>[]): string[] {
    return results.flatMap((result) =>
      result.status === 'rejected' ? [(result.reason as Error).message] : [],
    );
  }

  it('creates a missing table once when several storages open together', async () => {
    const admin = new Pool({ connectionString: live().url });
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        await admin.query('DROP TABLE IF EXISTS weft_concurrent_setup_kv');
        const results = await firstGetsTogether({ table: 'weft_concurrent_setup_kv' });
        expect(describeFailures(results)).toEqual([]);
        expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      }
    } finally {
      await admin.query('DROP TABLE IF EXISTS weft_concurrent_setup_kv');
      await admin.end();
    }
  });

  it('creates a missing schema and table once when several storages open together', async () => {
    const admin = new Pool({ connectionString: live().url });
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        await admin.query('DROP SCHEMA IF EXISTS weft_concurrent_setup_schema CASCADE');
        const results = await firstGetsTogether({
          table: 'weft_concurrent_setup_kv',
          schema: 'weft_concurrent_setup_schema',
        });
        expect(describeFailures(results)).toEqual([]);
        expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      }
    } finally {
      await admin.query('DROP SCHEMA IF EXISTS weft_concurrent_setup_schema CASCADE');
      await admin.end();
    }
  });
});
