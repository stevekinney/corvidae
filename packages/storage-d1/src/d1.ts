import {
  assertStorageBatchOperationCount,
  normalizeDeleteRangeOptions,
  type BatchOperation,
  type ConditionalBatchCondition,
  type DeleteRangeOptions,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from '@lostgradient/storage';
import {
  buildSqliteCountKeysByPrefix,
  buildSqliteDeleteKeysByPrefix,
  buildSqliteKeyRangeDelete,
  buildSqliteKeyRangeQuery,
} from '@lostgradient/storage/sql';

const KEY_VALUE_TABLE = 'storage_d1_kv';
const EXPECTATION_GUARD_TABLE = 'storage_d1_expectation_guard';
const EXPECTATION_FAILURE = 'CHECK constraint failed: value = 0';
// D1 accepts at most 100 bound parameters in one statement. A present-value
// expectation needs a key and a value binding; an absence expectation needs
// only its key. Keeping every guard under this cap leaves all guards and the
// mutations in the same D1 batch transaction.
const MAX_GUARD_PARAMETERS = 100;

type D1Result<Row> = { results: Row[] };
type ValueRow = { value: ArrayBuffer };
type KeyValueRow = { key: string; value: ArrayBuffer };
type KeyRow = { key: string };
type CountRow = { count: number };
type ChangesRow = { changes: number };

/** The D1 binding surface this adapter needs; no Cloudflare runtime types are imported. */
export type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<Row>(): Promise<Row | null>;
  all<Row>(): Promise<D1Result<Row>>;
};

/** A Cloudflare D1 database binding, structurally typed for Bun and workerd. */
export type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch<Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]>;
  exec(query: string): Promise<unknown>;
};

/**
 * Create the durable tables D1Storage owns. It is safe to run on every Worker start.
 *
 * `storage_d1_kv` is the persisted key/value format. `storage_d1_expectation_guard` has a
 * constraint which lets a failed compare-and-set abort the surrounding D1 transaction before
 * any write runs; it intentionally remains empty.
 */
export async function migrate(database: D1Database): Promise<void> {
  await database.exec(
    `CREATE TABLE IF NOT EXISTS ${KEY_VALUE_TABLE} (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID`,
  );
  await database.exec(
    `CREATE TABLE IF NOT EXISTS ${EXPECTATION_GUARD_TABLE} (value INTEGER NOT NULL CHECK (value = 0))`,
  );
}

/** A non-owning Storage view over a D1 primary binding. */
export class D1Storage implements Storage {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  capabilities(): StorageCapabilities {
    return {
      persistence: 'remote',
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const row = await this.#database
      .prepare(`SELECT value FROM ${KEY_VALUE_TABLE} WHERE key = ?`)
      .bind(key)
      .first<ValueRow>();
    return row === null ? null : new Uint8Array(row.value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.#database.batch([
      this.#database
        .prepare(
          `INSERT INTO ${KEY_VALUE_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .bind(key, value.slice()),
    ]);
  }

  async delete(key: string): Promise<void> {
    await this.#database.batch([
      this.#database.prepare(`DELETE FROM ${KEY_VALUE_TABLE} WHERE key = ?`).bind(key),
    ]);
  }

  async has(key: string): Promise<boolean> {
    return (
      (await this.#database
        .prepare(`SELECT key FROM ${KEY_VALUE_TABLE} WHERE key = ?`)
        .bind(key)
        .first<KeyRow>()) !== null
    );
  }

  async count(prefix: string): Promise<number> {
    const { parameters, sql } = buildSqliteCountKeysByPrefix(prefix, KEY_VALUE_TABLE);
    const row = await this.#database
      .prepare(sql)
      .bind(...parameters)
      .first<CountRow>();
    return row?.count ?? 0;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const { parameters, sql } = buildSqliteDeleteKeysByPrefix(prefix, KEY_VALUE_TABLE);
    return this.#deleteAndCount(sql, parameters);
  }

  async deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    const { parameters, sql } = buildSqliteKeyRangeDelete(
      prefix,
      normalizeDeleteRangeOptions(options),
      KEY_VALUE_TABLE,
    );
    return this.#deleteAndCount(sql, parameters);
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { parameters, sqlSuffix } = buildSqliteKeyRangeQuery(prefix, options);
    const result = await this.#database
      .prepare(`SELECT key, value FROM ${KEY_VALUE_TABLE} ${sqlSuffix}`)
      .bind(...parameters)
      .all<KeyValueRow>();
    for (const row of result.results) yield [row.key, new Uint8Array(row.value)];
  }

  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    const { parameters, sqlSuffix } = buildSqliteKeyRangeQuery(prefix, options);
    const result = await this.#database
      .prepare(`SELECT key FROM ${KEY_VALUE_TABLE} ${sqlSuffix}`)
      .bind(...parameters)
      .all<KeyRow>();
    for (const row of result.results) yield row.key;
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    if (operations.length === 0) return;
    await this.#database.batch(operations.map((operation) => this.#operationStatement(operation)));
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    assertStorageBatchOperationCount('conditionalBatch conditions', conditions.length);
    assertStorageBatchOperationCount('conditionalBatch operations', operations.length);

    const expectations = this.#expectationStatements(conditions);
    try {
      await this.#database.batch([
        ...expectations,
        ...operations.map((operation) => this.#operationStatement(operation)),
      ]);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes(EXPECTATION_FAILURE)) return false;
      throw error;
    }
  }

  #operationStatement(operation: BatchOperation): D1PreparedStatement {
    if (operation.type === 'put') {
      return this.#database
        .prepare(
          `INSERT INTO ${KEY_VALUE_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .bind(operation.key, operation.value.slice());
    }
    return this.#database
      .prepare(`DELETE FROM ${KEY_VALUE_TABLE} WHERE key = ?`)
      .bind(operation.key);
  }

  #expectationStatements(conditions: ConditionalBatchCondition[]): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [];
    let clauses: string[] = [];
    let parameters: unknown[] = [];

    const append = () => {
      const matches = clauses.length === 0 ? '1' : clauses.join(' AND ');
      statements.push(
        this.#database
          .prepare(`INSERT INTO ${EXPECTATION_GUARD_TABLE} (value) SELECT 1 WHERE NOT (${matches})`)
          .bind(...parameters),
      );
      clauses = [];
      parameters = [];
    };

    for (const condition of conditions) {
      const parameterCount = condition.expectedValue === null ? 1 : 2;
      if (parameters.length > 0 && parameters.length + parameterCount > MAX_GUARD_PARAMETERS)
        append();
      if (condition.expectedValue === null) {
        clauses.push(`NOT EXISTS (SELECT 1 FROM ${KEY_VALUE_TABLE} WHERE key = ?)`);
        parameters.push(condition.key);
      } else {
        clauses.push(`EXISTS (SELECT 1 FROM ${KEY_VALUE_TABLE} WHERE key = ? AND value = ?)`);
        parameters.push(condition.key, condition.expectedValue.slice());
      }
    }
    append();
    return statements;
  }

  async #deleteAndCount(sql: string, parameters: (string | number)[]): Promise<number> {
    const [, result] = await this.#database.batch([
      this.#database.prepare(sql).bind(...parameters),
      this.#database.prepare('SELECT changes() AS changes'),
    ]);
    const rows = result?.results as ChangesRow[] | undefined;
    return rows?.[0]?.changes ?? 0;
  }

  [Symbol.dispose](): void {}
}
