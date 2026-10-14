import { dirname, join, relative, sep } from 'node:path';

export const PLAYGROUND_ROOT = dirname(import.meta.dirname);
/** The application sits two directories below the repository root, at `applications/playground`. */
export const REPOSITORY_ROOT = dirname(dirname(PLAYGROUND_ROOT));
export const PLAYGROUND_TEMP_ROOT = join(PLAYGROUND_ROOT, '.tmp');
/** The root component every imperatively mounted example, preview, and fixture renders beneath. */
export const CODE_HIGHLIGHTER_ROOT_PATH = join(
  PLAYGROUND_ROOT,
  'src',
  'code-highlighter-root.svelte',
);
/** The mirror's package map, where each documented package's `lastPublishedVersion` is recorded. */
export const PACKAGE_MAP_PATH = join(REPOSITORY_ROOT, 'scripts', 'mirror', 'package-map.json');

export function relativeImportSpecifier(fromDirectory: string, targetPath: string): string {
  const relativePath = relative(fromDirectory, targetPath).replaceAll(sep, '/');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

/**
 * `path` relative to the repository root, with POSIX separators. Anything the static export
 * publishes names source files this way, so the exported bytes are the same in every checkout
 * and never reveal the build machine's directory layout.
 */
export function repositoryRelativePath(path: string): string {
  return relative(REPOSITORY_ROOT, path).replaceAll(sep, '/');
}

/**
 * `value` with every absolute path under the repository root, in any string it holds, made
 * repository-relative. Type text from ts-morph names a type it cannot print locally as
 * `import("<absolute path>").Name`, and the static export publishes it.
 */
export function withRepositoryRelativePaths<T>(value: T): T {
  const prefix = `${REPOSITORY_ROOT}${sep}`;
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return item.replaceAll(prefix, '');
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    }
    return item;
  };
  return visit(value) as T;
}
