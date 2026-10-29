/**
 * Fixture for the "Turso's driver import is deferred, not just moved"
 * subprocess gate.
 *
 * Run by `turso-driver-deferred.test.ts`, once per package entry (`./index.ts` or `./web.ts`, passed
 * as the first argument), inside the sandbox
 * `turso-driver-sandbox.test-support.ts` builds, where `@libsql/client` is not installed.
 * Constructing `TursoStorage` must not need `@libsql/client`; only its first
 * real operation may. That distinguishes "the import moved to first use"
 * from "the import was removed" — a `TursoStorage` that never threw at all
 * here would just mean nobody proved it still calls the driver.
 *
 * @module storage-turso/turso-driver-deferred-fixture
 */
import type * as Entry from './index.ts';

const entry = Bun.argv[2];
if (entry !== './index.ts' && entry !== './web.ts') {
  throw new Error(`expected the entry to load as ./index.ts or ./web.ts, got ${String(entry)}`);
}

// Loading the entry must not require the optional driver either.
const { TursoStorage } = (await import(entry)) as typeof Entry;

// Construction alone must not require the optional driver.
const storage = new TursoStorage({ url: 'file::memory:' });

let rejectedWithMissingDriver = false;
try {
  await storage.get('anything');
} catch (error) {
  // Bun reports a failed dynamic `import()` as a `ResolveMessage`, which is not an `Error`.
  const message =
    typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : '';
  rejectedWithMissingDriver = /cannot find (module|package)|resolving package/i.test(message);
  if (!rejectedWithMissingDriver) throw error;
}

if (!rejectedWithMissingDriver) {
  throw new Error(
    'expected the first operation to reject once the optional @libsql/client driver is unresolvable',
  );
}

console.info('ok');
