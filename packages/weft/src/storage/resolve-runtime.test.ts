import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { IndexedDBStorage } from './indexeddb.ts';
import { MemoryStorage } from './memory.ts';
import {
  detectStorageRuntime,
  resolveAutoStorage,
  resolveSQLiteStorage,
  type StorageRuntime,
} from './resolve-runtime.ts';
import { WebExtensionStorage } from './web-extension.ts';

const neitherBunNorNode: StorageRuntime = {
  bun: false,
  node: false,
  webExtension: false,
  indexedDB: false,
};

type WebExtensionTestGlobal = typeof globalThis & { browser?: unknown; chrome?: unknown };

describe('detectStorageRuntime', () => {
  it('reports the Bun host this suite runs on, with Node globals present', () => {
    const runtime = detectStorageRuntime();

    expect(runtime.bun).toBe(true);
    expect(runtime.node).toBe(true);
    expect(runtime.indexedDB).toBe(typeof globalThis.indexedDB !== 'undefined');
  });

  it.each(['browser', 'chrome'] as const)(
    'detects extension storage provided as globalThis.%s.storage',
    (name) => {
      const globalObject = globalThis as WebExtensionTestGlobal;
      const previous = { browser: globalObject.browser, chrome: globalObject.chrome };
      Object.assign(globalObject, { browser: undefined, chrome: undefined });
      try {
        expect(detectStorageRuntime().webExtension).toBe(false);
        Object.assign(globalObject, { [name]: { storage: {} } });
        expect(detectStorageRuntime().webExtension).toBe(true);
      } finally {
        Object.assign(globalObject, previous);
      }
    },
  );
});

describe('resolveAutoStorage', () => {
  it('prefers WebExtension storage on a host that is neither Bun nor Node', async () => {
    const globalObject = globalThis as WebExtensionTestGlobal;
    const previous = { browser: globalObject.browser, chrome: globalObject.chrome };
    Object.assign(globalObject, { browser: { storage: { local: {} } }, chrome: undefined });
    try {
      const storage = await resolveAutoStorage({ ...neitherBunNorNode, webExtension: true });
      expect(storage).toBeInstanceOf(WebExtensionStorage);
    } finally {
      Object.assign(globalObject, previous);
    }
  });

  it('falls back to IndexedDB when there is no extension storage', async () => {
    const storage = await resolveAutoStorage({ ...neitherBunNorNode, indexedDB: true });

    expect(storage).toBeInstanceOf(IndexedDBStorage);
    storage[Symbol.dispose]();
  });

  it('falls back to memory when no persistent browser storage exists either', async () => {
    expect(await resolveAutoStorage(neitherBunNorNode)).toBeInstanceOf(MemoryStorage);
  });
});

describe('resolveSQLiteStorage', () => {
  it('opens Bun SQLite on Bun', async () => {
    const storage = await resolveSQLiteStorage(':memory:', { ...neitherBunNorNode, bun: true });

    expect(storage.constructor.name).toBe('BunSQLiteStorage');
    storage[Symbol.dispose]();
  });

  it('refuses a host that is neither Bun nor Node', async () => {
    expect(await throwingRejectionOf(resolveSQLiteStorage(undefined, neitherBunNorNode))).toThrow(
      'SQLite storage is only available in Bun or Node runtimes.',
    );
  });
});
