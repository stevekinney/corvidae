import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableRuntime } from './server-owned-durable.ts';
import { peekApproval, requestApproval } from './server-owned-elicitation.ts';
import type { ServerOwnedRuntime } from './server-owned-runtime.ts';
import {
  RuntimeTerminatingError,
  disposeServerOwnedRuntime,
  serverOwnedRuntime,
} from './server-owned-runtime.ts';
import { installServerOwnedTestIsolation } from './server-owned-test-lock.ts';

export {
  RuntimeTerminatingError,
  disposeServerOwnedRuntime,
  durableRuntime,
  existsSync,
  join,
  mkdtempSync,
  peekApproval,
  requestApproval,
  rmSync,
  serverOwnedRuntime,
  tmpdir,
};
export type { ServerOwnedRuntime };

/**
 * The server-owned variant's disposal contract.
 *
 * This is the executable half of the "initialization, disposal, and hot-module
 * replacement leave nothing orphaned" requirement — but note there is NO
 * `import.meta.hot.dispose` hook to exercise. Vite reloads server modules
 * rather than hot-accepting them, so such a hook never fires; the `globalThis`
 * slot surviving module replacement is what prevents the leak, and
 * `server-owned-runtime.ts` records the measurement behind that.
 *
 * What is pinned here is the disposal path itself, which the specs and a
 * process teardown both use: a runtime is reused rather than rebuilt, every
 * registered teardown runs, a throwing one does not strand the rest, and a
 * fresh runtime is built afterwards.
 */
/**
 * The terminating latch is process-global and deliberately STICKY — once a
 * terminating disposal starts, nothing may build a runtime again, which is the
 * whole point of it. That makes it leak between tests: any spec that sets it
 * refuses every `serverOwnedRuntime()` in every spec that runs after it, and
 * the failure surfaces in the later test rather than the one that armed it.
 *
 * An ordinary disposal with no in-flight disposal clears the latch, so this
 * hook is the reset. Without it, tests pass or fail by position in the file.
 */
export function installServerOwnedRuntimeTestIsolation(): void {
  installServerOwnedTestIsolation(async () => {
    await disposeServerOwnedRuntime();
  });
}
