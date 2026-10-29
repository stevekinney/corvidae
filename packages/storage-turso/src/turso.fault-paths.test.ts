/**
 * Failure-path tests for `TursoStorage` against a real libSQL driver: a client that cannot be
 * built, a write batch that keeps hitting a locked database, and a transaction that fails for a
 * reason other than contention while its rollback fails too.
 */

import { describe, expect, it, spyOn } from 'bun:test';

import { SQLITE_UPSERT_VALUE_BY_KEY } from '@lostgradient/storage/sql';
import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
} from '@lostgradient/storage/testing';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { TursoStorage } from './turso.ts';

// The adapter imports this same module specifier, so the probe below shares the transaction class
// the adapter's own client uses.
const { createClient } = await import('@libsql/client');

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe('TursoStorage client construction', () => {
  it('surfaces a driver construction failure on every attempt instead of memoizing it', async () => {
    const storage = new TursoStorage({ url: 'gopher://nowhere' });

    expect(await throwingRejectionOf(storage.get('a'))).toThrow('URL_SCHEME_NOT_SUPPORTED');
    expect(await throwingRejectionOf(storage.get('a'))).toThrow('URL_SCHEME_NOT_SUPPORTED');
    storage[Symbol.dispose]();
  });
});

describe('TursoStorage write contention', () => {
  it('retries a locked write batch and then surfaces the contention error', async () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'turso-batch-busy',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const url = `file:${fixture.path}`;
    const storage = new TursoStorage({ url });
    const locker = createClient({ url });

    try {
      await storage.put('seed', encode('seed'));
      const transaction = await locker.transaction('write');
      try {
        await transaction.execute({
          sql: SQLITE_UPSERT_VALUE_BY_KEY,
          args: ['lock:holder', encode('held')],
        });

        expect(
          await throwingRejectionOf(
            storage.batch([{ type: 'put', key: 'busy:key', value: encode('never') }]),
          ),
        ).toThrow(/SQLITE_BUSY|busy|locked/i);
      } finally {
        await transaction.rollback().catch(() => {});
      }
      expect(await storage.get('busy:key')).toBeNull();
    } finally {
      locker.close();
      storage[Symbol.dispose]();
      fixture.cleanup();
    }
  });
});

describe('TursoStorage conditionalBatch non-contention failure', () => {
  it('rethrows the original failure even when the best-effort rollback fails too', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    const probe = createClient({ url: 'file::memory:' });
    const probeTransaction = await probe.transaction('write');
    const transactionPrototype = Object.getPrototypeOf(probeTransaction) as {
      executeMultiple: (sql: string) => Promise<void>;
      rollback: () => Promise<void>;
    };
    await probeTransaction.rollback();
    probe.close();

    const failure = new Error('disk I/O error');
    const executeSpy = spyOn(transactionPrototype, 'executeMultiple').mockRejectedValue(failure);
    const rollbackSpy = spyOn(transactionPrototype, 'rollback').mockRejectedValue(
      new Error('rollback failed'),
    );

    try {
      expect(
        await throwingRejectionOf(
          storage.conditionalBatch(
            [{ key: 'a', expectedValue: null }],
            [{ type: 'put', key: 'a', value: encode('1') }],
          ),
        ),
      ).toThrow('disk I/O error');
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(rollbackSpy).toHaveBeenCalledTimes(1);
    } finally {
      executeSpy.mockRestore();
      rollbackSpy.mockRestore();
      storage[Symbol.dispose]();
    }
  });
});

describe('TursoStorage disposal', () => {
  it('swallows a failure to close the client, which it closes best-effort', async () => {
    const storage = new TursoStorage({ url: 'file::memory:' });
    const probe = createClient({ url: 'file::memory:' });
    const clientPrototype = Object.getPrototypeOf(probe) as { close: () => void };
    probe.close();

    await storage.put('present', encode('1'));
    const closeSpy = spyOn(clientPrototype, 'close').mockImplementation(() => {
      throw new Error('close failed');
    });

    try {
      storage[Symbol.dispose]();
      await waitUntil(() => closeSpy.mock.calls.length === 1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });
});
