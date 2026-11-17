import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Directories whose newest file mtime feeds the playground server's startup
 * fingerprint, relative to the repository root. The server computes its own
 * fingerprint at startup and again whenever `/ready` is asked whether a
 * running server is still current, resolving these against the repository
 * root it was started from.
 */
export const FINGERPRINT_SOURCE_DIRECTORIES = [
  'applications/playground/src',
  'components/core/src',
  'components/chat/src',
  // The playground server itself and its build helpers live under these
  // `scripts` trees. An edit to the SERVER/bundler code must invalidate the
  // fingerprint too, or a running server with the old server code loaded
  // looks fresh. Whole-dir coverage over-refreshes on unrelated script edits,
  // which is the safe direction: a spurious rebuild costs seconds, while a
  // stale reuse silently tests the wrong bytes.
  'components/core/scripts',
  'components/tokens/scripts',
  // Cinder's generators and the stylesheet fingerprint the server imports (COR-2079).
  'internal/component-tooling/scripts',
  'applications/playground/scripts',
  // The playground bundles these upstream workspaces alongside the public
  // Cinder and Chat packages. The public packages already have source
  // coverage above; these upstream source trees must be listed explicitly
  // too, or a running server built from stale upstream code looks fresh.
  'packages/markdown/src',
  'components/editor/src',
] as const;

/** Package metadata read by playground discovery, documentation, and bundling. */
export const FINGERPRINT_SOURCE_FILES = [
  'applications/playground/package.json',
  'components/core/package.json',
  'components/core/.metadata/components.json',
  'components/chat/package.json',
  'components/chat/.metadata/components.json',
  'components/editor/package.json',
  'components/editor/.metadata/components.json',
  // The documentation's displayed package versions.
] as const;

/** Core's manifest, relative to the repository root: it names the family packages core lists. */
export const CORE_MANIFEST_FILE = 'components/core/.metadata/components.json';

/**
 * The `src` directory and `package.json` of every family package core's manifest names
 * (COR-2085), relative to the repository root. A component extracted from core into a family is
 * fingerprinted where it now lives, with no edit here. Empty when the manifest is absent or
 * unreadable, which the fixed lists above already fingerprint.
 */
export function familyPackageFingerprintPaths(repoRoot: string): {
  directories: string[];
  files: string[];
} {
  // Source paths are relative to core's directory, the parent of the manifest's `.metadata/`.
  const coreRoot = dirname(dirname(join(repoRoot, CORE_MANIFEST_FILE)));
  let manifest: { components?: { source?: { packageRoot?: unknown } }[] };
  try {
    manifest = JSON.parse(
      readFileSync(join(repoRoot, CORE_MANIFEST_FILE), 'utf8'),
    ) as typeof manifest;
  } catch {
    return { directories: [], files: [] };
  }
  const packageRoots = new Set<string>();
  for (const component of manifest.components ?? []) {
    const packageRoot = component.source?.packageRoot;
    if (typeof packageRoot === 'string' && packageRoot !== '.') {
      packageRoots.add(relative(repoRoot, resolve(coreRoot, packageRoot)).split(sep).join('/'));
    }
  }
  const roots = [...packageRoots].toSorted();
  return {
    directories: roots.map((root) => `${root}/src`),
    files: roots.map((root) => `${root}/package.json`),
  };
}

/** The two filesystem reads a walk makes; the real ones in production, replaceable so a test can make a file or a directory vanish or fail. */
export type FingerprintFilesystem = {
  readDirectory: (path: string) => Dirent<string>[];
  statFile: (path: string) => { mtimeMs: number };
};

const REAL_FILESYSTEM: FingerprintFilesystem = {
  readDirectory: (path) => readdirSync(path, { withFileTypes: true }),
  statFile: (path) => statSync(path),
};

/**
 * Whether `error` says the path is gone: `ENOENT` for a file or directory deleted or renamed after
 * it was listed (or never there), `ENOTDIR` for a directory replaced by a file. Anything else (a
 * permission failure, an I/O error) means the walk could not see something that exists.
 */
function isVanishedPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

