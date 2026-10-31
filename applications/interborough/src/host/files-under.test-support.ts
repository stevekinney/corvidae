/**
 * Every regular file under a directory, read as bytes. A home that holds plugin folders also holds
 * the link to the host's `node_modules`, and Bun's recursive `readdir` follows symbolic links, so
 * it can walk a loop (`ELOOP`) or the host's whole dependency tree. This walk descends only into
 * real directories and skips `node_modules`, so a symbolic link is never followed.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Every regular file under `directory`, by path, as bytes. */
export async function filesUnder(directory: string): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  const pending = [directory];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      // `isFile` and `isDirectory` are both false for a symbolic link, so a link is skipped.
      if (entry.isFile()) found.set(child, Buffer.from(await readFile(child)));
      else if (entry.isDirectory() && entry.name !== 'node_modules') pending.push(child);
    }
  }
  return found;
}
