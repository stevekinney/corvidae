import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { targetDirectoryFor } from './layout-map.ts';
import { packagePayloadAlgorithm, type PackagePayloadContract } from './package-payload.ts';
import { canonicalManifest, objectRecord } from './registry-manifest.ts';
import { publishedVersionRange, targetFor } from './target-definitions.ts';

import { filesCoverPath, loadPackageSurface } from './package-surface.ts';
import { additionalSourceRoots, isSourceFile, sourceTree, versionConstants } from './source.ts';
import { planTypeScriptConfiguration } from './typescript-configuration.ts';

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

export const publicationSnapshotSchemaVersion = 1 as const;
export const publicationContractAlgorithm = 'sha256-json-v1' as const;

export interface PublicationInputContract {
  algorithm: typeof publicationContractAlgorithm;
  digest: string;
}

export interface PublishedSnapshot {
  schemaVersion: typeof publicationSnapshotSchemaVersion;
  version: string;
  gitHead: string;
  corvidaeCommit: string;
  source: { algorithm: 'sha256-files-v1'; paths: string[]; digest: string };
  publicationInputContract: PublicationInputContract;
  registryManifestContract: PublicationInputContract;
  registryPayloadContract: PackagePayloadContract;
}

export interface DigestScope {
  corvidaeRoot: string;
  /** Corvidae-relative directory of the workspace being digested. */
  corvidaeDirectory: string;
  /** The `@lostgradient/*` (or unscoped) workspace name, used to look up `additionalSourceRoots`. */
  workspace: string;
  /** Explicit historical declarations when the checkout predates its own collector. */
  policy?: DigestPolicy;
}

export interface DigestPolicy {
  sourceTree: string;
  isSourceFile: (name: string) => boolean;
  versionConstant?: string;
  additionalPaths: readonly string[];
  files?: readonly string[];
}

export interface DigestedFile {
  /** Path relative to the workspace directory — the same shape the emitted plan itself uses. */
  path: string;
  bytes: Uint8Array;
}

/** Test modules are excluded; fixture names and test directories can be public runtime inputs. */
export function isDigestExcluded(path: string): boolean {
  return path.includes('.test.');
}

const skippedDirectories: readonly string[] = ['node_modules'];

