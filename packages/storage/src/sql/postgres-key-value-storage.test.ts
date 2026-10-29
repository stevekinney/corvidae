import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';

import { pgliteAsPostgresPool } from '../testing/pglite.test-support.ts';
import {
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runStorageCapabilityConformance,
} from '../testing/storage-contract.ts';
import { PostgresKeyValueStorage, type PostgresPool } from './postgres-key-value-storage.ts';

let database: PGlite | undefined;

beforeAll(async () => {
  database = await new PGlite();
  await database.query('SELECT 1');
});

afterAll(async () => {
  await database?.close();
  database = undefined;
});

function activeDatabase(): PGlite {
  if (database === undefined) throw new Error('PGlite is not running');
  return database;
}

const pool = pgliteAsPostgresPool(activeDatabase);

function refusePoolFactory(): PostgresPool {
  throw new Error('an injected pool needs no factory');
}

/** A storage over the shared PGlite, with the default table emptied so each case starts clean. */
async function createStorage(): Promise<PostgresKeyValueStorage> {
  await activeDatabase().query(
    'CREATE TABLE IF NOT EXISTS kv (key TEXT COLLATE "C" PRIMARY KEY, value BYTEA NOT NULL)',
  );
  await activeDatabase().query('DELETE FROM kv');
  return new PostgresKeyValueStorage({ pool }, refusePoolFactory);
}

