/**
 * Node-compatible SQLite storage adapter using `better-sqlite3`.
 *
 * Implements the same `Storage` interface and SQL schema as `BunSQLiteStorage`
 * but uses `better-sqlite3` instead of `bun:sqlite`, enabling the same
 * storage layer to run on Node.js 22+.
 *
 * @module storage/node-sqlite
 */

import BetterSqlite3 from 'better-sqlite3';

import {
  assertStorageBatchOperationCount,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from '@lostgradient/storage';
import {
  buildSqliteKeyValueRangeSelect,
  runConditionalBatchBody,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_CREATE_KEY_VALUE_TABLE,
  SQLITE_DELETE_VALUE_BY_KEY,
  SQLITE_SELECT_VALUE_BY_KEY,
  SQLITE_UPSERT_VALUE_BY_KEY,
} from '@lostgradient/storage/sql';
import {
  createMissingBetterSqlite3Error,
  isBetterSqlite3LoadFailure,
  type BetterSqliteConstructor,
  type BetterSqliteDatabase,
  type BetterSqliteStatement,
  type BetterSqliteTransaction,
} from './node-sqlite-loader.ts';

type NodeSQLiteStoragePersistence = NonNullable<StorageCapabilities['persistence']>;

/**
 * SQLite-backed {@link Storage} using `better-sqlite3` for Node.js 22+
 * environments.
 *
 * Implements the same WAL-mode schema as `BunSQLiteStorage` but resolves the
 * `better-sqlite3` native binding when the first database opens, so the
 * module imports under any runtime and a refused or never-compiled binding surfaces from the
 * constructor as an actionable error.
 *
 * Unlike `BunSQLiteStorage`, this adapter currently implements only the required
 * Storage methods (`get`, `put`, `delete`, `scan`, `batch`, and
 * `conditionalBatch`). The optional `has`, `keys`, `count`, `deletePrefix`, and
 * `scoped` helpers fall back to the generic implementations in
 * `@lostgradient/storage`; `deleteRange` falls back to `storageDeleteRange`
 * (also exported from `@lostgradient/storage`). There is no SQL passthrough
 * `query()` method.
 *
 * @example
 * ```ts
 * import { NodeSQLiteStorage } from '@lostgradient/storage-node-sqlite';
 *
 * using storage = new NodeSQLiteStorage('./app.sqlite');
 *
 * await storage.put('app:orders:1', new TextEncoder().encode('open'));
 * console.log(new TextDecoder().decode((await storage.get('app:orders:1')) ?? undefined)); // 'open'
 * ```
 */
export class NodeSQLiteStorage implements Storage {
  #database: BetterSqliteDatabase;
  #persistence: NodeSQLiteStoragePersistence;
  #getStatement: BetterSqliteStatement;
  #putStatement: BetterSqliteStatement;
  #deleteStatement: BetterSqliteStatement;
  #batchTransaction: BetterSqliteTransaction;
  #scanStatements: Map<string, BetterSqliteStatement> = new Map();

  /**
   * Number of distinct prepared-statement cache entries for scan().
   * Exposed for regression tests that assert the cache stays bounded.
   */
  get scanStatementCacheSize(): number {
    return this.#scanStatements.size;
  }

  capabilities(): StorageCapabilities {
    // Single-process WAL SQLite (better-sqlite3): serialized writers,
    // same-connection reads see committed data (linearizable); snapshot scans;
    // batch() runs in one transaction. This adapter omits its own deletePrefix
    // and relies on the derived scan-and-delete fallback, so boundedRangeDelete
    // is false.
    return {
      persistence: this.#persistence,
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: false,
    };
  }

  constructor(path: string = ':memory:', Database: BetterSqliteConstructor = BetterSqlite3) {
    this.#persistence = path === ':memory:' ? 'ephemeral' : 'local';

    try {
      this.#database = new Database(path);
    } catch (error) {
      if (isBetterSqlite3LoadFailure(error)) {
        throw createMissingBetterSqlite3Error(error);
      }

      throw error;
    }

    // First, so the connection waits for another process's lock from its first statement,
    // including the journal-mode switch below, which takes a write lock of its own.
    this.#database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    this.#database.pragma('journal_mode = WAL');
    this.#database.pragma('synchronous = NORMAL');
    this.#database.pragma('cache_size = -64000');
    this.#database.pragma('mmap_size = 268435456');
    this.#database.pragma('temp_store = MEMORY');
    this.#database.pragma('wal_autocheckpoint = 10000');

    this.#database.exec(SQLITE_CREATE_KEY_VALUE_TABLE);

    this.#getStatement = this.#database.prepare(SQLITE_SELECT_VALUE_BY_KEY);
    this.#putStatement = this.#database.prepare(SQLITE_UPSERT_VALUE_BY_KEY);
    this.#deleteStatement = this.#database.prepare(SQLITE_DELETE_VALUE_BY_KEY);
    this.#batchTransaction = this.#database.transaction((entries: unknown) => {
      for (const entry of entries as BatchOperation[]) {
        if (entry.type === 'put') {
          this.#putStatement.run(entry.key, entry.value);
        } else {
          this.#deleteStatement.run(entry.key);
        }
      }
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const row = this.#getStatement.get(key);
    if (!row) return null;
    const value = (row as { value: Uint8Array }).value;
    return new Uint8Array(value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#putStatement.run(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#deleteStatement.run(key);
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { parameters, sql } = buildSqliteKeyValueRangeSelect(prefix, options);

    let statement = this.#scanStatements.get(sql);
    if (!statement) {
      statement = this.#database.prepare(sql);
      this.#scanStatements.set(sql, statement);
    }

    const rows = statement.all(...parameters);

    for (const row of rows) {
      const typedRow = row as { key: string; value: Uint8Array };
      yield [typedRow.key, new Uint8Array(typedRow.value)];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    if (operations.length === 0) return;
    // A batch writes first, so a deferred transaction would also wait under the busy timeout;
    // `.immediate` keeps it in step with `conditionalBatch`, which reads before it writes.
    this.#batchTransaction.immediate(operations);
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
    assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

    const conditionalTransaction = this.#database.transaction(
      (pendingConditions: ConditionalBatchCondition[], pendingOperations: BatchOperation[]) =>
        runConditionalBatchBody(pendingConditions, pendingOperations, {
          read: (key) => {
            const row = this.#getStatement.get(key);
            if (!row) return null;
            if (!(row['value'] instanceof Uint8Array)) {
              throw new Error('SQLite value must be a byte array');
            }
            return new Uint8Array(row['value']);
          },
          put: (key, value) => {
            this.#putStatement.run(key, value);
          },
          delete: (key) => {
            this.#deleteStatement.run(key);
          },
        }),
    );

    // Immediate, so the write lock is taken before the read and a lost race returns `false`
    // after waiting, where a deferred transaction would throw `database is locked`.
    return Boolean(conditionalTransaction.immediate(conditions, operations));
  }

  [Symbol.dispose](): void {
    this.#scanStatements.clear();
    this.#database.close();
  }
}
