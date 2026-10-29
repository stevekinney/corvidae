/**
 * COR-1439 — what every signal-shutdown host shares.
 *
 * A host is spawned as `<runtime> <host>.ts <mode> <directory>`. It reports
 * progress as one JSON object per stdout line, which the parent test reads as
 * a handshake, and writes anything the test asserts after exit to a marker
 * file synchronously, so the record is on disk before `process.exit`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Storage } from '@lostgradient/storage';

export interface HostArguments {
  readonly mode: string;
  readonly directory: string;
}

/** Reads `<mode> <directory>` and announces `loaded`, the first handshake every host sends. */
export function parseHostArguments(modes: readonly string[]): HostArguments {
  const [mode, directory] = process.argv.slice(2);
  if (mode === undefined || !modes.includes(mode) || directory === undefined) {
    process.stderr.write(`usage: <host> <${modes.join('|')}> <directory>\n`);
    process.exit(2);
  }
  // Static imports are fully evaluated before this runs, so `loaded` marks the
  // end of module loading, which the parent excludes from its hang deadline.
  announce('loaded');
  return { mode, directory };
}

/** One handshake line for the parent test. */
export function announce(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

export function writeMarker(directory: string, name: string, value: unknown): void {
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(value), 'utf8');
}

/**
 * The file-backed store: `NodeSQLiteStorage` (better-sqlite3) under native
 * Node, and `BunSQLiteStorage` (bun:sqlite) under Bun, which cannot load
 * better-sqlite3's native binding. Each adapter serves one runtime, and
 * `BunSQLiteStorage` imports `bun:sqlite` statically, so the host imports only
 * the adapter for the runtime it is running under.
 */
export async function openFileStorage(directory: string): Promise<Storage> {
  const path = join(directory, 'store.sqlite');
  if (process.versions.bun === undefined) {
    const { NodeSQLiteStorage } = await import('@lostgradient/storage-node-sqlite');
    return new NodeSQLiteStorage(path);
  }
  const { BunSQLiteStorage } = await import('@lostgradient/storage-bun-sqlite');
  return new BunSQLiteStorage(path);
}

/** Fails the host loudly instead of letting an unexpected state pass silently. */
export function fail(message: string): never {
  process.stderr.write(`host: ${message}\n`);
  process.exit(3);
}
