/**
 * The durability suites' specs for the disk-backed SQLite adapters Weft still holds: Node SQLite and
 * Turso (whose spec lives in `turso-adapter-spec.test-support.ts`). Bun SQLite's spec lives in
 * `@lostgradient/storage-bun-sqlite`. The suites and their adapter-independent support live in
 * `@lostgradient/storage/testing`; each spec carries its adapter, the module its child entrypoints
 * import, and, for Node, the raw-handle hooks.
 */

import { createRequire } from 'node:module';

import type { Storage } from '@lostgradient/storage';
import {
  isFullyCheckpointed,
  makeNullValueFailingBatch,
  type AdapterSpec,
  type CheckpointResult,
  type RawHandleAdapterSpec,
  type WalCheckpointRow,
} from '@lostgradient/storage/testing';
import { NodeSQLiteStorage } from '../node-sqlite.ts';
import { tursoSpec } from './turso-adapter-spec.test-support.ts';

/** Matches the surface of `BetterSqliteDatabase` in `src/storage/node-sqlite.ts`. */
type BetterSqliteDatabase = {
  pragma(source: string): unknown;
  close(): void;
};

type BetterSqliteConstructor = new (path: string) => BetterSqliteDatabase;

/** The module `better-sqlite3` loads as, whichever way its CommonJS build exports the constructor. */
type BetterSqliteModule = BetterSqliteConstructor & { default?: BetterSqliteConstructor };

/**
 * Load `better-sqlite3`, the Node-only native binding, through `requireModule`.
 *
 * `createRequire` because this project is ESM and `better-sqlite3` is a CJS native binding. The
 * constructor is the module's `default` export or the module itself, the same pattern as
 * `node-sqlite.ts`. Node caches the module, so loading it again costs nothing.
 *
 * @param requireModule - how the module is required, which a test replaces
 */
export function loadBetterSqlite3Locally(
  requireModule: (id: string) => unknown = createRequire(import.meta.url),
): BetterSqliteConstructor {
  const mod = requireModule('better-sqlite3') as BetterSqliteModule;
  return typeof mod.default === 'function' ? mod.default : mod;
}

const NODE_SQLITE_RAW_HANDLE = {
  childImports: "import { createRequire } from 'node:module';",
  openSource: [
    'const requireFromHere = createRequire(import.meta.url);',
    "const BetterSqlite3 = requireFromHere('better-sqlite3');",
    'const database = new BetterSqlite3(databasePath);',
    "database.pragma('journal_mode = WAL');",
    "database.pragma('synchronous = NORMAL');",
  ].join('\n'),
};

/** What {@link createNodeSqliteSpec} needs from the Node SQLite adapter and its raw driver. */
type NodeSqliteSpecDependencies = {
  /** The adapter under test, opened on a database path. */
  readonly storageConstructor: new (databasePath: string) => Storage;
  /** The raw `better-sqlite3` constructor, for the checkpoint passthrough. */
  readonly loadDriver: () => BetterSqliteConstructor;
};

/**
 * The spec for `NodeSQLiteStorage`, built over its adapter and `better-sqlite3` driver so a test can
 * stand in for both: they load only under Node, which `bun test` is not.
 *
 * @param dependencies - the adapter constructor and driver loader the spec uses
 */
export function createNodeSqliteSpec(
  dependencies: NodeSqliteSpecDependencies,
): RawHandleAdapterSpec {
  return {
    name: 'NodeSQLiteStorage',
    exposesStandardSidecars: true,
    expectedCapabilities: {
      persistence: 'local',
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: false,
    },
    child: {
      moduleSpecifier: import.meta.resolve('../node-sqlite.ts'),
      exportName: 'NodeSQLiteStorage',
      constructorArgument: 'path',
    },
    rawHandle: NODE_SQLITE_RAW_HANDLE,
    async open(databasePath: string) {
      const storage = new dependencies.storageConstructor(databasePath);
      return {
        storage,
        databasePath,
        async checkpoint(): Promise<CheckpointResult> {
          const BetterSqlite3Constructor = dependencies.loadDriver();
          const database = new BetterSqlite3Constructor(databasePath);
          try {
            const raw = database.pragma('wal_checkpoint(TRUNCATE)') as
              readonly WalCheckpointRow[] | WalCheckpointRow;
            const row = Array.isArray(raw) ? raw[0] : raw;
            return { truncated: isFullyCheckpointed(row, databasePath), raw };
          } finally {
            database.close();
          }
        },
        async close(): Promise<void> {
          storage[Symbol.dispose]();
        },
        makeFailingBatch: makeNullValueFailingBatch,
      };
    },
  };
}

const nodeSqliteSpec = createNodeSqliteSpec({
  storageConstructor: NodeSQLiteStorage,
  loadDriver: loadBetterSqlite3Locally,
});

/**
 * Whether `better-sqlite3` is loadable in the current runtime. Bun cannot
 * load better-sqlite3's native bindings (oven-sh/bun#4290), so Node-SQLite
 * integration tests run only when the suite is invoked under Node. Mirrors
 * the gating pattern in `src/storage/node-sqlite.test.ts`.
 */
const IS_BUN = typeof globalThis.Bun !== 'undefined';

/**
 * Whether the Node SQLite adapter opens in this runtime: never under Bun, which skips the attempt,
 * and under Node when the native binding loads and an in-memory database opens and closes.
 *
 * @param runningUnderBun - whether the suite runs under Bun
 * @param storageConstructor - the adapter to open an in-memory database with
 */
export function canLoadNodeSqliteWith(
  runningUnderBun: boolean,
  storageConstructor: new (databasePath: string) => Storage,
): boolean {
  if (runningUnderBun) return false;
  try {
    new storageConstructor(':memory:')[Symbol.dispose]();
  } catch {
    return false;
  }
  return true;
}

let nodeSqliteAvailable: boolean | undefined;
function canLoadNodeSqlite(): boolean {
  nodeSqliteAvailable ??= canLoadNodeSqliteWith(IS_BUN, NodeSQLiteStorage);
  return nodeSqliteAvailable;
}

/** All adapter specs available in the current runtime. */
export function availableAdapterSpecs(): readonly AdapterSpec[] {
  const specs: AdapterSpec[] = [tursoSpec];
  if (canLoadNodeSqlite()) specs.push(nodeSqliteSpec);
  return specs;
}

/** The specs with a raw same-file handle, for tests that need a raw client path; Node SQLite only. */
export function availableRawHandleAdapterSpecs(): readonly RawHandleAdapterSpec[] {
  const specs: RawHandleAdapterSpec[] = [];
  if (canLoadNodeSqlite()) specs.push(nodeSqliteSpec);
  return specs;
}
