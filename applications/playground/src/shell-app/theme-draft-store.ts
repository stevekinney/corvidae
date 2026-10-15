/**
 * The storage module's small internal adapter over IndexedDB. Everything above this file
 * speaks `ThemeStore`; only `openIndexedDbThemeStore` knows IndexedDB. A readwrite
 * `transact` is one IndexedDB transaction, so a read-compare-write inside it is atomic
 * across tabs. Callbacks must await only the `StoreTransaction` methods: awaiting anything
 * else lets IndexedDB commit the transaction early.
 */

export type StoreName = 'themes' | 'meta';

export type StoreTransaction = {
  get(store: StoreName, key: string): Promise<unknown>;
  getAll(store: StoreName): Promise<unknown[]>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
};

export type ThemeStore = {
  transact<T>(
    mode: 'readonly' | 'readwrite',
    run: (tx: StoreTransaction) => Promise<T>,
  ): Promise<T>;
};

export const THEME_DATABASE_NAME = 'cinder-playground-theme-builder';
export const THEME_DATABASE_VERSION = 1;

export type StorageErrorKind = 'storage-denied' | 'quota-exceeded' | 'storage-error';

/** Map a thrown storage error to the state the user is shown. */
export function classifyStorageError(error: unknown): StorageErrorKind {
  const name = error instanceof Error ? error.name : '';
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  if (name === 'QuotaExceededError' || code === 22) return 'quota-exceeded';
  if (
    name === 'SecurityError' ||
    name === 'NotAllowedError' ||
    name === 'InvalidStateError' ||
    name === 'StorageDeniedError'
  ) {
    return 'storage-denied';
  }
  return 'storage-error';
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB failed')));
  });
}

/** Open the database. Rejects when storage is unavailable; the caller classifies the error. */
export async function openIndexedDbThemeStore(
  factory: IDBFactory | undefined,
): Promise<ThemeStore> {
  if (factory === undefined) {
    throw Object.assign(new Error('IndexedDB is unavailable'), { name: 'StorageDeniedError' });
  }
  const request = factory.open(THEME_DATABASE_NAME, THEME_DATABASE_VERSION);
  request.addEventListener('upgradeneeded', () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('themes')) db.createObjectStore('themes');
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
  });
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB failed')));
    request.addEventListener('blocked', () =>
      reject(Object.assign(new Error('IndexedDB is blocked'), { name: 'StorageDeniedError' })),
    );
  });
  return {
    async transact(mode, run) {
      const transaction = db.transaction(['themes', 'meta'], mode);
      const finished = new Promise<void>((resolve, reject) => {
        transaction.addEventListener('complete', () => resolve());
        transaction.addEventListener('abort', () =>
          reject(transaction.error ?? new Error('IndexedDB transaction aborted')),
        );
        transaction.addEventListener('error', () =>
          reject(transaction.error ?? new Error('IndexedDB transaction failed')),
        );
      });
      const tx: StoreTransaction = {
        get: (store, key) => requestResult(transaction.objectStore(store).get(key)),
        getAll: (store) => requestResult(transaction.objectStore(store).getAll()),
        put: async (store, key, value) => {
          await requestResult(transaction.objectStore(store).put(value, key));
        },
        delete: async (store, key) => {
          await requestResult(transaction.objectStore(store).delete(key));
        },
      };
      try {
        const result = await run(tx);
        await finished;
        return result;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          /* already finished */
        }
        finished.catch(() => undefined);
        throw error;
      }
    },
  };
}
