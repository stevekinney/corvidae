/**
 * Failure-path tests for `NodeSQLiteStorage` that a real better-sqlite3 database cannot produce:
 * a constructor that fails for a reason other than a missing binding, and a row whose stored value
 * is not a byte array. Both use an injected database constructor.
 */

import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { NodeSQLiteStorage } from './node-sqlite.ts';

type InjectedDatabaseConstructor = NonNullable<ConstructorParameters<typeof NodeSQLiteStorage>[1]>;

/** A database whose every prepared statement returns `row` from `get()`. */
function databaseReturningRow(row: unknown): InjectedDatabaseConstructor {
  return class FakeDatabase {
    pragma(): void {}
    exec(): void {}
    prepare() {
      return { get: () => row, run: () => undefined, all: () => [] };
    }
    transaction<TArguments extends unknown[], TResult>(fn: (...entries: TArguments) => TResult) {
      const run = (...entries: TArguments): TResult => fn(...entries);
      return Object.assign(run, { immediate: run });
    }
    close(): void {}
  } as unknown as InjectedDatabaseConstructor;
}

describe('NodeSQLiteStorage failure paths', () => {
  it('rethrows an injected constructor failure that is not a missing-binding error unchanged', () => {
    const failure = new Error('database file is locked');
    const FailingDatabase = function FailingDatabase() {
      throw failure;
    } as unknown as InjectedDatabaseConstructor;

    expect(() => new NodeSQLiteStorage(':memory:', FailingDatabase)).toThrow(failure);
  });

  it('rejects a conditional batch whose condition reads a stored value that is not a byte array', async () => {
    const storage = new NodeSQLiteStorage(
      ':memory:',
      databaseReturningRow({ value: 'not a byte array' }),
    );

    expect(
      await throwingRejectionOf(
        storage.conditionalBatch(
          [{ key: 'a', expectedValue: null }],
          [{ type: 'put', key: 'a', value: new Uint8Array([1]) }],
        ),
      ),
    ).toThrow('SQLite value must be a byte array');
    storage[Symbol.dispose]();
  });

  it('treats a missing row as an absent value when checking conditions', async () => {
    const storage = new NodeSQLiteStorage(':memory:', databaseReturningRow(undefined));

    expect(
      await storage.conditionalBatch(
        [{ key: 'a', expectedValue: null }],
        [{ type: 'put', key: 'a', value: new Uint8Array([1]) }],
      ),
    ).toBe(true);
    storage[Symbol.dispose]();
  });
});
