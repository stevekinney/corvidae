import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { filesCoverPath, loadPackageSurface } from './package-surface.ts';
import { additionalSourceRoots, isSourceFile, sourceTree, versionConstants } from './source.ts';

/**
 * A corvidae-side fingerprint of one published workspace's shipped source, and the guard that
 * compares it against what `package-map.json` last recorded.
 *
 * `manifests.ts`'s `publishedRangeFor` renders a dependency that ships from another target as
 * `^lastPublishedVersion`, a range npm resolves against whatever is actually on the registry. That
 * range says nothing about whether corvidae's *current* source for that dependency still matches
 * what was published: `@lostgradient/chat` depends on `conversationalist`, and corvidae's
 * `conversationalist` gained `appendStreamingMessage` after `1.2.0` was published, so the range is
 * technically satisfiable while resolving to a tarball missing the export chat now imports. Nothing
 * catches that until a consumer install fails downstream. This gives `publishedRangeFor` a fact to
 * check instead: a digest of corvidae's source for the dependency, computed fresh every time an
 * edge to it is resolved, compared against the digest `record-source-digest.ts` last recorded
 * alongside that publish.
 *
 * This module owns the digest's scope and the comparison; `manifests.ts` only computes one digest
 * per published workspace up front (`planManifests`'s `currentDigests`, since digesting requires
 * file I/O and the manifest-rewrite call chain below `publishedRangeFor` is synchronous) and calls
 * `assertEdgeNotStale` with what it already has.
 */

export class SourceDigestError extends Error {}

/** Refusal to resolve a cross-target edge whose dependency's source is not provably the published one. */
export class StaleCrossTargetEdgeError extends SourceDigestError {}

export interface DigestScope {
  corvidaeRoot: string;
  /** Corvidae-relative directory of the workspace being digested. */
  corvidaeDirectory: string;
  /** The `@lostgradient/*` (or unscoped) workspace name, used to look up `additionalSourceRoots`. */
  workspace: string;
}

export interface DigestedFile {
  /** Path relative to the workspace directory — the same shape the emitted plan itself uses. */
  path: string;
  bytes: Uint8Array;
}

/**
 * Name fragments a source file must not contain anywhere in its path to count toward the digest.
 *
 * The same shape `package-surface.json`'s `files` arrays already negate before publishing:
 * `!dist/**\/*.test.*`, `!dist/**\/*.fixture.*`, `!dist/**\/test/**`, and the two plural spellings a
 * handful of packages use. Applied here against `src/` paths rather than `dist/` ones — the digest
 * has no build output to filter — on the premise that a test file's own name is a reliable signal
 * independent of which directory it sits under, and that a package with no `files` array of its own
 * (a private workspace) still deserves the same test/fixture exclusion, since one is not otherwise
 * defined for it. Erring toward inclusion where a path is ambiguous: a test file wrongly counted
 * only makes the digest change on a commit that would not have moved the tarball, which is a false
 * refusal an edge can retry past; a shipped file wrongly excluded is a real edge this guard would
 * wave through, which is the failure this whole mechanism exists to prevent.
 */
const excludedFragments = [
  '.test.',
  '.fixture.',
  '-fixture.',
  '-fixtures.',
  '__fixtures__/',
  '/test/',
  '/tests/',
] as const;

/** Whether a `src/`-relative path is a test or fixture file the tarball never ships. */
export function isDigestExcluded(path: string): boolean {
  return excludedFragments.some((fragment) => path.includes(fragment));
}

const skippedDirectories: readonly string[] = ['node_modules'];

/** Every `src/`-relative source file under one workspace, sorted, minus tests and fixtures. */
async function collectSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isSourceFile(entry.name)) continue;
    const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (path.split('/').some((segment) => skippedDirectories.includes(segment))) continue;
    if (isDigestExcluded(path)) continue;
    files.push(path);
  }
  return files.toSorted();
}

