/**
 * Fault-path tests for `IndexedDBStorage` that need the cursor or transaction to fail at a precise
 * moment relative to the consumer: between two cursor steps, after a request already settled, or
 * while an abort itself throws. They drive the adapter through the fake IndexedDB harness the main
 * suite uses.
 */

import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  createFakeRequest,
  createFakeTransaction,
  withFakeIndexedDb,
  type FakeRequest,
} from './indexeddb-fault-harness.test-support.ts';
import { IndexedDBStorage } from './indexeddb.ts';
import { collect } from './storage-adapter.test-support.ts';

function encode(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(value));
}

/** A fake value cursor positioned on one row whose `continue()` runs the supplied step. */
function cursorOn(key: string, onContinue: () => void): IDBCursorWithValue {
  return {
    key,
    value: encode(key),
    continue: onContinue,
  } as unknown as IDBCursorWithValue;
}

describe('IndexedDBStorage cursor timing', () => {
  it('reports a transaction error that lands between two cursor steps on the next step', async () => {
    const transactionError = new Error('transaction failed between steps');
    const transaction = createFakeTransaction({
      transactionError,
      store: (tx) => ({
        openCursor() {
          const cursor = cursorOn('k:a', () => tx.fireError());
          const request = createFakeRequest<IDBCursorWithValue | null>({ result: cursor });
          queueMicrotask(() => request.fireSuccess());
          return request;
        },
      }),
    });

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      expect(await rejectionOf(collect(storage.scan('k:')))).toBe(transactionError);
    });
  });

  it('reads a cursor step that already settled before the consumer asked for it', async () => {
    let request!: FakeRequest<IDBCursorWithValue | null>;
    const transaction = createFakeTransaction({
      store: () => ({
        openCursor() {
          // The step after the first row completes inside `continue()`, so nobody is waiting yet
          // and the request is already `done` when the consumer asks for it.
          const cursor = cursorOn('k:a', () => {
            Object.assign(request, { readyState: 'done', result: null });
            request.fireSuccess();
          });
          request = createFakeRequest<IDBCursorWithValue | null>({ result: cursor });
          queueMicrotask(() => request.fireSuccess());
          return request;
        },
      }),
    });

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      const entries = await collect(storage.scan('k:'));
      expect(entries.map(([key]) => key)).toEqual(['k:a']);
    });
  });

  it('keeps the original failure when aborting the transaction after it throws', async () => {
    const cursorError = new Error('cursor request failed');
    const transaction = createFakeTransaction({
      store: () => ({
        openCursor() {
          const request = createFakeRequest<IDBCursorWithValue | null>({
            result: null,
            error: cursorError,
          });
          queueMicrotask(() => request.fireError());
          return request;
        },
      }),
    });
    transaction.abort = () => {
      throw new Error('transaction already finished');
    };

    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      expect(await rejectionOf(collect(storage.scan('k:')))).toBe(cursorError);
    });
  });
});

describe('IndexedDBStorage conditionalBatch settlement', () => {
  async function runBatch(
    fire: (tx: ReturnType<typeof createFakeTransaction>) => void,
    transactionError?: Error,
  ): Promise<unknown> {
    const transaction = createFakeTransaction({
      ...(transactionError === undefined ? {} : { transactionError }),
      store: (tx) => ({
        put() {
          queueMicrotask(() => fire(tx));
          return createFakeRequest<IDBValidKey>({ result: 'next' });
        },
        delete() {
          return createFakeRequest<undefined>({});
        },
      }),
    });
    let outcome: unknown;
    await withFakeIndexedDb({ transaction }, async () => {
      const storage = new IndexedDBStorage(`test-${crypto.randomUUID()}`);
      outcome = await rejectionOf(
        storage.conditionalBatch([], [{ type: 'put', key: 'next', value: encode('next') }]),
      );
    });
    return outcome;
  }

  it('ignores a completion that arrives after the transaction already failed', async () => {
    const transactionError = new Error('transaction failed');

    const outcome = await runBatch((tx) => {
      tx.fireError();
      tx.fireComplete();
    }, transactionError);

    expect(outcome).toBe(transactionError);
  });

  it('ignores an abort that arrives after the transaction already failed', async () => {
    const transactionError = new Error('transaction failed');

    const outcome = await runBatch((tx) => {
      tx.fireError();
      tx.fireAbort();
    }, transactionError);

    expect(outcome).toBe(transactionError);
  });

  it('rejects with a descriptive error when the transaction aborts without carrying one', async () => {
    const outcome = await runBatch((tx) => tx.fireAbort());

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('IndexedDB conditionalBatch transaction aborted.');
  });
});

describe('IndexedDBStorage runtime globals', () => {
  it.each(['indexedDB', 'IDBKeyRange'] as const)(
    'refuses to open without the %s global',
    (missingGlobal) => {
      const original = Object.getOwnPropertyDescriptor(globalThis, missingGlobal);
      Object.defineProperty(globalThis, missingGlobal, {
        value: undefined,
        configurable: true,
        writable: true,
      });
      try {
        expect(() => new IndexedDBStorage(`test-${crypto.randomUUID()}`)).toThrow(
          'IndexedDBStorage requires both indexedDB and IDBKeyRange runtime globals.',
        );
      } finally {
        if (original === undefined) {
          Reflect.deleteProperty(globalThis, missingGlobal);
        } else {
          Object.defineProperty(globalThis, missingGlobal, original);
        }
      }
    },
  );
});
