import { isAbsolute, join, relative as relativePath } from 'node:path';

/**
 * Resolve `requestedPath` against `baseDir`, rejecting anything that would
 * lexically escape it: any `.` or `..` path *segment* (not merely a `..`
 * substring, which would also reject harmless filenames like `foo..css`), a
 * leading or embedded empty segment (e.g. a leading `/` or a doubled `//`),
 * or — as defense-in-depth — a `join()`-then-`relative()` round-trip that
 * lands outside `baseDir`. Segments are split on both `/` and `\`: `join()`
 * is platform-specific (win32 treats `\` as a separator; POSIX doesn't), so
 * splitting on `/` alone would let a backslash-disguised `..` segment (e.g.
 * `foo/..\..\secret.css`) slip past this check on POSIX while still
 * escaping `baseDir` if the same code ran on win32. Returns the absolute
 * path, or `null` when the request is unsafe.
 *
 * This is a LEXICAL containment check only — it operates on path strings and
 * does not call `fs.realpath`/`fs.lstat`. It does not detect a symlink
 * located inside `baseDir` whose target resolves outside `baseDir`; such a
 * symlink would pass this check and the subsequent `Bun.file().exists()`
 * read would follow it. The roots it guards are the stylesheet roots of
 * `package-stylesheets.ts` (core's `src/styles` and components roots, and the
 * directory of each style package core depends on: the tokens, the foundation,
 * every family) and each package's component roots in `component-sources.ts`.
 * The style package roots are resolved with `realpathSync`, so a root reached
 * through `node_modules` (where the isolated linker links core's dependencies)
 * is the package's own directory, and none of these source trees contains a
 * symlink (verified with `find components/*\/src applications/playground/src
 * -type l`), so this gap is not currently exploitable through these call
 * sites. If a future caller serves a directory that may contain symlinks, it
 * must add an `fs.realpathSync` check on the resolved path before serving the
 * file — this function alone is not sufficient for that case.
 */
export function resolveSafePath(baseDir: string, requestedPath: string): string | null {
  // A NUL byte survives every string-level check here but makes Bun.file()
  // throw a TypeError at the call site, surfacing as an unhandled rejection
  // instead of a clean 404 — reject it at the boundary that owns the contract.
  if (requestedPath.includes('\0')) return null;

  const segments = requestedPath.split(/[/\\]/);
  const hasUnsafeSegment = segments.some(
    (segment) => segment === '' || segment === '.' || segment === '..',
  );
  if (hasUnsafeSegment) return null;

  const resolved = join(baseDir, requestedPath);
  const relativeToBase = relativePath(baseDir, resolved);
  if (relativeToBase.startsWith('..') || isAbsolute(relativeToBase)) return null;
  return resolved;
}
