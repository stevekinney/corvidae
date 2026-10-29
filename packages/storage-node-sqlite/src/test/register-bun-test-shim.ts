/**
 * Resolve `bun:test` to `bun-test-shim.ts` in a Node process. `node-sqlite.test.ts` passes this
 * module to `node --import` when it launches the native cases, so the shared storage suites, which
 * import `bun:test`, register their cases with `node:test`. `node --test` passes the flag on to the
 * process it runs each file in.
 */
import { registerHooks } from 'node:module';

const shimUrl = new URL('./bun-test-shim.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'bun:test') return { url: shimUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
