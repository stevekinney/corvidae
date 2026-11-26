import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  collect,
  runBasicStorageContract,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from '@lostgradient/storage/testing';
import { startWorker, type RunningWorker } from '@lostgradient/workerd-testing';
import { D1Storage, migrate, type D1Database, type D1PreparedStatement } from './d1.ts';

const entry = new URL('./fixture-worker.ts', import.meta.url).pathname;
const bytes = (value: string) => new TextEncoder().encode(value);

let worker: RunningWorker;
let database: D1Database;

beforeAll(async () => {
  worker = await startWorker({ entry, d1Databases: ['DB'] });
  database = (await worker.getD1Database('DB')) as D1Database;
  await migrate(database);
});

afterAll(async () => {
  await worker.dispose();
});

async function createStorage(): Promise<D1Storage> {
  await migrate(database);
  const storage = new D1Storage(database);
  await storage.deletePrefix('');
  return storage;
}

function parameterLimitedDatabase(bindings: number[]): D1Database {
  const database: D1Database = {
    async batch() {
      return [];
    },
    async exec() {},
    prepare(query) {
      const statement: D1PreparedStatement = {
        async all() {
          return { results: [] };
        },
        async first() {
          return null;
        },
        bind(...values) {
          bindings.push(values.length);
          if (values.length > 100) throw new Error(`D1 parameter limit exceeded: ${values.length}`);
          return statement;
        },
      };
      void query;
      return statement;
    },
  };
  return database;
}

runStorageCapabilityConformance('D1Storage (Miniflare D1)', {
  create: createStorage,
  expected: {
    persistence: 'remote',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
});

runBasicStorageContract('D1Storage (Miniflare D1)', { create: createStorage });
runConcurrentConditionalBatchConformance('D1Storage (Miniflare D1)', { create: createStorage });

describe('D1Storage transactions', () => {
  it('leaves every touched key unchanged when an expectation fails', async () => {
    using storage = await createStorage();
    await storage.put('existing', bytes('before'));
    const applied = await storage.conditionalBatch(
      [{ key: 'existing', expectedValue: bytes('stale') }],
      [
        { type: 'put', key: 'existing', value: bytes('after') },
        { type: 'put', key: 'created', value: bytes('created') },
        { type: 'delete', key: 'removed' },
      ],
    );
    expect(applied).toBe(false);
    expect(await storage.get('existing')).toEqual(bytes('before'));
    expect(await storage.get('created')).toBeNull();
    expect(await storage.get('removed')).toBeNull();
  });

  it('commits a 51-present-value conditional batch within D1 parameter limits', async () => {
    const bindings: number[] = [];
    const inspectedStorage = new D1Storage(parameterLimitedDatabase(bindings));
    const storage = await createStorage();
    const conditions = Array.from({ length: 51 }, (_, index) => ({
      key: `version:${index}`,
      expectedValue: bytes(`before:${index}`),
    }));
    await storage.batch(
      conditions.map((condition) => ({
        type: 'put' as const,
        key: condition.key,
        value: condition.expectedValue,
      })),
    );
    await inspectedStorage.conditionalBatch(conditions, [
      { type: 'put', key: 'committed', value: bytes('yes') },
    ]);

    expect(
      await storage.conditionalBatch(conditions, [
        { type: 'put', key: 'committed', value: bytes('yes') },
      ]),
    ).toBe(true);
    expect(await storage.get('committed')).toEqual(bytes('yes'));
    expect(bindings.every((count) => count <= 100)).toBe(true);
    expect(bindings).toContain(100);
  });

  it('rolls back a later failed expectation chunk without changing any touched key', async () => {
    const bindings: number[] = [];
    const inspectedStorage = new D1Storage(parameterLimitedDatabase(bindings));
    const storage = await createStorage();
    const conditions = Array.from({ length: 51 }, (_, index) => ({
      key: `version:${index}`,
      expectedValue: bytes(`before:${index}`),
    }));
    await storage.batch(
      conditions.map((condition) => ({
        type: 'put' as const,
        key: condition.key,
        value: condition.expectedValue,
      })),
    );
    const failedConditions = conditions.map((condition, index) =>
      index === 50 ? { ...condition, expectedValue: bytes('stale') } : condition,
    );
    await inspectedStorage.conditionalBatch(failedConditions, [
      { type: 'put', key: 'version:0', value: bytes('after') },
      { type: 'put', key: 'created', value: bytes('created') },
    ]);

    expect(
      await storage.conditionalBatch(failedConditions, [
        { type: 'put', key: 'version:0', value: bytes('after') },
        { type: 'put', key: 'created', value: bytes('created') },
      ]),
    ).toBe(false);
    expect(await storage.get('version:0')).toEqual(bytes('before:0'));
    expect(await storage.get('created')).toBeNull();
    expect(
      await Promise.all(conditions.map(async (condition) => storage.get(condition.key))),
    ).toEqual(conditions.map((condition) => condition.expectedValue));
    expect(bindings.every((count) => count <= 100)).toBe(true);
    expect(bindings).toContain(100);
  });

  it('rolls back a D1 batch after a SQL failure and immediately reads primary writes', async () => {
    using storage = await createStorage();
    const failure = await database
      .batch([
        database
          .prepare('INSERT INTO storage_d1_kv (key, value) VALUES (?, ?)')
          .bind('first', bytes('1')),
        database
          .prepare('INSERT INTO storage_d1_kv (key, value) VALUES (?, ?)')
          .bind('second', bytes('2')),
        database.prepare('INSERT INTO absent_table (value) VALUES (1)'),
      ])
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(await storage.get('first')).toBeNull();
    expect(await storage.get('second')).toBeNull();
    await storage.put('primary', bytes('visible'));
    expect(await storage.get('primary')).toEqual(bytes('visible'));
  });

  it('migrates repeatedly without creating duplicate tables or removing rows', async () => {
    const storage = await createStorage();
    await storage.put('preserved', bytes('value'));
    await migrate(database);
    expect(await storage.get('preserved')).toEqual(bytes('value'));
    const tables = await database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'storage_d1_%' ORDER BY name",
      )
      .all<{ name: string }>();
    expect(tables.results.map((table) => table.name)).toEqual([
      'storage_d1_expectation_guard',
      'storage_d1_kv',
    ]);
    expect(await collect(storage.keys(''))).toEqual(['preserved']);
  });
});
