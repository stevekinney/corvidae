/**
 * The build digest: one SHA-256 value that names the exact bytes of a served directory.
 *
 * The manifest lists the SHA-256 of every file under the directory, keyed by its POSIX path
 * relative to that directory and sorted by path (code-unit order, so the result never depends on
 * a locale). The digest is the SHA-256 of that manifest serialized as `<sha256>  <path>\n` lines,
 * the `sha256sum` format, so anyone can reproduce it from a directory listing. The static export
 * records it, the static production gate recomputes it, and deployed verification reproduces it
 * from the live responses with the same algorithm.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type DigestManifestEntry = { path: string; sha256: string };

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`[static-playground] ${path} is neither a file nor a directory`);
  }
  return files;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Hash every file under `directory`, keyed by its POSIX path relative to it, sorted by path. */
export async function createDigestManifest(
  directory: string,
  signal?: AbortSignal,
): Promise<DigestManifestEntry[]> {
  const entries: DigestManifestEntry[] = [];
  for (const file of await filesUnder(directory)) {
    // Stop between files once the caller gives up, rather than hash a whole build it will not use.
    signal?.throwIfAborted();
    entries.push({
      path: relative(directory, file).split(sep).join('/'),
      sha256: createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    });
  }
  return entries.toSorted((left, right) => compareCodeUnits(left.path, right.path));
}

/** Serialize a manifest as `sha256sum` lines: `<sha256>  <path>\n` per file. */
export function serializeDigestManifest(manifest: readonly DigestManifestEntry[]): string {
  return manifest.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
}

/** The build digest of a manifest: the SHA-256 of its serialized lines. */
export function buildDigestOf(manifest: readonly DigestManifestEntry[]): string {
  return createHash('sha256').update(serializeDigestManifest(manifest)).digest('hex');
}
