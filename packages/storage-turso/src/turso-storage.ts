import type { Client, Config, InValue } from '@libsql/client';

import {
  assertStorageBatchOperationCount,
  normalizeDeleteRangeOptions,
  scopedStorage,
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
  type DeleteRangeOptions,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from '@lostgradient/storage';
import {
  assertReadOnlyQuery,
  buildSqliteCountKeysByPrefix,
  buildSqliteDeleteKeysByPrefix,
  buildSqliteKeyRangeDelete,
  buildSqliteKeyRangeSelect,
  buildSqliteKeyValueRangeSelect,
  SQLITE_CREATE_KEY_VALUE_TABLE,
  SQLITE_DELETE_VALUE_BY_KEY,
  SQLITE_SELECT_KEY_PRESENCE,
  SQLITE_SELECT_VALUE_BY_KEY,
  SQLITE_UPSERT_VALUE_BY_KEY,
} from '@lostgradient/storage/sql';

const LIBSQL_CREATE_KEY_VALUE_TABLE_STATEMENT = `${SQLITE_CREATE_KEY_VALUE_TABLE};`;
const MAX_WRITE_RETRIES = 10;
const SQLITE_CONTENTION_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);

/**
 * What an entry's driver loader resolves to: the one function of a libSQL driver module this
 * adapter calls. Both `@libsql/client` and `@libsql/client/web` satisfy it.
 */
export type TursoDriver = { createClient: (configuration: Config) => Client };

/**
 * Loads a libSQL driver module. The entry that owns the adapter class supplies it as a dynamic
 * `import()` of its own driver, so the import happens at first use, never at module load, and the
 * adapter itself never asks which runtime it is on.
 */
export type TursoDriverLoader = () => Promise<TursoDriver>;

type TursoStoragePersistence = NonNullable<StorageCapabilities['persistence']>;
type TursoTransaction = Awaited<ReturnType<Client['transaction']>>;

function isSqliteBusyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    SQLITE_CONTENTION_CODES.has(error.code)
  );
}

async function beginWriteTransaction(client: Client): Promise<TursoTransaction> {
  return client.transaction('write');
}

async function rollbackBestEffort(transaction: TursoTransaction): Promise<void> {
  try {
    await transaction.rollback();
  } catch {
    // Best-effort rollback; preserve the original failure.
  }
}

async function waitForWriteRetry(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(attempt * 5, 50));
  });
}

async function executeWriteBatchWithBusyRetry(
  client: Client,
  statements: Array<{ sql: string; args: InValue[] }>,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt++) {
    try {
      await client.batch(statements, 'write');
      return;
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt === MAX_WRITE_RETRIES) {
        throw error;
      }
      await waitForWriteRetry(attempt);
    }
  }
}

async function conditionsMatch(
  transaction: TursoTransaction,
  conditions: ConditionalBatchCondition[],
): Promise<boolean> {
  for (const condition of conditions) {
    const result = await transaction.execute({
      sql: SQLITE_SELECT_VALUE_BY_KEY,
      args: [condition.key],
    });

    const raw = result.rows[0]?.['value'] as unknown;
    const currentValue =
      raw === null || raw === undefined ? null : new Uint8Array(raw as ArrayBuffer);
    if (!storageValuesEqual(currentValue, condition.expectedValue)) {
      return false;
    }
  }

  return true;
}

async function applyBatchOperations(
  transaction: TursoTransaction,
  operations: BatchOperation[],
): Promise<void> {
  for (const operation of operations) {
    if (operation.type === 'put') {
      await transaction.execute({
        sql: SQLITE_UPSERT_VALUE_BY_KEY,
        args: [operation.key, operation.value],
      });
    } else {
      await transaction.execute({
        sql: SQLITE_DELETE_VALUE_BY_KEY,
        args: [operation.key],
      });
    }
  }
}

function resolveTursoStoragePersistence(url: string): TursoStoragePersistence {
  if (url === 'file::memory:' || url === ':memory:') {
    return 'ephemeral';
  }

  if (url.startsWith('file:')) {
    return 'local';
  }

  return 'remote';
}

/**
 * Configuration for connecting to a Turso/libSQL database.
 *
 * @example
 * ```ts
 * import { TursoStorage, type TursoStorageOptions } from '@lostgradient/storage-turso';
 *
 * const options: TursoStorageOptions = {
 *   url: 'file:local.db',
 * };
 * await using storage = new TursoStorage(options);
 * ```
 */
export type TursoStorageOptions = {
  /** The database URL (e.g., `libsql://your-db.turso.io`, `file:local.db`, `file::memory:`). */
  url: string;
  /** Authentication token for remote Turso databases. */
  authToken?: string;
};

