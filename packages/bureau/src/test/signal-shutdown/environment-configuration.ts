/**
 * COR-1439 — the one place the signal-shutdown tests read the process
 * environment: the `PATH` native Node is located on and the hosts inherit.
 *
 * Bun's `run.bun` setting can prepend a virtual `node` shim directory that
 * does not exist on disk; it is dropped, as `node-sqlite.test.ts` drops it.
 * The remaining shims are filesystem links to Bun, which
 * `resolveNativeNode` rejects by asking each candidate which runtime it is.
 */
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

export interface NativeNodeEnvironment {
  readonly searchPath: string;
  readonly env: Record<string, string | undefined>;
}

export function nativeNodeEnvironment(): NativeNodeEnvironment {
  const searchPath = (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(existsSync)
    .join(delimiter);
  return { searchPath, env: { ...process.env, PATH: searchPath } };
}