/** Every `src/`-relative source file under one workspace, sorted, minus test modules. */
async function collectSourceFiles(
  root: string,
  accepts: (name: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!accepts(entry.name)) continue;
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
 * Every file that goes into one workspace's digest: its `src/` tree (minus test modules),
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
  policy,
}: DigestScope): Promise<DigestedFile[]> {
  const workspaceRoot = join(corvidaeRoot, corvidaeDirectory);
  const files: DigestedFile[] = [];
  const excludedPath = policy ? policy.versionConstant : versionConstants[workspace];
  const selectedSourceTree = policy?.sourceTree ?? sourceTree;

  const sourceRoot = join(workspaceRoot, selectedSourceTree);
  for (const path of await collectSourceFiles(sourceRoot, policy?.isSourceFile ?? isSourceFile)) {
    const relativePath = `${selectedSourceTree}/${path}`;
    if (relativePath === excludedPath) continue;
    const bytes = new Uint8Array(await Bun.file(join(sourceRoot, path)).arrayBuffer());
    files.push({ path: relativePath, bytes });
  }

  const additionalPaths =
    policy?.additionalPaths ??
    (additionalSourceRoots[workspace] ?? []).flatMap((entry) => entry.paths);
  for (const path of additionalPaths) {
    if (path === excludedDeclaredPath || path === excludedPath) continue;
    if (
      policy
        ? policy.files !== undefined && !filesCoverPath(policy.files, path)
        : !(await isPublishedByPackageSurface(workspace, path))
    )
      continue;
    const absolute = join(workspaceRoot, path);
    const file = Bun.file(absolute);
    if (!(await file.exists())) continue;
    files.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
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

const publicationManifestFields = [
  'type',
  'imports',
  'browser',
  'main',
  'module',
  'types',
  'bin',
  'sideEffects',
  'engines',
  'peerDependencies',
  'peerDependenciesMeta',
] as const;

/** Hash source-owned inputs; target-owned versions and unrelated catalog entries are excluded. */
export async function publicationInputContract({
  corvidaeRoot,
  corvidaeDirectory,
  workspace,
  publishedWorkspaceVersions,
}: DigestScope & {
  /** Historical target versions proven at the registry's publishing commit. */
  publishedWorkspaceVersions?: ReadonlyMap<string, string>;
}): Promise<PublicationInputContract> {
  const packageRoot = join(corvidaeRoot, corvidaeDirectory);
  const manifest = objectRecord(await Bun.file(join(packageRoot, 'package.json')).json());
  const root = objectRecord(await Bun.file(join(corvidaeRoot, 'package.json')).json());
  const map = objectRecord(
    objectRecord(await Bun.file(join(corvidaeRoot, 'scripts/mirror/package-map.json')).json())[
      'workspaces'
    ],
  );
  const resolveDependencies = (block: unknown): Record<string, string> =>
    Object.fromEntries(
      Object.entries(objectRecord(block)).map(([name, input]) => {
        if (typeof input !== 'string')
          throw new SourceDigestError(`${name}: invalid dependency range`);
        let range = input;
        if (range.startsWith('catalog:')) {
          const catalogName = range.slice('catalog:'.length);
          const catalog = catalogName
            ? objectRecord(root['catalogs'])[catalogName]
            : root['catalog'];
          const resolvedRange = objectRecord(catalog)[name];
          if (typeof resolvedRange !== 'string')
            throw new SourceDigestError(`${name}: root catalog does not declare it`);
          range = resolvedRange;
        }
        const disposition = map[name] === undefined ? undefined : objectRecord(map[name]);
        if (range.startsWith('workspace:')) {
          const publicName = disposition?.['name'];
          const version =
            (typeof publicName === 'string'
              ? publishedWorkspaceVersions?.get(publicName)
              : undefined) ?? disposition?.['lastPublishedVersion'];
          if (disposition?.['disposition'] !== 'publish-as' || typeof version !== 'string')
            throw new SourceDigestError(`${name}: no recorded published version`);
          range = publishedVersionRange(version, targetFor(workspace) !== targetFor(name));
        }
        const publicName =
          disposition?.['disposition'] === 'publish-as' ? disposition['name'] : name;
        if (typeof publicName !== 'string')
          throw new SourceDigestError(`${name}: missing public package name`);
        return [publicName, range];
      }),
    );
  const runtimeDependencies: Record<string, unknown> = {};
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (manifest[field] !== undefined)
      runtimeDependencies[field] = resolveDependencies(manifest[field]);
  }
  const manifestFields = Object.fromEntries(
    publicationManifestFields
      .filter((field) => field in manifest)
      .map((field) => [field, manifest[field]]),
  );
  const surface = await loadPackageSurface(
    join(corvidaeRoot, 'scripts/mirror/package-surface.json'),
  );
  const entry = surface.packages[workspace];
  if (!entry) throw new SourceDigestError(`${workspace}: no declared publication surface`);
  let resolved = entry;
  if (!Array.isArray(entry.files) || 'generator' in entry.exports) {
    const resolver: typeof import('./package-surface.ts') = await import(
      pathToFileURL(join(corvidaeRoot, 'scripts/mirror/package-surface.ts')).href
    );
    const discovery: typeof import('../../components/cinder/scripts/lib/discover-components.ts') =
      await import(pathToFileURL(join(packageRoot, 'scripts/lib/discover-components.ts')).href);
    resolved = {
      ...entry,
      ...resolver.resolveSurface({
        entry,
        packageRoot,
        components: await discovery.discoverComponents(),
      }),
    };
  }
  const targetDirectory = await targetDirectoryFor(workspace);
  const typeScriptPlan = await planTypeScriptConfiguration({
    corvidaeRoot,
    target: targetFor(workspace),
    workspaces: [{ corvidaeDirectory, targetDirectory }],
  });
  const payload = {
    manifestFields,
    runtimeDependencies,
    publicSurface: {
      publicName: resolved.publicName,
      exports: resolved.exports,
      files: resolved.files,
      peerDependencies: resolved.peerDependencies,
      sideEffects: resolved.sideEffects,
      bin: resolved.bin,
      manifestFields: resolved.manifestFields,
      build: { ...resolved.build, toolchain: resolveDependencies(resolved.build.toolchain) },
    },
    typeScriptConfiguration: Object.fromEntries(
      Object.entries(typeScriptPlan.files).toSorted(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  };
  return {
    algorithm: publicationContractAlgorithm,
    digest: new Bun.CryptoHasher('sha256')
      .update(JSON.stringify(canonicalManifest(payload)))
      .digest('hex'),
  };
}

export interface EdgeStalenessCheck {
  /** The dependency's corvidae workspace name, for the message. */
  workspace: string;
  /** The dependency's public npm name. */
  publicName: string;
  /** `package-map.json`'s `lastPublishedVersion` for the dependency. */
  version: string;
  snapshot: PublishedSnapshot | undefined;
  /** The dependency's digest computed fresh from corvidae's current tree. */
  currentDigest: string;
  currentPaths: readonly string[];
  currentPublicationInputDigest: string;
}

/** Refuse edges unless the published version, historical source, and publication inputs match. */
export function assertEdgeNotStale({
  workspace,
  publicName,
  version,
  snapshot,
  currentDigest,
  currentPaths,
  currentPublicationInputDigest,
}: EdgeStalenessCheck): void {
  if (snapshot === undefined) {
    throw new StaleCrossTargetEdgeError(
      `${workspace}: package-map.json has no publishedSnapshot for ${publicName}@${version}, so the edge to it cannot be trusted. Record its publication snapshot with \`bun scripts/mirror/record-source-digest.ts --workspace ${workspace} --target-clone /path/to/target --published-source-root /path/to/checkout --mirror-commit <verified-sync-sha>\`.`,
    );
  }
  if (snapshot.schemaVersion !== publicationSnapshotSchemaVersion || snapshot.version !== version) {
    throw new StaleCrossTargetEdgeError(`${workspace}: publishedSnapshot version is unsupported`);
  }
  if (
    snapshot.registryPayloadContract?.algorithm !== packagePayloadAlgorithm ||
    !/^[a-f0-9]{64}$/.test(snapshot.registryPayloadContract.digest) ||
    !Array.isArray(snapshot.registryPayloadContract.files)
  ) {
    throw new StaleCrossTargetEdgeError(
      `${workspace}: publishedSnapshot has no verified registry payload contract`,
    );
  }
  if (
    snapshot.source.digest !== currentDigest ||
    JSON.stringify(snapshot.source.paths) !== JSON.stringify(currentPaths)
  ) {
    throw new StaleCrossTargetEdgeError(
      `${workspace}: corvidae's source for ${publicName} has changed since ${publicName}@${version} was published (recorded digest ${snapshot.source.digest}, current ${currentDigest}). Publish ${publicName} from its own target first, then record a new publishedSnapshot before using this edge.`,
    );
  }
  if (snapshot.publicationInputContract.digest !== currentPublicationInputDigest) {
    throw new StaleCrossTargetEdgeError(
      `${workspace}: publication inputs for ${publicName}@${version} changed since the snapshot was recorded. Record a new publishedSnapshot before using this edge.`,
    );
  }
}
