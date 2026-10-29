/**
 * How storage adapters load a Node built-in without a static `node:*` import.
 *
 * This is storage's own copy of the loading helper in Weft's `runtime/portable.ts`. Weft's helper
 * shares one test-override registry with its runtime detection, so storage keeps a separate copy
 * with a separate override, {@link setStorageRuntimeTestOverridesForTesting}, instead of splitting
 * that registry.
 *
 * The only remaining caller is `@lostgradient/storage-turso`, whose choice between the native and
 * the web libSQL client rests on it. That choice is the one runtime fallback inside an adapter and
 * is pending an owner decision (COR-1783); once it is decided, this module goes with it.
 *
 * @module runtime
 */

/** The globals a test can stand in for while it exercises a loading fallback. */
export type StorageRuntimeTestOverrides = {
  /** The `process` object the loader reads, or `undefined` to simulate a runtime without one. */
  process?: typeof globalThis.process | undefined;
};

let storageRuntimeTestOverrides: StorageRuntimeTestOverrides | undefined;

/**
 * Replace the globals the storage loader reads, or restore the real ones with no argument.
 *
 * @param overrides - the stand-in globals; a key that is present overrides even when `undefined`
 * @example
 * ```ts
 * import { setStorageRuntimeTestOverridesForTesting, tryLoadNodeBuiltin } from '@lostgradient/storage/runtime';
 *
 * setStorageRuntimeTestOverridesForTesting({ process: undefined });
 * console.log(tryLoadNodeBuiltin('node:module')); // undefined
 * setStorageRuntimeTestOverridesForTesting();
 * ```
 */
export function setStorageRuntimeTestOverridesForTesting(
  overrides?: StorageRuntimeTestOverrides,
): void {
  storageRuntimeTestOverrides = overrides;
}

/**
 * The `process` object of this runtime, or the one a test substituted.
 *
 * @returns the process global, or `undefined` in a runtime without one
 * @example
 * ```ts
 * import { getProcess } from '@lostgradient/storage/runtime';
 *
 * console.log(typeof getProcess()?.versions); // 'object' under Bun or Node
 * ```
 */
export function getProcess(): typeof globalThis.process | undefined {
  if (storageRuntimeTestOverrides && 'process' in storageRuntimeTestOverrides) {
    return storageRuntimeTestOverrides.process;
  }
  return globalThis.process;
}

/**
 * Load a Node.js built-in module without a static `node:*` import.
 *
 * Storage is ESM, so `require` is not defined under Node. `process.getBuiltinModule` (Node 22.5+,
 * also implemented by Bun) loads a built-in from ESM code without a static specifier that a
 * browser bundler would try to resolve or stub. Returns `undefined` in the browser or any runtime
 * lacking `process.getBuiltinModule`, so callers on a browser-reachable path must treat the result
 * as optional rather than throwing at import time.
 *
 * Overloaded per known specifier so callers get the module type from the literal `id` alone. Add a
 * literal overload here when a new built-in specifier is loaded through this helper.
 *
 * @param id - the built-in module specifier
 * @returns the module, or `undefined` when this runtime cannot load built-ins
 * @example
 * ```ts
 * import { tryLoadNodeBuiltin } from '@lostgradient/storage/runtime';
 *
 * const module = tryLoadNodeBuiltin('node:module');
 * console.log(typeof module?.createRequire); // 'function' under Bun or Node
 * ```
 */
export function tryLoadNodeBuiltin(id: 'node:module'): typeof import('node:module') | undefined;
export function tryLoadNodeBuiltin(id: string): unknown {
  const nodeProcess = getProcess();
  if (typeof nodeProcess?.getBuiltinModule !== 'function') {
    return undefined;
  }
  return nodeProcess.getBuiltinModule(id);
}
