import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Every generated path `clean` removes, relative to the playground root. */
export const GENERATED_PATHS = ['.tmp', 'build', 'build-report'] as const;

/** Remove the playground's generated output and stray `src/.tmp-*` build directories. */
export async function cleanPlayground(playgroundRoot: string): Promise<void> {
  for (const path of GENERATED_PATHS) {
    await rm(join(playgroundRoot, path), { recursive: true, force: true });
  }
  const sourceDirectory = join(playgroundRoot, 'src');
  const sourceDirectoryEntries = await readdir(sourceDirectory, { withFileTypes: true });
  await Promise.all(
    sourceDirectoryEntries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.tmp-'))
      .map((entry) => rm(join(sourceDirectory, entry.name), { recursive: true, force: true })),
  );
}

if (import.meta.main) {
  await cleanPlayground(join(import.meta.dir, '..'));
}
