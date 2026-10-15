/**
 * Asset storage fixtures (COR-794), following the `BureauStorageFixture`
 * pattern in `./storage-fixtures.ts`: each fixture owns an isolated backend,
 * reports `openHandles()` from its own public call accounting, and never
 * deletes a path the caller supplied.
 *
 * - {@link createMemoryAssetStorageFixture} — the bounded, process-local
 *   backend (`createMemoryAssetStorage`). Its data dies with the fixture.
 * - {@link createDurableAssetStorageFixture} — the durable contract over a
 *   Weft SQLite `Storage` file. `restart()` closes the SQLite handle and
 *   reopens the same file, which is what a process restart looks like to the
 *   asset service: nothing in memory survives, everything persisted does.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeServices } from '@lostgradient/lifecycle';
import { BunSQLiteStorage } from '@lostgradient/weft';

import { createDurableAssetStorage, createMemoryAssetStorage } from '../assets/storage';
import type { AssetStorage } from '../assets/storage';

export interface AssetStorageFixture {
  readonly storage: AssetStorage;
  readonly path?: string | undefined;
  readonly owned: boolean;
  /** Storage calls started through this fixture and not yet finished. */
  openHandles(): readonly string[];
  dispose(): Promise<void>;
}

export interface DurableAssetStorageFixture extends AssetStorageFixture {
  readonly path: string;
  /** Closes the SQLite handle and returns a fixture over a fresh handle to the same file. */
  restart(): Promise<DurableAssetStorageFixture>;
}

let fixtureSequence = 0;

const ACCOUNTED_VERBS = ['get', 'set', 'delete', 'list', 'conditionalBatch'] as const;

/** Wraps every async verb with start/finish accounting, so a call still in flight is visible. */
function withHandleAccounting(storage: AssetStorage): {
  readonly storage: AssetStorage;
  readonly openHandles: () => readonly string[];
} {
  const open = new Map<number, string>();
  let sequence = 0;
  const wrapped: Record<string, unknown> = { durability: storage.durability };
  for (const verb of ACCOUNTED_VERBS) {
    const method = storage[verb] as (...args: unknown[]) => Promise<unknown>;
    wrapped[verb] = async (...args: unknown[]) => {
      const id = sequence++;
      open.set(id, `asset-storage:${verb}#${id}`);
      try {
        return await Reflect.apply(method, storage, args);
      } finally {
        open.delete(id);
      }
    };
  }
  return { storage: wrapped as unknown as AssetStorage, openHandles: () => [...open.values()] };
}

export function createMemoryAssetStorageFixture(
  options: { readonly maxBytes?: number | undefined } = {},
): AssetStorageFixture {
  const accounted = withHandleAccounting(
    createMemoryAssetStorage(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  );
  return {
    storage: accounted.storage,
    owned: true,
    openHandles: accounted.openHandles,
    dispose: async () => {},
  };
}

function openDurableFixture(path: string, owned: boolean): DurableAssetStorageFixture {
  const sqlite = new BunSQLiteStorage(path);
  const accounted = withHandleAccounting(createDurableAssetStorage(sqlite));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sqlite[Symbol.dispose]();
  };
  return {
    storage: accounted.storage,
    path,
    owned,
    openHandles: accounted.openHandles,
    restart: async () => {
      close();
      return openDurableFixture(path, owned);
    },
    dispose: async () => {
      close();
      if (owned) {
        await rm(path, { force: true });
        await rm(`${path}-wal`, { force: true });
        await rm(`${path}-shm`, { force: true });
      }
    },
  };
}

/**
 * A durable asset storage fixture over a SQLite file. Allocates (and on
 * `dispose()` removes) a temporary path unless `path` is supplied, in which
 * case the file is left in place.
 */
export function createDurableAssetStorageFixture(options: {
  readonly runtime: RuntimeServices;
  readonly path?: string | undefined;
}): DurableAssetStorageFixture {
  if (options.path !== undefined) return openDurableFixture(options.path, false);
  // Same disambiguation as `storage-fixtures.ts`: two runtimes each start
  // their identifier counter at 1, so the process id and a process-local
  // sequence keep their paths apart.
  fixtureSequence += 1;
  const identifier = options.runtime.identifiers.next('asset-storage-fixture');
  const path = join(
    tmpdir(),
    `bureau-assets-fixture-${process.pid}-${fixtureSequence}-${identifier}.sqlite`,
  );
  return openDurableFixture(path, true);
}
