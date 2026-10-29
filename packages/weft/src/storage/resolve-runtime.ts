/**
 * Runtime detection behind {@link resolveStorage}'s SQLite and automatic choices. Kept apart from
 * `resolve.ts`, which the package root re-exports in full, so the host description it takes is an
 * internal seam: tests describe a host they are not running on without it becoming public API.
 *
 * @module storage/resolve-runtime
 */

import { type Storage, MemoryStorage } from '@lostgradient/storage';
import { resolveDefaultStorage } from './auto.ts';
import { BunSQLiteStorage } from './bun-sql.ts';
import { IndexedDBStorage } from './indexeddb.ts';
import { NodeSQLiteStorage } from './node-sqlite.ts';
import { WebExtensionStorage } from './web-extension.ts';

function isBunRuntime(): boolean {
  return typeof Bun !== 'undefined';
}

function isNodeRuntime(): boolean {
  return (
    typeof globalThis.process === 'object' &&
    globalThis.process !== null &&
    typeof globalThis.process.versions === 'object' &&
    typeof globalThis.process.versions.node === 'string'
  );
}

function hasWebExtensionStorage(): boolean {
  const candidate = globalThis as typeof globalThis & {
    browser?: { storage?: unknown };
    chrome?: { storage?: unknown };
  };
  return candidate.browser?.storage !== undefined || candidate.chrome?.storage !== undefined;
}

function hasIndexedDB(): boolean {
  return typeof globalThis.indexedDB !== 'undefined';
}

/** What the host runtime offers, as far as default storage selection is concerned. */
export type StorageRuntime = {
  readonly bun: boolean;
  readonly node: boolean;
  readonly webExtension: boolean;
  readonly indexedDB: boolean;
};

/** Read the running host's {@link StorageRuntime} from its globals. */
export function detectStorageRuntime(): StorageRuntime {
  return {
    bun: isBunRuntime(),
    node: isNodeRuntime(),
    webExtension: hasWebExtensionStorage(),
    indexedDB: hasIndexedDB(),
  };
}

/**
 * Open the SQLite adapter for a runtime: Bun's built-in driver under Bun, better-sqlite3 under
 * Node, and an error anywhere else. Takes the runtime so tests can describe a host they are not
 * running on.
 */
export async function resolveSQLiteStorage(
  path?: string,
  runtime: StorageRuntime = detectStorageRuntime(),
): Promise<Storage> {
  if (runtime.bun) {
    return new BunSQLiteStorage(path);
  }

  if (runtime.node) {
    return new NodeSQLiteStorage(path);
  }

  throw new Error('SQLite storage is only available in Bun or Node runtimes.');
}

/**
 * Pick the default storage for a runtime: the server default under Bun or Node, then extension
 * storage, IndexedDB, and finally memory. Takes the runtime so tests can describe a host they are
 * not running on.
 */
export async function resolveAutoStorage(
  runtime: StorageRuntime = detectStorageRuntime(),
): Promise<Storage> {
  if (runtime.bun || runtime.node) {
    return resolveDefaultStorage();
  }

  if (runtime.webExtension) {
    return new WebExtensionStorage();
  }

  if (runtime.indexedDB) {
    return new IndexedDBStorage();
  }

  return new MemoryStorage();
}
