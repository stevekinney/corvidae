import { dirname, join, relative, sep } from 'node:path';

export const PLAYGROUND_ROOT = dirname(import.meta.dirname);
/** The application sits two directories below the repository root, at `applications/playground`. */
export const REPOSITORY_ROOT = dirname(dirname(PLAYGROUND_ROOT));
export const PLAYGROUND_TEMP_ROOT = join(PLAYGROUND_ROOT, '.tmp');
/** The mirror's package map, where each documented package's `lastPublishedVersion` is recorded. */
export const PACKAGE_MAP_PATH = join(REPOSITORY_ROOT, 'scripts', 'mirror', 'package-map.json');

export function relativeImportSpecifier(fromDirectory: string, targetPath: string): string {
  const relativePath = relative(fromDirectory, targetPath).replaceAll(sep, '/');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}
