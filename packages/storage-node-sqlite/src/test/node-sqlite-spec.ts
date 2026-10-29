/**
 * The durability suites' spec for `NodeSQLiteStorage`: its adapter, the module its child entrypoints
 * import, and the raw `better-sqlite3` handle the suites open beside it. The suites themselves live
 * in `@lostgradient/storage/testing`. `better-sqlite3` loads only under Node, so the suites run with
 * this spec only in `node-sqlite-durability.integration.ts`, under `node --test`.
 */

import { createRequire } from 'node:module';

import type { Storage } from '@lostgradient/storage';
import {
  isFullyCheckpointed,
  makeNullValueFailingBatch,
  type CheckpointResult,
  type RawHandleAdapterSpec,
  type WalCheckpointRow,
} from '@lostgradient/storage/testing';
import { NodeSQLiteStorage } from '../node-sqlite.ts';

/** Matches the surface of `BetterSqliteDatabase` in `src/node-sqlite.ts`. */
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

// The child entrypoint is written to the system temp directory, where `better-sqlite3` does not
// resolve, so the raw handle requires it from this module's location in the package.
const NODE_SQLITE_RAW_HANDLE = {
  childImports: "import { createRequire } from 'node:module';",
  openSource: [
    `const requireFromHere = createRequire(${JSON.stringify(import.meta.url)});`,
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
 * The spec for `NodeSQLiteStorage`, built over its adapter and `better-sqlite3` driver so a Bun test
 * can stand in for both: they load only under Node, which `bun test` is not.
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

/** The spec for the real `NodeSQLiteStorage` and `better-sqlite3`, which open only under Node. */
export const nodeSqliteSpec: RawHandleAdapterSpec = createNodeSqliteSpec({
  storageConstructor: NodeSQLiteStorage,
  loadDriver: loadBetterSqlite3Locally,
});