/**
 * Walk `directory` and return the newest file `mtimeMs` found anywhere in its
 * tree, or `null` if the directory does not exist or contains no files.
 *
 * The walk runs while the watcher is live, so a file can be deleted or renamed
 * between the directory listing that named it and the `stat` that reads its
 * mtime. Such an entry is skipped: it no longer exists, so it cannot be the
 * newest file, and a later fingerprint comparison sees whatever replaced it. The
 * same goes for a directory that disappears. Any other failure, to stat a file
 * or to read a directory that exists, propagates: a fingerprint that silently
 * left a whole source tree out would report a stale server as fresh.
 */
export function newestFileMtimeMs(
  directory: string,
  filesystem: Partial<FingerprintFilesystem> = {},
): number | null {
  const { readDirectory, statFile } = { ...REAL_FILESYSTEM, ...filesystem };
  let newest: number | null = null;
  const stack: string[] = [directory];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent<string>[];
    try {
      entries = readDirectory(current);
    } catch (error) {
      if (isVanishedPath(error)) continue;
      throw error;
    }

    for (const entry of entries) {
      // Skip dot-prefixed directories such as the playground server's
      // `.tmp-<uuid>` build scratch dirs (applications/playground/src/.tmp-*).
      // Those are removed in a `finally` block once a build finishes, but an
      // in-flight or orphaned-by-kill build could otherwise push the newest
      // mtime past the running server's own startup fingerprint and produce
      // a spurious "stale server" refusal.
      if (entry.isDirectory() && entry.name.startsWith('.')) continue;

      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      let mtimeMs: number;
      try {
        mtimeMs = statFile(fullPath).mtimeMs;
      } catch (error) {
        if (isVanishedPath(error)) continue;
        throw error;
      }
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
    }
  }

  return newest;
}

/**
 * Compute the newest source mtime across every directory in
 * `FINGERPRINT_SOURCE_DIRECTORIES`, resolved against `repoRoot`.
 *
 * Returns `null` if none of the directories contain any files (should not
 * happen in a real checkout, but keeps this honest rather than returning `0`
 * and looking like a real timestamp).
 */
export function newestSourceMtimeMs(
  repoRoot: string,
  filesystem: Partial<FingerprintFilesystem> = {},
): number | null {
  const { statFile } = { ...REAL_FILESYSTEM, ...filesystem };
  const families = familyPackageFingerprintPaths(repoRoot);
  let newest: number | null = null;
  for (const relativeDirectory of [...FINGERPRINT_SOURCE_DIRECTORIES, ...families.directories]) {
    const candidate = newestFileMtimeMs(join(repoRoot, relativeDirectory), filesystem);
    if (candidate !== null && (newest === null || candidate > newest)) newest = candidate;
  }
  for (const relativeFile of [...FINGERPRINT_SOURCE_FILES, ...families.files]) {
    let candidate: number;
    try {
      candidate = statFile(join(repoRoot, relativeFile)).mtimeMs;
    } catch (error) {
      // A source package may be absent while a branch is being assembled. A file that exists but
      // cannot be read is not absent: leaving it out would fingerprint an input the server never saw.
      if (isVanishedPath(error)) continue;
      throw error;
    }
    if (newest === null || candidate > newest) newest = candidate;
  }
  return newest;
}

/** JSON-serializable identity a playground server reports at startup. */
export type PlaygroundFreshnessFingerprint = {
  /** `Date.now()` when the server process started computing its fingerprint. */
  startedAtMs: number;
  /** Newest source `mtimeMs` across the fingerprinted directories at that time. */
  newestSourceMtimeMs: number | null;
};

/**
 * A running server is stale if the current source tree contains a file
 * newer than the newest file it saw when it started — i.e. something changed
 * on disk after that server process came up.
 */
export function isFingerprintStale(
  fingerprint: PlaygroundFreshnessFingerprint,
  currentNewestSourceMtimeMs: number | null,
): boolean {
  if (currentNewestSourceMtimeMs === null) return false;
  if (fingerprint.newestSourceMtimeMs === null) return true;
  return currentNewestSourceMtimeMs > fingerprint.newestSourceMtimeMs;
}
