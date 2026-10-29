/**
 * The one place this package's tests read the process environment: the `PATH` native Node is
 * located on and the integration child inherits.
 *
 * Bun's `run.bun` setting can prepend a virtual `node` shim directory that does not exist on disk;
 * it is dropped here. The remaining shims are filesystem links to Bun, which `resolveNativeNode` in
 * `node-sqlite.test.ts` rejects by asking each candidate which runtime it is.
 */
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

/** The directories native Node is searched on, and the environment a Node child inherits. */
export interface NativeNodeEnvironment {
  /** `PATH` without the directories that do not exist on disk. */
  readonly searchPath: string;
  /** The process environment with `PATH` replaced by {@link NativeNodeEnvironment.searchPath}. */
  readonly env: Record<string, string | undefined>;
}

/** Read `PATH` from the process environment and drop the directories that do not exist. */
export function nativeNodeEnvironment(): NativeNodeEnvironment {
  const searchPath = (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(existsSync)
    .join(delimiter);
  return { searchPath, env: { ...process.env, PATH: searchPath } };
}