/** The one declared path this digest never counts, regardless of `additionalSourceRoots`. */
const excludedDeclaredPath = 'README.md';

/**
 * Whether `path` (workspace-relative) is something the workspace's own `package-surface.json`
 * entry actually publishes, for filtering a declared `additionalSourceRoots` path down to the
 * ones that ship.
 *
 * Two cases read as "cannot tell, so do not filter it out": no recorded surface at all (a private
 * workspace never has one, and this module runs for those too) and a generator-resolved `files`
 * array (only `@lostgradient/cinder` uses one today, which `resolveSurface` cannot compute without
 * discovered components — machinery this module has no reason to pull in for a case no current
 * cross-target dependency hits). Both fall through to "include it": a declared path wrongly kept
 * only makes the digest sensitive to a file that never actually ships, which is a false refusal on
 * an edit nobody would call staleness; a shipped path wrongly dropped is the failure this whole
 * mechanism exists to prevent.
 */
async function isPublishedByPackageSurface(workspace: string, path: string): Promise<boolean> {
  const surface = await loadPackageSurface();
  const entry = surface.packages[workspace];
  if (entry === undefined) return true;
  if (!Array.isArray(entry.files)) return true;
  return filesCoverPath(entry.files, path);
}

/**
 * Every file that goes into one workspace's digest: its `src/` tree (minus tests and fixtures),
 * plus whichever of its declared `additionalSourceRoots` entries actually ship, minus the two
 * exclusions below — the same shape `source.ts`'s `readSourceTree` and `readAdditionalSourceRoots`
 * emit as a package's actual shipped source, narrowed to what changes what a consumer gets.
 *
 * `README.md` is excluded unconditionally, even when a workspace declares it (`@lostgradient/weft`
 * does) — it is documentation, not code a consumer imports, and including it made an unrelated
 * docs edit refuse every cross-target edge to a package that had not actually changed (COR-1196
 * round 11). `LICENSE` was never a candidate here: it is fanned out from corvidae's repository
 * root by `manifests.ts`, not declared per workspace, so it was never part of this walk.
 *
 * The path `versionConstants` names for this workspace, when it declares one, is excluded too —
 * `applyVersionConstants` rewrites that file's version literal to the *target's* composed manifest
 * version before anything publishes, the one deliberate, already-documented difference between
 * corvidae's own copy and what ships (`source.test.ts`'s "the committed workspaces" describe block
 * carves out exactly this exception when comparing emitted bytes against disk). Hashing corvidae's
 * unrewritten literal would make every publish look like a content change, which it is not.
 *
 * A declared path that is not actually published — `@lostgradient/weft`'s four `documentation/*.md`
 * entries, declared only because `src/worker/protocol.test.ts` reads them by literal path, and
 * absent from weft's `files: ["dist", "README.md", "LICENSE"]` — is filtered out by
 * `isPublishedByPackageSurface`, for the same reason `README.md` is: it is real, but it is not
 * source a consumer's install ships, so a change to it is not the staleness this guard checks for.
 */
