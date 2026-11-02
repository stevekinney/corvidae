import {
  createLazyPostgresPool,
  PostgresKeyValueStorage,
  type PostgresKeyValueStorageOptions,
  type PostgresPool,
} from '@lostgradient/storage/sql';
import type pg from 'pg';

/**
 * Configuration for connecting to a standard Postgres database over the ordinary
 * wire protocol via the `pg` (node-postgres) driver. Alias of the shared
 * {@link PostgresKeyValueStorageOptions}; `url` is optional and required only when
 * no `pool` is supplied.
 *
 * @example
 * ```ts
 * import { PostgresStorage, type PostgresStorageOptions } from '@lostgradient/storage-postgres';
 *
 * const options: PostgresStorageOptions = {
 *   url: 'postgresql://user:password@localhost:5432/weft',
 * };
 * await using storage = new PostgresStorage(options);
 * ```
 */
export type PostgresStorageOptions = PostgresKeyValueStorageOptions;

/**
 * Wrap a `pg` pool so `end()` resolves only after every connection it opened has closed.
 *
 * `pg.Pool#end()` resolves as soon as the pool has called `client.end()` on each idle client,
 * which only sends the terminate message: the sockets close afterwards. A caller that stops the
 * database right after a disposed storage (a test cluster, a rolling deploy) would then race the
 * backends' own shutdown, and a client the server terminated first (57P01, "terminating
 * connection due to administrator command") reaches the pool's idle-client error listener,
 * which re-emits it as an unhandled `error` event on the pool (COR-2004).
 */
function endAfterClientsClose(pool: pg.Pool): PostgresPool {
  const closing = new Map<pg.PoolClient, Promise<void>>();
  pool.on('connect', (client) => {
    closing.set(
      client,
      new Promise<void>((resolve) => {
        client.once('end', () => {
          closing.delete(client);
          resolve();
        });
      }),
    );
  });
  return {
    query: (sql, parameters) => pool.query(sql, parameters),
    connect: () => pool.connect(),
    end: async () => {
      await pool.end();
      await Promise.all(closing.values());
    },
  };
}

/**
 * Construct the `pg` default pool for `url`, deferring the `pg` import until the
 * pool is first used, so the injected-pool path (tests, a shared application pool)
 * needs zero `pg` install. The lazy-import memoization, dispose guards, and
 * missing-dependency error live in {@link createLazyPostgresPool}; this factory
 * only supplies HOW to load the driver.
 *
 * A `pg.Pool` structurally satisfies {@link PostgresPool}: `query(sql, params)`,
 * `connect()`, and `end()` line up, a `pg.PoolClient` provides `query`/`release`,
 * and a `pg.QueryResult` (`{ rows, rowCount }`) satisfies the value mapper. The
 * default export is used so `pg`'s CommonJS interop resolves the `Pool`
 * constructor under both Bun and Node.
 */
function postgresPoolFactory(url: string): PostgresPool {
  return createLazyPostgresPool(url, {
    driverName: 'pg',
    storageName: 'PostgresStorage',
    loadPool: async (connectionString) => {
      const { default: pg } = await import('pg');
      return endAfterClientsClose(new pg.Pool({ connectionString }));
    },
  });
}

/**
 * Storage adapter backed by a standard Postgres server over the ordinary wire
 * protocol via the `pg` (node-postgres) driver. A thin
 * {@link PostgresKeyValueStorage} subclass whose only job is to supply the `pg`
 * default pool factory; all storage behavior (SQL, value mapping,
 * transactions/retry, schema/table qualification) lives in the driver-agnostic
 * base. Implements the same `Storage` interface as the SQLite adapters over a
 * single `kv(key TEXT COLLATE "C", value BYTEA)` table.
 *
 * Use this instead of the Neon serverless adapter when connecting to a self-hosted or
 * managed Postgres over TCP — including sharing the same database as your
 * application's tables by pointing `schema` at a dedicated Weft schema. The Neon
 * serverless (WebSocket) driver is not required and never imported.
 *
 * **Endpoint assumption.** `capabilities()` reports `readAfterWrite:
 * 'linearizable'`, which holds for the **primary** endpoint. A read-replica
 * connection string would violate that guarantee — point this adapter at the
 * primary.
 *
 * @example
 * ```ts
 * import { PostgresStorage } from '@lostgradient/storage-postgres';
 *
 * await using storage = new PostgresStorage({
 *   url: process.env['DATABASE_URL']!,
 * });
 * await storage.put('app:greeting', new TextEncoder().encode('hello'));
 * ```
 */
export class PostgresStorage extends PostgresKeyValueStorage {
  /**
   * @param options Connection configuration ({@link PostgresStorageOptions}).
   * @param poolFactory Internal seam for constructing the owned pool from `url`.
   *   Defaults to lazily importing the real `pg` `Pool`; tests inject a fake to
   *   exercise owned-pool teardown without a network. Used only when no `pool` is
   *   supplied; an injected `pool` stays caller-owned.
   */
  constructor(
    options: PostgresStorageOptions,
    poolFactory: (url: string) => PostgresPool = postgresPoolFactory,
  ) {
    super(options, poolFactory);
  }
}