/**
 * The adapter both entries share: a `Storage` over a libSQL client that it builds, on first use,
 * from the driver its loader imports. `@lostgradient/storage-turso` and
 * `@lostgradient/storage-turso/web` each extend it with the loader for their own driver and export
 * the subclass as `TursoStorage`; this class never decides between drivers and is not itself part
 * of either entry.
 */
export class TursoClientStorage implements Storage {
  #configuration: Config;
  #loadDriver: TursoDriverLoader;
  #clientPromise: Promise<Client> | undefined;
  #persistence: TursoStoragePersistence;
  #initialized = false;
  #disposed = false;

  /**
   * @param options - the database URL and, for a remote database, its token
   * @param loadDriver - imports this entry's libSQL driver; called at most once per successful
   *   client, on the first operation
   */
  constructor(options: TursoStorageOptions, loadDriver: TursoDriverLoader) {
    this.#persistence = resolveTursoStoragePersistence(options.url);
    this.#configuration = options.authToken
      ? { url: options.url, authToken: options.authToken }
      : { url: options.url };
    this.#loadDriver = loadDriver;
  }

  async #buildClient(): Promise<Client> {
    const { createClient } = await this.#loadDriver();
    return createClient(this.#configuration);
  }

  /**
   * Resolve (and memoize) the libSQL client, importing its driver on first
   * call rather than at construction. A rejected import is not memoized, so
   * a transient failure — or a driver installed after construction but
   * before first use — can succeed on a later call instead of failing every
   * operation forever.
   *
   * Disposed is terminal, matching `createLazyPostgresPool`: once
   * {@link TursoClientStorage.[Symbol.dispose]} has run, further use throws rather
   * than silently building a fresh, unreachable client — which laziness
   * would otherwise allow, since dispose before first use has nothing yet
   * to close.
   */
  #resolveClient(): Promise<Client> {
    if (this.#disposed) {
      throw new Error(
        'TursoStorage has been disposed and cannot be reused. Construct a new adapter.',
      );
    }
    this.#clientPromise ??= this.#buildClient().catch((error: unknown) => {
      this.#clientPromise = undefined;
      throw error;
    });
    return this.#clientPromise;
  }

  /**
   * Reports the honest floor for every Turso/libSQL URL form.
   *
   * `readAfterWrite` is always `session`: one client observes its own writes,
   * but another engine instance or replica-routed client may lag. That is why
   * `assertDurableStorageForRecovery()` rejects `TursoStorage` for durable
   * recovery even when `persistence` is `local` or `remote`.
   */
  capabilities(): StorageCapabilities {
    // Scans run inside a libSQL transaction (snapshot); batch() and the range
    // deletePrefix and deleteRange are single transactional statements.
    return {
      persistence: this.#persistence,
      readAfterWrite: 'session',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    };
  }

  async #ensureTable(): Promise<Client> {
    const client = await this.#resolveClient();
    if (this.#initialized) return client;
    await client.executeMultiple(LIBSQL_CREATE_KEY_VALUE_TABLE_STATEMENT);
    this.#initialized = true;
    return client;
  }

  /** Read the value stored under `key`, or `null` when there is none. */
  async get(key: string): Promise<Uint8Array | null> {
    const client = await this.#ensureTable();

    const result = await client.execute({
      sql: SQLITE_SELECT_VALUE_BY_KEY,
      args: [key],
    });

    if (result.rows.length === 0) return null;

    const raw = result.rows[0]!['value'] as unknown;
    if (raw === null || raw === undefined) return null;
    return new Uint8Array(raw as ArrayBuffer);
  }

  /** Store `value` under `key`, replacing any earlier value. */
  async put(key: string, value: Uint8Array): Promise<void> {
    const client = await this.#ensureTable();

    await client.execute({
      sql: SQLITE_UPSERT_VALUE_BY_KEY,
      args: [key, value],
    });
  }

  /** Remove `key`; removing an absent key is not an error. */
  async delete(key: string): Promise<void> {
    const client = await this.#ensureTable();

    await client.execute({
      sql: SQLITE_DELETE_VALUE_BY_KEY,
      args: [key],
    });
  }

  /** Report whether `key` holds a value. */
  async has(key: string): Promise<boolean> {
    const client = await this.#ensureTable();

    const result = await client.execute({
      sql: SQLITE_SELECT_KEY_PRESENCE,
      args: [key],
    });

    return result.rows.length > 0;
  }

  /** Remove every key that starts with `prefix` and return how many were removed. */
  async deletePrefix(prefix: string): Promise<number> {
    const client = await this.#ensureTable();

    const { parameters, sql } = buildSqliteDeleteKeysByPrefix(prefix);
    const result = await client.execute({ sql, args: parameters });

    return result.rowsAffected;
  }

  /** Remove the keys under `prefix` that fall inside the bounds in `options` and return how many were removed. */
  async deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    const client = await this.#ensureTable();

    const normalized = normalizeDeleteRangeOptions(options);
    const { parameters, sql } = buildSqliteKeyRangeDelete(prefix, normalized);
    const result = await client.execute({
      sql,
      args: parameters,
    });

    return result.rowsAffected;
  }

  /** Iterate the `[key, value]` pairs under `prefix` in key order, within the bounds in `options`. */
  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const client = await this.#ensureTable();

    const { parameters, sql } = buildSqliteKeyValueRangeSelect(prefix, options);
    const result = await client.execute({
      sql,
      args: parameters,
    });

    for (const row of result.rows) {
      const key = row['key'] as string;
      const raw = row['value'] as unknown;
      const value = new Uint8Array(raw as ArrayBuffer);
      yield [key, value];
    }
  }

  /** Iterate the keys under `prefix` in key order, within the bounds in `options`. */
  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    const client = await this.#ensureTable();

    const { parameters, sql } = buildSqliteKeyRangeSelect(prefix, options);
    const result = await client.execute({
      sql,
      args: parameters,
    });

    for (const row of result.rows) {
      yield row['key'] as string;
    }
  }

  /** Count the keys that start with `prefix`. */
  async count(prefix: string): Promise<number> {
    const client = await this.#ensureTable();

    const { parameters, sql } = buildSqliteCountKeysByPrefix(prefix);
    const result = await client.execute({ sql, args: parameters });

    return Number(result.rows[0]?.['count'] ?? 0);
  }

  /** A `Storage` view of this one in which every key is prefixed with `prefix`. */
  scoped(prefix: string): Storage {
    const scoped = scopedStorage(this, prefix);
    return scoped;
  }

  /** Apply `operations` in one write transaction, retrying while the database is busy or locked. */
  async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    if (operations.length === 0) return;

    const client = await this.#ensureTable();

    const statements = operations.map((operation) => {
      if (operation.type === 'put') {
        return {
          sql: SQLITE_UPSERT_VALUE_BY_KEY,
          args: [operation.key, operation.value] as InValue[],
        };
      }
      return {
        sql: SQLITE_DELETE_VALUE_BY_KEY,
        args: [operation.key] as InValue[],
      };
    });

    await executeWriteBatchWithBusyRetry(client, statements);
  }

  /** Apply `operations` in one write transaction only if every condition in `conditions` still matches; returns whether they were applied. */
  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
    assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

    const client = await this.#ensureTable();

    let lastContentionError: unknown;
    for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt++) {
      let transaction: TursoTransaction | undefined;
      try {
        transaction = await beginWriteTransaction(client);
        await transaction.executeMultiple(LIBSQL_CREATE_KEY_VALUE_TABLE_STATEMENT);

        if (!(await conditionsMatch(transaction, conditions))) {
          await transaction.rollback();
          return false;
        }

        await applyBatchOperations(transaction, operations);
        await transaction.commit();
        return true;
      } catch (error) {
        if (transaction !== undefined) {
          await rollbackBestEffort(transaction);
        }
        if (!isSqliteBusyError(error)) {
          throw error;
        }
        lastContentionError = error;
        if (attempt < MAX_WRITE_RETRIES) {
          await waitForWriteRetry(attempt);
        }
      }
    }

    throw new Error(
      `conditionalBatch exhausted ${MAX_WRITE_RETRIES} attempts after SQLite contention failures`,
      { cause: lastContentionError },
    );
  }

  /** Run a read-only SQL statement and return its rows; any statement that could write is rejected. */
  async query<T>(sql: string, parameters?: unknown[]): Promise<T[]> {
    const client = await this.#ensureTable();
    assertReadOnlyQuery(sql);

    const result = await client.execute({
      sql,
      args: (parameters ?? []) as InValue[],
    });

    return result.rows as unknown as T[];
  }

  /**
   * Marks this storage disposed (terminal — see {@link TursoClientStorage.#resolveClient})
   * and best-effort closes the underlying client. If the client was never
   * resolved (no operation ever ran), there is nothing to close, and any
   * later use throws instead of silently constructing one; the client is
   * closed once its own import settles, rather than blocking this
   * synchronous method on it.
   */
  [Symbol.dispose](): void {
    this.#disposed = true;
    if (this.#clientPromise === undefined) return;
    void this.#clientPromise.then((client) => client.close()).catch(() => {});
  }
}
