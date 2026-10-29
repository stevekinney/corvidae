/**
 * What {@link NodeSQLiteStorage} needs from `better-sqlite3`: the structural types of the surface it
 * uses, and the classification of a failure to open its native binding. `better-sqlite3` is a
 * regular dependency imported statically by `node-sqlite.ts`; its native binding loads when the
 * first database opens, so a refused or never-compiled binding surfaces from the constructor,
 * where it is reshaped into an actionable error.
 *
 * Kept in its own module, and deliberately NOT in the package `exports` map, so these helpers
 * never become part of the documented public surface.
 *
 * @module storage/node-sqlite-loader
 */

/**
 * Minimal `better-sqlite3` `Database` surface this adapter uses. Defined here so
 * both the loader and the storage module compile without the package installed.
 */
export type BetterSqliteStatement = {
  run(...parameters: unknown[]): unknown;
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Record<string, unknown>[];
};

/**
 * A transaction wrapper from `better-sqlite3`'s `transaction()`. Calling it directly runs a
 * deferred transaction; `.immediate` runs the same function under `BEGIN IMMEDIATE`, which takes
 * the write lock before the first statement.
 */
export type BetterSqliteTransaction = ((...args: unknown[]) => unknown) & {
  immediate(...args: unknown[]): unknown;
};

export type BetterSqliteDatabase = {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): BetterSqliteStatement;
  transaction<TArguments extends unknown[], TResult>(
    fn: (...args: TArguments) => TResult,
  ): BetterSqliteTransaction;
  close(): void;
};

export type BetterSqliteConstructor = new (path: string) => BetterSqliteDatabase;

/**
 * Which way opening a `better-sqlite3` database failed. The three have different remedies,
 * so they are distinguished rather than collapsed.
 *
 * - `missing-package`: the module is not installed at all.
 * - `unbuilt-binding`: the module is installed but `better_sqlite3.node` was
 *   never compiled, because the package's `install` script did not run.
 * - `dlopen-failed`: the compiled binding exists but the runtime refused it.
 */
export type BetterSqlite3FailureKind = 'missing-package' | 'unbuilt-binding' | 'dlopen-failed';

/**
 * Classify a `better-sqlite3` load failure, or `undefined` when `error` is not
 * one and should be rethrown untouched.
 *
 * The `errorCode === undefined` branch is the one that matters most and reads
 * like an accident: `bindings` throws a plain `Error` with no `code` when it
 * cannot find the compiled addon. That is the signature of an install whose
 * lifecycle scripts were suppressed — `bun install --ignore-scripts` leaves the
 * package on disk, fully requirable, with no `build/` directory. Collapsing it
 * into "the dependency is missing" sent three separate investigations looking
 * for an absent module that was in fact present (COR-1278).
 */
/** Whether `message` names `module` the way a resolver error quotes it. */
function namesModule(message: string, module: string): boolean {
  return message.includes(`'${module}'`) || message.includes(`"${module}"`);
}

/** A `MODULE_NOT_FOUND` for the package itself or for the `bindings` loader it goes through. */
function classifyModuleNotFound(message: string): BetterSqlite3FailureKind | undefined {
  const relevant = namesModule(message, 'better-sqlite3') || namesModule(message, 'bindings');
  return relevant ? 'missing-package' : undefined;
}

/** A `bindings` lookup that found no compiled addon: the install script never ran. */
function classifyUncodedFailure(message: string): BetterSqlite3FailureKind | undefined {
  const locatesBinding =
    message.startsWith('Could not locate the bindings file.') &&
    message.includes('better_sqlite3.node');
  return locatesBinding ? 'unbuilt-binding' : undefined;
}

export function classifyBetterSqlite3Failure(error: unknown): BetterSqlite3FailureKind | undefined {
  if (!(error instanceof Error)) return undefined;

  const { message } = error;
  switch ((error as Error & { code?: unknown }).code) {
    case 'MODULE_NOT_FOUND':
      return classifyModuleNotFound(message);
    case 'ERR_DLOPEN_FAILED':
      return message.includes('better-sqlite3') ? 'dlopen-failed' : undefined;
    case undefined:
      return classifyUncodedFailure(message);
    default:
      return undefined;
  }
}

/** What to tell the caller for each way the load can fail. */
const failureGuidance: Record<BetterSqlite3FailureKind, string> = {
  'missing-package':
    'NodeSQLiteStorage requires the optional peer dependency "better-sqlite3". ' +
    'Install it in your application with: bun add better-sqlite3 (or npm install better-sqlite3).',
  'unbuilt-binding':
    'NodeSQLiteStorage found "better-sqlite3" installed, but its native binding was never ' +
    "compiled: the package's install script did not run. Reinstall with lifecycle scripts " +
    'enabled — bun install --force (an ordinary bun install will NOT rebuild an already-linked ' +
    'package), or npm rebuild better-sqlite3.',
  'dlopen-failed':
    'NodeSQLiteStorage could not load the "better-sqlite3" native binding in this runtime. ' +
    'The compiled addon is present but was refused; it must be run under Node.js, and built ' +
    'for this platform and ABI.',
};

/**
 * Build the actionable error thrown when `better-sqlite3` cannot be loaded.
 *
 * The underlying message is appended rather than swallowed. It was previously
 * carried only on `cause`, where nothing printed it: a test asserting on the
 * thrown message showed the same sentence for an absent package and an unbuilt
 * binding, which is the whole reason COR-1278 took four rounds to diagnose.
 */
export function createMissingBetterSqlite3Error(cause: unknown): Error {
  const kind = classifyBetterSqlite3Failure(cause);
  const guidance = kind ? failureGuidance[kind] : failureGuidance['missing-package'];
  const underlying = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${guidance}\nUnderlying error: ${underlying}`, { cause });
}

/**
 * Whether `error` is a recognizable `better-sqlite3` load failure (missing
 * package, unbuilt native binding, or dlopen failure) worth reshaping into the
 * actionable error rather than re-throwing raw.
 */
export function isBetterSqlite3LoadFailure(error: unknown): boolean {
  return classifyBetterSqlite3Failure(error) !== undefined;
}
