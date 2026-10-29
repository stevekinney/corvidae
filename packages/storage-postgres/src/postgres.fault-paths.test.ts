/**
 * Failure-path tests for the Postgres-wire adapter over a scripted pool: a transaction that fails
 * with something that is not a database error, and a kv table whose collation cannot be read.
 */

import { describe, expect, it } from 'bun:test';

import { type PostgresPool } from '@lostgradient/storage/sql';
import { bytes as encode } from '@lostgradient/storage/testing';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { PostgresStorage } from './postgres.ts';

/** A pool whose every pooled query answers with `rows` and whose connections run `onClientQuery`. */
function scriptedPool(
  rows: Array<Record<string, unknown>>,
  onClientQuery: (sql: string) => void = () => {},
): PostgresPool & { arm(storage: PostgresStorage): Promise<void> } {
  // `onClientQuery` only sees transactions the test starts: the adapter's one-time
  // setup transaction (schema/table creation) runs first, in `arm`.
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

describe('PostgresStorage conditionalBatch failures', () => {
  it.each([
    ['a thrown string', 'connection reset by peer'],
    ['a thrown null', null],
    ['an error object that carries no code', new Error('socket closed')],
  ])('rethrows %s without retrying it as a transaction abort', async (_label, failure) => {
    let attempts = 0;
    const pool = scriptedPool([{ collation: 'C' }], () => {
      attempts += 1;
      throw failure;
    });
    const storage = new PostgresStorage({ pool });
    await pool.arm(storage);

    const thrown = await throwingRejectionOf(
      storage.conditionalBatch(
        [{ key: 'a', expectedValue: null }],
        [{ type: 'put', key: 'a', value: encode('v') }],
      ),
    );

    expect(thrown).toThrow();
    expect(attempts).toBe(1);
  });

  it('retries a serialization abort instead of surfacing it', async () => {
    let began = 0;
    const abort = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const pool = scriptedPool([{ collation: 'C' }], (sql) => {
      if (sql.startsWith('BEGIN')) {
        began += 1;
        if (began === 1) throw abort;
      }
    });
    const storage = new PostgresStorage({ pool });
    await pool.arm(storage);

    const committed = await storage.conditionalBatch(
      [{ key: 'a', expectedValue: null }],
      [{ type: 'put', key: 'a', value: encode('v') }],
    );

    expect(began).toBeGreaterThan(1);
    expect(typeof committed).toBe('boolean');
  });
});

describe('PostgresStorage key collation check', () => {
  it('describes a collation that is not text as an unexpected value', async () => {
    const storage = new PostgresStorage({ pool: scriptedPool([{ collation: 42 }]) });

    expect(await throwingRejectionOf(storage.get('a'))).toThrow('an unexpected collation value');
  });

  it('reports a missing table when the introspection returns no row', async () => {
    const storage = new PostgresStorage({ pool: scriptedPool([]) });

    expect(await throwingRejectionOf(storage.get('a'))).toThrow('no such table');
  });
});