export async function collectDigestedFiles({
  corvidaeRoot,
  corvidaeDirectory,
  workspace,
}: DigestScope): Promise<DigestedFile[]> {
  const workspaceRoot = join(corvidaeRoot, corvidaeDirectory);
  const files: DigestedFile[] = [];
  const excludedPath = versionConstants[workspace];

  const sourceRoot = join(workspaceRoot, sourceTree);
  for (const path of await collectSourceFiles(sourceRoot)) {
    const relativePath = `${sourceTree}/${path}`;
    if (relativePath === excludedPath) continue;
    const bytes = new Uint8Array(await Bun.file(join(sourceRoot, path)).arrayBuffer());
    files.push({ path: relativePath, bytes });
  }

  for (const declared of additionalSourceRoots[workspace] ?? []) {
    for (const path of declared.paths) {
      if (path === excludedDeclaredPath || path === excludedPath) continue;
      if (!(await isPublishedByPackageSurface(workspace, path))) continue;
      const absolute = join(workspaceRoot, path);
      const file = Bun.file(absolute);
      if (!(await file.exists())) continue;
      files.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

/**
 * Hash a digested file set into one hex digest.
 *
 * Sorted first (callers already hand this sorted output from `collectDigestedFiles`, but a
 * direct caller — a test, `record-source-digest.ts`'s registry comparison — must not have to
 * remember to) so the hash is independent of enumeration order, which `readdir` does not
 * guarantee across platforms. Each file contributes its path and its length before its bytes,
 * both null-terminated, so that renaming a file with unchanged content changes the digest (a
 * rename is a real source change, since it changes what the target's tree looks like) and so that
 * two files whose concatenated bytes could otherwise collide at a boundary cannot produce the same
 * digest as a different split of the same total bytes.
 */
export function hashDigestedFiles(files: readonly DigestedFile[]): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const file of files.toSorted((left, right) => left.path.localeCompare(right.path))) {
    hasher.update(`${file.path}\0${file.bytes.byteLength}\0`);
    hasher.update(file.bytes);
  }
  return hasher.digest('hex');
}

/** The digest of one workspace's current published source, as corvidae's tree stands right now. */
export async function computeSourceDigest(scope: DigestScope): Promise<string> {
  return hashDigestedFiles(await collectDigestedFiles(scope));
}

export interface EdgeStalenessCheck {
  /** The dependency's corvidae workspace name, for the message. */
  workspace: string;
  /** The dependency's public npm name. */
  publicName: string;
  /** `package-map.json`'s `lastPublishedVersion` for the dependency. */
  version: string;
  /** `package-map.json`'s recorded `sourceDigest` for the dependency, or `undefined` if none. */
  recordedDigest: string | undefined;
  /** The dependency's digest computed fresh from corvidae's current tree. */
  currentDigest: string;
}

/**
 * Refuse a cross-target edge whose dependency has no recorded digest, or whose recorded digest no
 * longer matches corvidae's current source for it.
 *
 * Refusal, not a warning, in both cases. Every other guard in this transform —
 * `TargetOwnedViolation`, `RetirementError`, `ManifestTransformError` itself — fails the plan
 * rather than logging past the problem, and a warning here would be the one guard in the whole
 * pipeline a sync can silently ignore. Refusing a *missing* digest specifically (rather than
 * treating "never recorded" as "assume it still matches") is the conservative default the owner's
 * ruling calls for: a cross-target edge is only trustworthy once something has actually verified
 * corvidae's source against what got published, and nothing has verified it until
 * `record-source-digest.ts` runs. Every edge in the live graph is unrecorded as of this change (see
 * `source-digest.test.ts`'s enumeration), so this refuses all of them until each is recorded once —
 * a one-time cost, paid by running the record command per dependency after confirming its last
 * publish matches corvidae's source, not a standing tax on every sync afterward.
 */
export function assertEdgeNotStale({
  workspace,
  publicName,
  version,
  recordedDigest,
  currentDigest,
}: EdgeStalenessCheck): void {
  if (recordedDigest === undefined) {
    throw new StaleCrossTargetEdgeError(
      `${workspace}: package-map.json has no recorded sourceDigest for ${publicName}, so the edge to it cannot be trusted. Publish ${publicName} from its own target (or confirm ${publicName}@${version} already matches corvidae's current source), then record its digest with \`bun scripts/mirror/record-source-digest.ts --workspace ${workspace}\`.`,
    );
  }
  if (recordedDigest !== currentDigest) {
    throw new StaleCrossTargetEdgeError(
      `${workspace}: corvidae's source for ${publicName} has changed since ${publicName}@${version} was published (recorded digest ${recordedDigest}, current ${currentDigest}). Publish ${publicName} from its own target first, then record the new digest with \`bun scripts/mirror/record-source-digest.ts --workspace ${workspace}\`.`,
    );
  }
}
