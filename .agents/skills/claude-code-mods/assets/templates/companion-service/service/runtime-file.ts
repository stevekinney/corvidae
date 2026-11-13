import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { RuntimeFile } from '../plugin/hooks/protocol.ts';

/** Where the service writes its runtime file, and where the mod looks for it by default. */
export function runtimeFilePath(): string {
  return (
    process.env.ATTENTION_QUEUE_RUNTIME_FILE ?? join(homedir(), '.attention-queue', 'runtime.json')
  );
}

/** A fresh 256-bit token, as hexadecimal. It is written to the runtime file and never printed. */
export function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * Writes the runtime file readable by this user alone, through a temporary
 * file and a rename, so a reader never sees half of it.
 */
export function writeRuntimeFile(path: string, runtime: RuntimeFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(runtime), { mode: 0o600 });
  renameSync(temporary, path);
}

/** Removes the runtime file only if it still names this process. */
export function removeRuntimeFile(path: string, pid: number): void {
  try {
    const current = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    if (current.pid === pid) rmSync(path, { force: true });
  } catch {
    // Already gone or replaced: nothing of ours to remove.
  }
}
