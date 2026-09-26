import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fileReadConcurrency, mapWithConcurrency } from './map-with-concurrency';

const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.svelte',
]);

const NUL = 0x00;

/**
 * Every tracked or untracked-but-not-ignored source file under `root`, relative to it.
 *
 * Git already knows which trees are generated: `node_modules`, build output, and tool caches are
 * pruned by the repository's own `.gitignore` files without being walked. Only those per-directory
 * files are consulted—`--exclude-standard` would also apply `.git/info/exclude` and the
 * developer's global `core.excludesFile`, letting local configuration silently exempt a source file
 * from the check.
 */
export function sourceFiles(root: string): string[] {
  const listing = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-per-directory=.gitignore'],
    { cwd: root },
  );
  if (listing.exitCode !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${listing.stderr.toString()}`);
  }
  const paths = new Set(listing.stdout.toString().split('\0').filter(Boolean));
  return [...paths]
    .filter((path) => sourceExtensions.has(path.slice(path.lastIndexOf('.'))))
    .toSorted();
}

function nulOffsets(bytes: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let index = bytes.indexOf(NUL); index !== -1; index = bytes.indexOf(NUL, index + 1)) {
    offsets.push(index);
  }
  return offsets;
}

async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    // `--cached` lists index entries whose working-tree file has been deleted.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Each source file under `root` that contains a raw NUL byte, with the byte offsets. */
export async function nulByteOffenders(
  root: string,
): Promise<{ files: number; offenders: string[] }> {
  const files = sourceFiles(root);
  const findings = await mapWithConcurrency(files, fileReadConcurrency, async (file) => {
    const bytes = await readIfPresent(join(root, file));
    if (bytes === undefined || !bytes.includes(NUL)) return [];
    const offsets = nulOffsets(bytes);
    return [`${file} (${offsets.length} at ${offsets.join(', ')})`];
  });
  return { files: files.length, offenders: findings.flat() };
}
