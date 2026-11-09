import {
  openPostgresTestDatabase,
  requireOpenedPostgresTestDatabase,
} from '@lostgradient/testing/postgres-server';
import { afterAll, describe, expect, it } from 'bun:test';
import { PostgresStorage } from './postgres.ts';

/** Writers that start together. Each needs its own committed round on a shared row. */
const WRITERS = 8;
const ROUNDS = 5;

// Opened at load, before any hook is timed — see `openPostgresTestDatabase`.
const database = await openPostgresTestDatabase();

/**
 * Writers whose conditions all hold and that all write one key serialize one commit per round:
 * Postgres aborts every waiter with `40001` when the winner commits. With immediate retries and
 * a small attempt cap the last writers in the queue ran out of attempts and threw
 * `conditionalBatch exhausted … attempts` (COR-1907). Backing off lets the queue drain, so every
 * writer commits. The only deadline here is the hang guard.
 */
describe.skipIf(database === null)('PostgresStorage conditionalBatch contention (live pg)', () => {
  const live = () => requireOpenedPostgresTestDatabase(database);
  afterAll(() => live()[Symbol.asyncDispose]());

  it('commits or fails the condition for every writer on one key, and none exhausts', async () => {
    const storages = Array.from(
      { length: WRITERS },
      () => new PostgresStorage({ url: live().url, table: 'weft_contended_kv' }),
    );
    try {
      const [first] = storages;
      await first?.put('guard', new Uint8Array([1]));
      for (let round = 0; round < ROUNDS; round += 1) {
        const results = await Promise.allSettled(
          storages.map((storage, index) =>
            storage.conditionalBatch(
              [{ key: 'guard', expectedValue: new Uint8Array([1]) }],
              [{ type: 'put', key: 'shared', value: new Uint8Array([index]) }],
            ),
          ),
        );
        expect(
          results.flatMap((result) =>
            result.status === 'rejected' ? [(result.reason as Error).message] : [],
          ),
        ).toEqual([]);
        expect(results.map((result) => (result as PromiseFulfilledResult<boolean>).value)).toEqual(
          Array.from({ length: WRITERS }, () => true),
        );
      }
    } finally {
      await Promise.all(storages.map((storage) => storage[Symbol.asyncDispose]()));
    }
  });

  it('fails the condition of the losers when writers race to create one key', async () => {
    const storages = Array.from(
      { length: WRITERS },
      () => new PostgresStorage({ url: live().url, table: 'weft_contended_kv' }),
    );
    try {
      const [first] = storages;
      await first?.delete('claimed');
      const results = await Promise.allSettled(
        storages.map((storage, index) =>
          storage.conditionalBatch(
            [{ key: 'claimed', expectedValue: null }],
            [{ type: 'put', key: 'claimed', value: new Uint8Array([index]) }],
          ),
        ),
      );
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
      const outcomes = results.map((result) => (result as PromiseFulfilledResult<boolean>).value);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
    } finally {
      await Promise.all(storages.map((storage) => storage[Symbol.asyncDispose]()));
    }
  });
});