runStorageCapabilityConformance('PostgresKeyValueStorage', {
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

runBasicStorageContract('PostgresKeyValueStorage', { create: createStorage });

runBinaryAndLargeScanStorageConformance('PostgresKeyValueStorage', { create: createStorage });

describe('PostgresKeyValueStorage', () => {
  it('requires either a url or a pool', () => {
    expect(() => new PostgresKeyValueStorage({}, refusePoolFactory)).toThrow(
      /either a `url`.*or a pre-built `pool`/,
    );
  });

  it('creates its schema and table on first use when a schema is configured', async () => {
    await using storage = new PostgresKeyValueStorage(
      { pool, schema: 'storage_package', table: 'entries' },
      refusePoolFactory,
    );
    await storage.put('a', new Uint8Array([1]));
    expect(await storage.get('a')).toEqual(new Uint8Array([1]));
    const rows = await activeDatabase().query<{ count: number }>(
      'SELECT count(*)::int AS count FROM storage_package.entries',
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it('runs read-only queries and refuses writes', async () => {
    await using storage = await createStorage();
    await storage.put('q', new Uint8Array([7]));
    expect(await storage.query<{ key: string }>('SELECT key FROM kv')).toEqual([{ key: 'q' }]);
    expect(() => storage.query('DELETE FROM kv')).toThrow();
  });

  it('builds and closes an owned pool from a url, once', async () => {
    let ended = 0;
    const owned: PostgresPool = {
      query: (sql, parameters) => pool.query(sql, parameters),
      connect: () => pool.connect(),
      end: async () => {
        ended++;
      },
    };
    const urls: string[] = [];
    const storage = new PostgresKeyValueStorage({ url: 'postgresql://example/db' }, (url) => {
      urls.push(url);
      return owned;
    });
    storage[Symbol.dispose]();
    await storage[Symbol.asyncDispose]();
    expect(urls).toEqual(['postgresql://example/db']);
    expect(ended).toBe(1);
  });

  it('swallows an owned pool shutdown failure on synchronous dispose', async () => {
    const shutdown = new Error('pool already ended');
    const owned: PostgresPool = { ...pool, end: () => Promise.reject(shutdown) };
    const storage = new PostgresKeyValueStorage({ url: 'postgresql://example/db' }, () => owned);

    storage[Symbol.dispose]();

    expect(await rejectionOf(storage[Symbol.asyncDispose]())).toBe(shutdown);
  });

  it('leaves an injected pool open when disposed', async () => {
    let ended = 0;
    const injected: PostgresPool = { ...pool, end: async () => void ended++ };
    const storage = new PostgresKeyValueStorage({ pool: injected }, refusePoolFactory);
    await storage[Symbol.asyncDispose]();
    expect(ended).toBe(0);
  });
});

describe('PostgresKeyValueStorage optional operations over PGlite', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('answers has, keys, and count from the table', async () => {
    await using storage = await createStorage();
    await storage.put('p:a', bytes('1'));
    await storage.put('p:b', bytes('2'));
    await storage.put('q:a', bytes('3'));

    expect(await storage.has('p:a')).toBe(true);
    expect(await storage.has('p:z')).toBe(false);
    const keys: string[] = [];
    for await (const key of storage.keys('p:')) keys.push(key);
    expect(keys).toEqual(['p:a', 'p:b']);
    expect(await storage.count('p:')).toBe(2);
    expect(await storage.count('none:')).toBe(0);
  });

  it('deletes a prefix and a bounded range, reporting the rows removed', async () => {
    await using storage = await createStorage();
    for (const key of ['ev:1', 'ev:2', 'ev:3', 'ev:4', 'other']) await storage.put(key, bytes(key));

    expect(await storage.deleteRange('ev:', { lt: 'ev:3' })).toBe(2);
    expect(await storage.deletePrefix('ev:')).toBe(2);
    expect(await storage.get('other')).toEqual(bytes('other'));
  });

  it('scopes keys under a prefix', async () => {
    await using storage = await createStorage();
    const scoped = storage.scoped('tenant');
    await scoped.put('k', bytes('v'));
    expect(await storage.get('tenant:k')).toEqual(bytes('v'));
  });

  it('applies a conditional batch whose conditions hold', async () => {
    await using storage = await createStorage();
    await storage.put('cas', bytes('current'));

    expect(
      await storage.conditionalBatch(
        [
          { key: 'cas', expectedValue: bytes('current') },
          { key: 'absent', expectedValue: null },
        ],
        [
          { type: 'put', key: 'cas', value: bytes('next') },
          { type: 'delete', key: 'gone' },
        ],
      ),
    ).toBe(true);
    expect(await storage.get('cas')).toEqual(bytes('next'));
  });

  it('refuses a conditional batch whose expected value differs from the stored one', async () => {
    await using storage = await createStorage();
    await storage.put('cas', bytes('current'));

    expect(
      await storage.conditionalBatch(
        [{ key: 'cas', expectedValue: bytes('stale') }],
        [{ type: 'put', key: 'cas', value: bytes('next') }],
      ),
    ).toBe(false);
    expect(await storage.get('cas')).toEqual(bytes('current'));
  });
});

/** A pool whose pooled queries answer with `rows` and whose connections run `onClientQuery`. */
function scriptedPool(
  rows: Array<Record<string, unknown>>,
  onClientQuery: (sql: string) => void = () => {},
): PostgresPool & { arm(storage: PostgresKeyValueStorage): Promise<void> } {
  // `onClientQuery` sees only the transactions a test starts: the one-time setup runs in `arm`.
  let armed = false;
  return {
    query: async () => ({ rows }),
    connect: async () => ({
      query: async (sql: string) => {
        if (armed) onClientQuery(sql);
        return { rows: [] };
      },
      release: () => {},
    }),
    end: async () => {},
    async arm(storage) {
      await storage.has('__setup__');
      armed = true;
    },
  };
}

const conditionalPut = [
  [{ key: 'a', expectedValue: null }],
  [{ type: 'put' as const, key: 'a', value: new Uint8Array([1]) }],
] as const;

describe('PostgresKeyValueStorage transaction failures', () => {
  it.each([
    ['a thrown string', 'connection reset by peer'],
    ['a thrown null', null],
    ['an error object that carries no code', new Error('socket closed')],
  ])('rethrows %s without retrying it as a transaction abort', async (_label, failure) => {
    let attempts = 0;
    const scripted = scriptedPool([{ collation: 'C' }], (sql) => {
      if (sql.startsWith('BEGIN')) {
        attempts += 1;
        throw failure;
      }
    });
    const storage = new PostgresKeyValueStorage({ pool: scripted }, refusePoolFactory);
    await scripted.arm(storage);

    expect(
      await throwingRejectionOf(
        storage.conditionalBatch([...conditionalPut[0]], [...conditionalPut[1]]),
      ),
    ).toThrow();
    expect(attempts).toBe(1);
  });

  it('retries serialization aborts and gives up after its attempt cap', async () => {
    let began = 0;
    const abort = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const scripted = scriptedPool([{ collation: 'C' }], (sql) => {
      if (sql.startsWith('BEGIN')) {
        began += 1;
        throw abort;
      }
    });
    const storage = new PostgresKeyValueStorage({ pool: scripted }, refusePoolFactory);
    await scripted.arm(storage);

    expect(
      await throwingRejectionOf(
        storage.conditionalBatch([...conditionalPut[0]], [...conditionalPut[1]]),
      ),
    ).toThrow('conditionalBatch exhausted 5 attempts after retryable transaction failures');
    expect(began).toBe(5);
  });

  it('keeps the original failure when the rollback after it also fails', async () => {
    const scripted = scriptedPool([{ collation: 'C' }], (sql) => {
      if (sql.startsWith('INSERT')) throw new Error('write failed');
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
    });
    const storage = new PostgresKeyValueStorage({ pool: scripted }, refusePoolFactory);
    await scripted.arm(storage);

    expect(
      await throwingRejectionOf(
        storage.batch([{ type: 'put', key: 'a', value: new Uint8Array([1]) }]),
      ),
    ).toThrow('write failed');
  });
});

describe('PostgresKeyValueStorage key collation check', () => {
  it('describes a collation that is not text as an unexpected value', async () => {
    const storage = new PostgresKeyValueStorage(
      { pool: scriptedPool([{ collation: 42 }]) },
      refusePoolFactory,
    );
    expect(await throwingRejectionOf(storage.get('a'))).toThrow('an unexpected collation value');
  });

  it('reports a missing table, then retries setup on the next call', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const storage = new PostgresKeyValueStorage({ pool: scriptedPool(rows) }, refusePoolFactory);
    expect(await throwingRejectionOf(storage.get('a'))).toThrow('no such table');

    rows.push({ collation: 'C' });
    expect(await storage.count('a')).toBe(0);
  });

  it('names a collation other than C', async () => {
    const storage = new PostgresKeyValueStorage(
      { pool: scriptedPool([{ collation: 'en_US.utf8' }]) },
      refusePoolFactory,
    );
    expect(await throwingRejectionOf(storage.get('a'))).toThrow('(found "en_US.utf8")');
  });
});

describe('pgliteAsPostgresPool', () => {
  it('answers through a released client and leaves the database open on end()', async () => {
    const direct = pgliteAsPostgresPool(activeDatabase());
    expect((await direct.query('SELECT 3 AS three')).rows).toEqual([{ three: 3 }]);
    const client = await pool.connect();
    const result = await client.query('SELECT 1 AS one');
    client.release();
    await pool.end();

    expect(result.rows).toEqual([{ one: 1 }]);
    expect((await pool.query('SELECT 2 AS two')).rows).toEqual([{ two: 2 }]);
  });
});
