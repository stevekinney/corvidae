import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeJson } from './json-formatting.ts';
import {
  DeferredWorkspaceError,
  layoutFor,
  type DeferredLayout,
  type WorkspaceLayout,
} from './layout-map.ts';
import { dispositionFor, type PackageMap, type WorkspaceDisposition } from './package-map.ts';
import { childProcessEnvironment } from './packaging.ts';
import {
  assertEdgeNotStale,
  collectDigestedFiles,
  hashDigestedFiles,
  publicationInputContract,
} from './source-digest.ts';
import type { EmittedWorkspace } from './source.ts';
import {
  keysFor,
  loadTargetOwnedPolicy,
  writeTransformOutput,
  type TargetOwnedPolicy,
} from './target-owned.ts';

/**
 * Manifest half of the mirror transform: corvidae's committed manifests in, a public target's
 * manifests out.
 *
 * Corvidae deliberately lacks four things every published package needs — a version, a build, a
 * distributable `exports` map and a `files` allowlist. This module produces the first and leaves
 * the other three to COR-1189: `exports` and `files` are carried through untouched, and no build
 * pipeline is emitted.
 *
 * The rewrites, all of which are forced by the fact that the target is a different repository:
 *
 * - Every `@lostgradient/*` name becomes the public name `package-map.json` assigns it, in the
 *   workspace's own `name` and in every internal dependency specifier.
 * - `workspace:*` survives only while both ends ship in the same target. An edge crossing targets
 *   has to become a published range, because the other end is a registry dependency downstream.
 * - `catalog:` survives only in a target that has a workspace root to hold a catalog. The weft
 *   target is a single package, so its specifiers are inlined to concrete ranges.
 * - `private: true` is stripped from anything the map publishes and kept on everything else.
 * - Every emitted package directory gets the root `LICENSE`, per COR-1183's ruling that
 *   per-package `LICENSE` is transform-owned while the root one is target-owned.
 * - Every emitted path is the target's own directory for that workspace, read from
 *   `layout-map.json`. Corvidae's `components/chat` is cinder's `packages/chat`, so reusing
 *   corvidae's directory would write a second tree beside the target's real one.
 *
 * None of that applies to a key the target already has an answer for. `composeManifest` is the
 * rule for those, and COR-1223 inverted it: for a manifest the target already carries, the
 * target's own copy is the base and only `target-owned.json`'s `insideFiles` keys are overlaid
 * onto it. Versions were always handled this way; twenty-six scripts, thirteen devDependencies,
 * every piece of package metadata and the classification of seven storage drivers were not, and a
 * live dry run failed twelve of the weft repository's twenty checks because of it.
 */

export type MirrorTarget = 'weft' | 'cinder' | 'agent-bureau';

/** Raised when a manifest cannot be rewritten without inventing a fact the map does not carry. */
export class ManifestTransformError extends Error {}

/** The workspace directories corvidae declares, in the order its root manifest lists them. */
const workspaceDirectories = ['applications', 'components', 'packages', 'internal'] as const;

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/**
 * The blocks whose intra-target edges order a target's verification (COR-1289).
 *
 * A published package's `typecheck` resolves an edge to another package in the same target through
 * that package's `exports`, which point at `dist/` — so the dependency has to have been built
 * first. These three blocks are the ones that say "this package's published surface needs that
 * one": `dependencies` and `optionalDependencies` are installed alongside it, and a
 * `peerDependencies` entry is still a name the consumer's own source imports and its declaration
 * files name.
 *
 * `devDependencies` is deliberately absent, and its absence is load-bearing rather than an
 * oversight. A development edge does not participate in the published type surface, so ordering
 * does not need it; including it would additionally manufacture cycles out of test-only back-edges
 * — a package depending on a fixture or harness workspace that itself depends on the package under
 * test is an ordinary and legal arrangement that no build order could satisfy, and
 * `verify-steps.ts`'s cycle refusal would reject the whole plan over it.
 */
const publishedEdgeFields = new Set<(typeof dependencyFields)[number]>([
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
]);

/**
 * Per-target facts that are not in `package-map.json`, which rules on what a workspace *becomes*
 * rather than on which repository it lands in.
 *
 * `rootName` and `workspaces` are read off the targets as they exist today (`weft-monorepo` with
 * `packages/*`, `cinder-workspace` with its explicit list, `agent-bureau` with `packages/*`)
 * rather than invented, so a sync does not rewrite a key that was already correct. `catalog`
 * records whether the target has a workspace root able to hold one: `agent-bureau`'s root declares
 * `workspaces` but no `catalog`, so its specifiers inline to concrete ranges the way weft's do.
 *
 * `members` is exhaustive as of COR-1287. It used to be a single list — weft's — with every other
 * workspace falling through to cinder, which was correct while there were two targets and stopped
 * being correct the moment a third one claimed ten of the workspaces that fell through. Every
 * non-excluded workspace in `package-map.json` is now named by exactly one list, enforced by
 * `manifests.test.ts` against the map rather than left to this comment.
 */
const targetDefinitions = {
  weft: {
    rootName: 'weft-monorepo',
    workspaces: ['packages/*'],
    catalog: false,
    /** The weft target is a single-package repository; every other workspace ships elsewhere. */
    members: ['@lostgradient/weft'],
  },
  cinder: {
    rootName: 'cinder-workspace',
    workspaces: workspaceDirectories.map((directory) => `${directory}/*`),
    catalog: true,
    members: [
      '@lostgradient/cinder',
      '@lostgradient/chat',
      '@lostgradient/editor',
      '@lostgradient/markdown',
      '@lostgradient/weft-ui',
      '@lostgradient/testing',
      '@lostgradient/typescript',
    ],
  },
  'agent-bureau': {
    rootName: 'agent-bureau',
    workspaces: ['packages/*'],
    catalog: false,
    members: [
      '@lostgradient/operative',
      'armorer',
      'conversationalist',
      '@lostgradient/cryptography',
      '@lostgradient/embeddings',
      '@lostgradient/tool-protocol',
      '@lostgradient/lifecycle',
      '@lostgradient/bureau',
      '@lostgradient/memory',
      '@lostgradient/skills',
    ],
  },
} as const satisfies Record<
  MirrorTarget,
  {
    rootName: string;
    workspaces: readonly string[];
    catalog: boolean;
    members: readonly string[];
  }
>;

export const mirrorTargets = Object.keys(targetDefinitions) as readonly MirrorTarget[];

/**
 * Which target a workspace ships from.
 *
 * Throws rather than defaulting. A default was what made the two-target version read cleanly, and
 * it is exactly what a third target cannot have: an unlisted workspace silently joining whichever
 * target held the fallback is a package published from the wrong repository, which no downstream
 * check would notice. Every caller here filters `exclude` first, so a workspace reaching this
 * function is one the mirror emits and therefore one that must have a home.
 */
export function targetFor(workspace: string): MirrorTarget {
  for (const target of mirrorTargets) {
    if ((targetDefinitions[target].members as readonly string[]).includes(workspace)) return target;
  }
  throw new ManifestTransformError(
    `${workspace} is not a member of any mirror target; add it to one of targetDefinitions' member lists or exclude it in package-map.json`,
  );
}

/**
 * Whether the target's root can hold a Bun catalog, which decides whether a `catalog:` specifier
 * survives into it or is inlined to the concrete range corvidae's root catalog declares.
 *
 * Exported because `surface.ts` asks the same question about the toolchain dependencies it adds
 * and used to answer it with its own `options.target === 'cinder'`. Two literals, one fact: a
 * third target made the copy wrong rather than merely duplicated.
 */
export function targetHasCatalog(target: MirrorTarget): boolean {
  return targetDefinitions[target].catalog;
}

/** The member workspaces of one target, for the map-coverage test rather than for the transform. */
export function membersOf(target: MirrorTarget): readonly string[] {
  return targetDefinitions[target].members;
}

type JsonObject = Record<string, unknown>;

export interface DiscoveredWorkspace {
  /** The `@lostgradient/*` name, read from the manifest rather than inferred from the directory. */
  name: string;
  /** Corvidae-relative directory, which the transform reuses as the target-relative directory. */
  directory: string;
  manifest: JsonObject;
}

/** Every workspace on disk, with its manifest, in a stable order. */
export async function discoverWorkspaces(root: string): Promise<DiscoveredWorkspace[]> {
  const discovered: DiscoveredWorkspace[] = [];
  for (const parent of workspaceDirectories) {
    // A target reads a corvidae checkout, which may legitimately lack one of these directories.
    const entries = await readdir(join(root, parent), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const directory = `${parent}/${entry.name}`;
      const manifest = Bun.file(join(root, directory, 'package.json'));
      if (!(await manifest.exists())) continue;
      const parsed = (await manifest.json()) as JsonObject;
      const name = parsed['name'];
      if (typeof name !== 'string' || name.length === 0) {
        throw new ManifestTransformError(`${directory}/package.json has no name`);
      }
      discovered.push({ name, directory, manifest: parsed });
    }
  }
  return discovered;
}

/**
 * The public name a workspace carries downstream.
 *
 * `publish-as` entries name themselves. `private-workspace` entries do not, because
 * `package-map.json` only records a name for something that reaches the registry — but since
 * COR-1284 every workspace's manifest `name` already equals its public name (`@lostgradient/*`,
 * or the unscoped `armorer`/`conversationalist`), so a private workspace's public name is simply
 * its own name, carried through unchanged. `private: true` is preserved alongside it by the
 * caller, so the name is never published.
 */
export function publicNameFor(workspace: string, disposition: WorkspaceDisposition): string {
  if (disposition.disposition === 'publish-as') return disposition.name;
  if (disposition.disposition === 'exclude') {
    throw new ManifestTransformError(
      `${workspace} is excluded from the mirror and has no public name`,
    );
  }
  return workspace;
}

/**
 * The published range a cross-target edge resolves to, which only a published package has.
 *
 * Refuses via `assertEdgeNotStale` (source-digest.ts) before handing back a range: `^lastPublishedVersion`
 * alone says the edge is *resolvable*, not that it is *current* — the dependency's published
 * source and corvidae's own copy of it can diverge, and nothing else in this file would notice.
 * `context.currentDigests` is populated once per `planManifests` call, before this can run, because
 * digesting is file I/O and everything between here and `rewriteWorkspaceManifest` is synchronous.
 */
function publishedRangeFor(
  workspace: string,
  disposition: WorkspaceDisposition,
  context: RewriteContext,
): string {
  if (disposition.disposition !== 'publish-as') {
    throw new ManifestTransformError(`${workspace} is not published, so it has no range`);
  }
  if (disposition.lastPublishedVersion === null) {
    throw new ManifestTransformError(
      `${workspace} ships from a different target but has never been published, so an edge to it cannot be expressed as a range; publish it first or move it into the same target`,
    );
  }
  const currentDigest = context.currentDigests.get(workspace);
  if (currentDigest === undefined) {
    throw new ManifestTransformError(
      `${workspace}: no source digest was computed for it before resolving cross-target edges. This is an internal error in planManifests, which must digest every publish-as workspace before rewriting any dependency block.`,
    );
  }
  assertEdgeNotStale({
    workspace,
    publicName: disposition.name,
    version: disposition.lastPublishedVersion,
    snapshot: disposition.publishedSnapshot,
    currentDigest,
    currentPaths: context.currentSourcePaths.get(workspace) ?? [],
    currentPublicationInputDigest: context.currentPublicationInputs.get(workspace) ?? '',
  });
  return `^${disposition.lastPublishedVersion}`;
}

interface RewriteContext {
  target: MirrorTarget;
  /** Corvidae's root catalog, used to inline specifiers in a target that cannot hold one. */
  catalog: Readonly<Record<string, string>>;
  /** Public names, keyed by corvidae name, for every workspace on disk. */
  publicNames: ReadonlyMap<string, string>;
  dispositions: ReadonlyMap<string, WorkspaceDisposition>;
  /**
   * Every publish-as workspace's current source digest, keyed by corvidae name and computed once
   * before the rewrite loop starts (source-digest.ts). `publishedRangeFor` reads from this rather
   * than digesting on demand because it is called from a synchronous rewrite chain.
   */
  currentDigests: ReadonlyMap<string, string>;
  currentSourcePaths: ReadonlyMap<string, readonly string[]>;
  currentPublicationInputs: ReadonlyMap<string, string>;
  /** Catalog entries this target must declare, accumulated as cross-target edges are resolved. */
  requiredCatalog: Map<string, string>;
  /** Edges dropped because the other end does not exist downstream, reported rather than silent. */
  dropped: string[];
  /**
   * COR-1289: every edge that stays `workspace:*` because both ends ship in this target, keyed by
   * the consumer's corvidae name and holding the dependency's public name. Recorded here, at the
   * one place the transform decides an edge is intra-target, rather than recovered by parsing the
   * emitted manifests a second time — a second parse would be a second opinion about which
   * specifiers are mirror-internal, and this one is already authoritative.
   */
  intraTargetEdges: Map<string, Set<string>>;
}

/** Resolve one internal `@lostgradient/*` edge, or `undefined` when the edge cannot be carried. */
function resolveInternalEdge(
  consumer: string,
  dependency: string,
  field: (typeof dependencyFields)[number],
  context: RewriteContext,
): [string, string] | undefined {
  const disposition = context.dispositions.get(dependency);
  if (!disposition) {
    throw new ManifestTransformError(
      `${consumer} depends on ${dependency}, which is not a workspace in this tree`,
    );
  }
  if (disposition.disposition === 'exclude') {
    throw new ManifestTransformError(
      `${consumer} depends on ${dependency}, which package-map.json excludes from the mirror`,
    );
  }
  const publicName = publicNameFor(dependency, disposition);
  if (targetFor(dependency) === context.target) {
    if (publishedEdgeFields.has(field)) {
      let edges = context.intraTargetEdges.get(consumer);
      if (!edges) {
        edges = new Set<string>();
        context.intraTargetEdges.set(consumer, edges);
      }
      edges.add(publicName);
    }
    return [publicName, 'workspace:*'];
  }

  if (disposition.disposition === 'private-workspace') {
    // A private workspace has no registry presence, so an edge to one cannot cross repositories.
    // Dropping is only safe where the edge is development-only in both senses: the map says the
    // workspace is tooling, and the consumer declares it as tooling. Anything an installed
    // package would need at runtime has to fail instead. COR-1189 vendors `@lostgradient/typescript`
    // into the weft target to replace the one edge this removes today.
    if (disposition.basis !== 'development-only' || field !== 'devDependencies') {
      throw new ManifestTransformError(
        `${consumer} lists ${dependency} under ${field}, but ${dependency} ships from the ${targetFor(dependency)} target and is never published; only a devDependencies edge to development-only tooling can be dropped`,
      );
    }
    context.dropped.push(`${consumer} -> ${dependency}`);
    return undefined;
  }

  const range = publishedRangeFor(dependency, disposition, context);
  if (!targetDefinitions[context.target].catalog) return [publicName, range];
  context.requiredCatalog.set(publicName, range);
  return [publicName, 'catalog:'];
}

/** Resolve one external specifier, inlining `catalog:` where the target cannot hold a catalog. */
function resolveExternalEdge(
  consumer: string,
  dependency: string,
  specifier: string,
  context: RewriteContext,
): string {
  if (!specifier.startsWith('catalog:')) return specifier;
  if (specifier !== 'catalog:') {
    throw new ManifestTransformError(
      `${consumer} references named catalog "${specifier}" for ${dependency}; corvidae declares only the default catalog`,
    );
  }
  if (targetDefinitions[context.target].catalog) return specifier;
  const range = context.catalog[dependency];
  if (range === undefined) {
    throw new ManifestTransformError(
      `${consumer} references ${dependency} from the catalog, but corvidae's root catalog does not declare it`,
    );
  }
  return range;
}

function rewriteDependencyBlock(
  consumer: string,
  field: (typeof dependencyFields)[number],
  block: Readonly<Record<string, string>>,
  context: RewriteContext,
): Record<string, string> {
  const rewritten: Record<string, string> = {};
  for (const [dependency, specifier] of Object.entries(block)) {
    if (context.publicNames.has(dependency)) {
      const edge = resolveInternalEdge(consumer, dependency, field, context);
      if (edge) rewritten[edge[0]] = edge[1];
      continue;
    }
    rewritten[dependency] = resolveExternalEdge(consumer, dependency, specifier, context);
  }
  return rewritten;
}

function rewriteWorkspaceManifest(
  workspace: DiscoveredWorkspace,
  disposition: WorkspaceDisposition,
  context: RewriteContext,
): JsonObject {
  const emitted: JsonObject = { ...workspace.manifest };
  emitted['name'] = publicNameFor(workspace.name, disposition);
  if (disposition.disposition === 'publish-as') {
    delete emitted['private'];
  } else {
    emitted['private'] = true;
  }
  // Seeds a first publish. `composeManifest` replaces this with the target's own version whenever
  // the target already carries one, so it only survives where nothing has been released. COR-1229:
  // the planning loop below overwrites this again, to `package-map.json`'s `lastPublishedVersion`,
  // for a workspace the target has no manifest for but the registry already carries a release of.
  emitted['version'] = '0.0.0';
  for (const field of dependencyFields) {
    const block = workspace.manifest[field];
    if (!isJsonObject(block)) continue;
    emitted[field] = rewriteDependencyBlock(
      workspace.name,
      field,
      block as Record<string, string>,
      context,
    );
  }
  return emitted;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The target's root manifest.
 *
 * Only the keys the workspace graph needs to resolve are emitted. Root `scripts` and root
 * `devDependencies` are deliberately absent: they are the root-tooling class that
 * `target-owned.json` records as unresolved, and corvidae's own reference paths
 * (`scripts/browser-fixtures/...`) do not exist downstream. `applyPreservedFields` restores the
 * enumerated target-owned keys, so the target's `prepare` hook and husky pin survive.
 */
function buildRootManifest(
  target: MirrorTarget,
  root: JsonObject,
  context: RewriteContext,
  /** Whether the target already has a root manifest, and so already has its own answers. */
  targetHasRoot: boolean,
): JsonObject {
  const definition = targetDefinitions[target];
  const emitted: JsonObject = {
    name: definition.rootName,
    private: true,
    workspaces: [...definition.workspaces],
  };
  // Root tooling, seeded from corvidae's root for a target that has no root manifest yet and
  // left entirely alone for one that does. A root manifest is `private: true` and publishes
  // nothing, so none of these describes an artifact corvidae's source produces: they are how one
  // repository is set up. Weft pins `bun@1.4.0` here and in the `bun-version` its workflows
  // install with, and corvidae's `bun@1.4.2` has no standing to move either.
  if (!targetHasRoot) {
    for (const key of ['type', 'license', 'author', 'packageManager', 'engines', 'overrides']) {
      if (key in root) emitted[key] = root[key];
    }
  }
  if (definition.catalog) {
    const catalog: Record<string, string> = { ...context.catalog };
    for (const [name, range] of [...context.requiredCatalog].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      catalog[name] = range;
    }
    emitted['catalog'] = Object.fromEntries(
      Object.entries(catalog).toSorted(([left], [right]) => left.localeCompare(right)),
    );
  }
  return emitted;
}

/**
 * The blocks whose entries say what the source needs installed, and which the dependency rule
 * therefore composes entry by entry.
 *
 * `peerDependencies` is deliberately absent. A peer range is not a statement about what this
 * package imports; it is half of a packaging declaration whose other half, `peerDependenciesMeta`,
 * is target-owned outright. `target-owned.json` lists it under `manifestDefaults` instead, so the
 * pair is preserved or supplied together and can never drift apart.
 */
const installedDependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const;

/** A manifest composed against the target's own, with whatever the composition had to add. */
export interface ComposedManifest {
  manifest: JsonObject;
  /** Third-party packages the target declared nowhere, as `name (block)`. */
  added: string[];
}

/**
 * Compose one emitted manifest against the target's own.
 *
 * For a manifest the target does not carry there is nothing to preserve and corvidae's is all
 * there is. For one it does, the target's copy is the base: the transform overlays the keys
 * `target-owned.json` says it owns, supplies the ones it only defaults, composes the dependency
 * blocks by that file's rule, and leaves every other key — scripts, metadata, `lint-staged`,
 * `peerDependenciesMeta`, the lot — exactly as the target had it.
 *
 * An owned key absent from the emitted manifest is removed rather than left at the target's value,
 * because "the transform owns this key" and "corvidae's source does not have one" together say the
 * key should not be there.
 */
export function composeManifest({
  policy,
  target,
  emitted,
  existing,
  mirrorPackages,
}: {
  policy: TargetOwnedPolicy;
  target: MirrorTarget;
  emitted: JsonObject;
  existing: JsonObject | undefined;
  /**
   * Every name an edge to a workspace this mirror ships can appear under: each one's public
   * name, and since COR-1287 the target's own name for it where the two differ. Edges under
   * any of them are the transform's outright.
   */
  mirrorPackages: ReadonlySet<string>;
}): ComposedManifest {
  if (existing === undefined) return { manifest: emitted, added: [] };

  const manifest: JsonObject = { ...existing };
  for (const key of keysFor(policy.insideFiles.manifestKeys, target)) {
    if (key in emitted) manifest[key] = emitted[key];
    else delete manifest[key];
  }
  for (const key of keysFor(policy.insideFiles.manifestDefaults, target)) {
    if (!(key in manifest) && key in emitted) manifest[key] = emitted[key];
  }

  const { blocks, added } = composeDependencies(emitted, existing, mirrorPackages);
  for (const field of installedDependencyFields) {
    const block = blocks[field];
    if (block === undefined) delete manifest[field];
    else manifest[field] = block;
  }
  return { manifest, added };
}

/**
 * Compose the three installed-dependency blocks, by `target-owned.json`'s three cases: a package
 * this mirror ships is the transform's outright, a third-party package the target declares
 * anywhere keeps the target's block and range, and one the target declares nowhere is added from
 * corvidae and reported.
 */
function composeDependencies(
  emitted: JsonObject,
  existing: JsonObject,
  mirrorPackages: ReadonlySet<string>,
): {
  blocks: Partial<Record<(typeof installedDependencyFields)[number], Record<string, string>>>;
  added: string[];
} {
  // Where the target declares each package. A package in more than one block stays in all of them.
  const declaredByTarget = new Set<string>();
  const blocks: Partial<
    Record<(typeof installedDependencyFields)[number], Record<string, string>>
  > = {};
  for (const field of installedDependencyFields) {
    const block = existing[field];
    if (!isJsonObject(block)) continue;
    const kept: Record<string, string> = {};
    for (const [name, specifier] of Object.entries(block)) {
      declaredByTarget.add(name);
      // A mirror-internal entry is re-derived below from the plan, so a stale one cannot linger.
      if (mirrorPackages.has(name)) continue;
      kept[name] = String(specifier);
    }
    blocks[field] = kept;
  }

  const added: string[] = [];
  for (const field of installedDependencyFields) {
    const block = emitted[field];
    if (!isJsonObject(block)) continue;
    for (const [name, specifier] of Object.entries(block)) {
      if (!mirrorPackages.has(name)) {
        if (declaredByTarget.has(name)) continue;
        added.push(`${name} (${field})`);
      }
      (blocks[field] ??= {})[name] = String(specifier);
    }
  }

  for (const field of installedDependencyFields) {
    const block = blocks[field];
    if (block === undefined) continue;
    // A block emptied by the pruning above is dropped rather than emitted as `{}`, which is what
    // both targets' `sort-package-json` would do to it anyway.
    if (Object.keys(block).length === 0) {
      delete blocks[field];
      continue;
    }
    // Both targets sort their manifests, and an appended entry would otherwise land out of order.
    blocks[field] = Object.fromEntries(
      Object.entries(block).toSorted(([left], [right]) => left.localeCompare(right)),
    );
  }
  return { blocks, added };
}

/** A workspace `layout-map.json` defers, recorded rather than emitted. */
export interface DeferredWorkspace {
  workspace: string;
  layout: DeferredLayout;
}

export interface ManifestPlan {
  target: MirrorTarget;
  /** Target-relative path to file contents, ready for `writeTransformOutput`. */
  files: Record<string, string>;
  /**
   * Public names emitted at `0.0.0` because the target carries no version for them yet and
   * `package-map.json` records none either: a genuine first publish, nothing to seed from.
   */
  firstPublish: string[];
  /**
   * Public names emitted at `package-map.json`'s `lastPublishedVersion` rather than at `0.0.0`,
   * because the target carries no manifest for the workspace but the registry already does.
   * COR-1229: seeding this way, instead of throwing on the missing manifest or leaving the version
   * at `0.0.0`, is a ruling, not a fact recomputed elsewhere — every consumer of a plan has to
   * surface this list rather than treat a seeded version as an ordinary first publish.
   */
  seededFromPackageMap: string[];
  /** Internal edges dropped because the other end does not exist in this target. */
  droppedEdges: string[];
  /**
   * COR-1289: the intra-target `workspace:*` edges that survive, keyed by the consumer's corvidae
   * name and holding each dependency's public name, sorted.
   *
   * Recorded for the same reason `publicNames` is: it is a fact the dependency composition already
   * established, and a second producer re-deriving it is a second chance to disagree. `surface.ts`
   * narrows it to the edges between *published* packages when it fills each `PublishedPackage`'s
   * `dependsOn`, which is what orders the verification step list — a package's typecheck resolves
   * these edges through `exports` → `dist/`, so the dependency must already have been built.
   *
   * Only `dependencies`, `peerDependencies` and `optionalDependencies` contribute; see
   * `publishedEdgeFields` for why `devDependencies` does not.
   */
  intraTargetEdges: ReadonlyMap<string, readonly string[]>;
  /**
   * Third-party dependencies the target declared nowhere, added from corvidae, as
   * `path: name (block)`. Reported rather than refused: a package legitimately gains a dependency,
   * and the alternative to adding it is emitting source that cannot resolve its own imports.
   */
  addedDependencies: string[];
  /** Every workspace this target receives, with the directory it lands in. */
  emitted: EmittedWorkspace[];
  /**
   * The public name of every workspace in this tree, keyed by its `@lostgradient/*` name.
   *
   * Recorded rather than recomputed because it is the authority the rest of the transform renames
   * by. The manifest half has always used it for dependency edges; the source half rewrites import
   * specifiers with it and the TypeScript half rewrites `paths` keys, and three producers deriving
   * the same map separately is three chances for them to disagree about what a package is called.
   * Workspaces `package-map.json` excludes are absent: they have no public name, and asking for one
   * must fail rather than invent one.
   */
  publicNames: ReadonlyMap<string, string>;
  /** Workspaces whose placement is unresolved. Nothing is emitted for them and a sync refuses. */
  deferred: DeferredWorkspace[];
}

/**
 * Refuse a plan that quietly left a workspace out.
 *
 * Planning records a deferral instead of throwing, so one pass can report every problem, and this
 * is the call that turns it into a failure — the same split `assertPublishable` uses. Nothing is
 * written for a deferred workspace either way: the alternative to failing is guessing a directory
 * in somebody else's repository.
 */
export function assertNothingDeferred(plan: Pick<ManifestPlan, 'deferred'>): void {
  if (plan.deferred.length > 0) throw new DeferredWorkspaceError(plan.deferred);
}

export interface PlanOptions {
  /** The corvidae checkout to read. */
  corvidaeRoot: string;
  target: MirrorTarget;
  /** A clone of the target repository, read for the keys the target owns. Optional on a fresh target. */
  targetDirectory?: string | undefined;
  policy?: TargetOwnedPolicy | undefined;
  /**
   * `package-map.json`, overridden. Every production call (`sync.ts`, `dry-run.ts`) omits this and
   * reads the committed file, so a real sync always resolves a cross-target edge's staleness
   * against what is actually recorded there. `committed-plans.ts` and `manifests.test.ts` pass one
   * that overlays a computed `sourceDigest` onto every `publish-as` entry — see `dispositionFor`'s
   * own doc comment in `package-map.ts` for why.
   */
  packageMap?: PackageMap | undefined;
}

/**
 * The target's own copy of one manifest, or `undefined` where the target has none.
 *
 * Exported because the surface half needs the same answer: whether a key it carries is a fact the
 * target already holds the authoritative copy of, or one only corvidae can supply.
 */
export async function readExistingManifest(
  targetDirectory: string | undefined,
  path: string,
): Promise<JsonObject | undefined> {
  if (targetDirectory === undefined) return undefined;
  const file = Bun.file(join(targetDirectory, path));
  if (!(await file.exists())) return undefined;
  return (await file.json()) as JsonObject;
}

/**
 * Add the target's own name for each mirror workspace to `mirrorPackages`.
 *
 * COR-1287. `target-owned.json`'s dependency rule (1) says an edge to a package this mirror ships
 * is "the transform's outright — name, block and specifier — because only the transform knows what
 * it is called downstream", and `composeDependencies` implements that by dropping the target's
 * entry whenever its name is in `mirrorPackages`. That worked while every target already spelled
 * a mirror workspace the way the mirror publishes it, which was true of weft and cinder and is not
 * true of agent-bureau: it calls corvidae's `@lostgradient/lifecycle` simply `lifecycle`, and the
 * same for `bureau`, `memory` and `skills`. Under the public name alone, rule (1) never matched
 * those entries, rule (2) kept them as ordinary third-party edges, and the composed manifest
 * carried the same workspace twice under two names. A live staging against the real target
 * produced exactly that and `bun install` refused it: `Workspace dependency "lifecycle" not
 * found`, from six consumers at once.
 *
 * The alias is read off the clone rather than recorded anywhere: `layout-map.json` already says
 * which target directory a workspace lands in, and the manifest sitting at that directory names
 * the package in the target's own vocabulary. That name is as much the transform's to remove as
 * the public name is to write, because the rename to the public name is the transform's own
 * output — `name` is a `manifestKey`, so the target cannot get ahead of it.
 *
 * Scope: this changes nothing for a target that already agrees with the mirror on a name, which
 * today is both other targets.
 */
async function collectTargetAliases({
  targetDirectory,
  emittable,
  publicNames,
  mirrorPackages,
}: {
  targetDirectory: string | undefined;
  emittable: readonly { workspace: DiscoveredWorkspace; directory: string }[];
  publicNames: ReadonlyMap<string, string>;
  mirrorPackages: Set<string>;
}): Promise<void> {
  if (targetDirectory === undefined) return;
  for (const { workspace, directory } of emittable) {
    const existing = await readExistingManifest(targetDirectory, `${directory}/package.json`);
    const existingName = existing?.['name'];
    if (typeof existingName !== 'string' || existingName.length === 0) continue;
    if (existingName === publicNames.get(workspace.name)) continue;
    // A target name that is another workspace's public name is not an alias, it is a collision:
    // dropping the edge would silently remove a real dependency on that other package. Nothing in
    // either repository does this today, and a transform that guessed would be unreviewable.
    for (const [other, publicName] of publicNames) {
      if (publicName === existingName && other !== workspace.name) {
        throw new ManifestTransformError(
          `the target names ${directory} "${existingName}", which is ${other}'s public name; one of the two has to be renamed before a sync can tell an alias from a collision`,
        );
      }
    }
    mirrorPackages.add(existingName);
  }
}

/** Build every manifest and `LICENSE` this target receives, without writing anything. */
export async function planManifests({
  corvidaeRoot,
  target,
  targetDirectory,
  policy,
  packageMap,
}: PlanOptions): Promise<ManifestPlan> {
  const resolvedPolicy = policy ?? (await loadTargetOwnedPolicy());
  const root = (await Bun.file(join(corvidaeRoot, 'package.json')).json()) as JsonObject;
  const catalog = isJsonObject(root['catalog']) ? (root['catalog'] as Record<string, string>) : {};

  const workspaces = await discoverWorkspaces(corvidaeRoot);
  const emittedWorkspaces: EmittedWorkspace[] = [];
  const deferred: DeferredWorkspace[] = [];
  const dispositions = new Map<string, WorkspaceDisposition>();
  const publicNames = new Map<string, string>();
  const layouts = new Map<string, WorkspaceLayout>();
  for (const workspace of workspaces) {
    // `dispositionFor` throws `PackageMapError` naming the workspace. Letting it propagate is the
    // point: an unmapped workspace must stop the sync rather than be skipped. `layoutFor` throws
    // the same way for a workspace with no recorded target directory.
    const disposition = await dispositionFor(workspace.name, packageMap);
    dispositions.set(workspace.name, disposition);
    if (disposition.disposition === 'exclude') continue;
    publicNames.set(workspace.name, publicNameFor(workspace.name, disposition));
    const layout = await layoutFor(workspace.name);
    layouts.set(workspace.name, layout);
    if (layout.disposition === 'deferred' && targetFor(workspace.name) === target) {
      deferred.push({ workspace: workspace.name, layout });
    }
  }
  assertPublicNamesUnique(publicNames);

  // Publication identity is needed only where this target consumes another target's package.
  // Inspect the same manifest blocks rewriteWorkspaceManifest consumes, including development
  // dependencies. Unrelated packages must not add discovery work or block a standalone plan.
  const crossTargetDependencies = new Set<string>();
  for (const consumer of workspaces) {
    if (dispositions.get(consumer.name)?.disposition === 'exclude') continue;
    if (targetFor(consumer.name) !== target) continue;
    if (layouts.get(consumer.name)?.disposition === 'deferred') continue;
    for (const field of dependencyFields) {
      const block = consumer.manifest[field];
      if (!isJsonObject(block)) continue;
      for (const dependency of Object.keys(block)) {
        if (dispositions.get(dependency)?.disposition !== 'publish-as') continue;
        if (targetFor(dependency) !== target) crossTargetDependencies.add(dependency);
      }
    }
  }
  const currentDigests = new Map<string, string>();
  const currentSourcePaths = new Map<string, readonly string[]>();
  const currentPublicationInputs = new Map<string, string>();
  for (const workspace of workspaces) {
    if (!crossTargetDependencies.has(workspace.name)) continue;
    const sourceFiles = await collectDigestedFiles({
      corvidaeRoot,
      corvidaeDirectory: workspace.directory,
      workspace: workspace.name,
    });
    currentDigests.set(workspace.name, hashDigestedFiles(sourceFiles));
    currentSourcePaths.set(
      workspace.name,
      sourceFiles.map((file) => file.path),
    );
    const publicationInputs = await publicationInputContract({
      corvidaeRoot,
      corvidaeDirectory: workspace.directory,
      workspace: workspace.name,
    });
    currentPublicationInputs.set(workspace.name, publicationInputs.digest);
  }

  const context: RewriteContext = {
    target,
    catalog,
    publicNames,
    dispositions,
    currentDigests,
    currentSourcePaths,
    currentPublicationInputs,
    requiredCatalog: new Map(),
    dropped: [],
    intraTargetEdges: new Map(),
  };

  const licence = await Bun.file(join(corvidaeRoot, 'LICENSE')).text();
  const files: Record<string, string> = {};
  const firstPublish: string[] = [];
  const seededFromPackageMap: string[] = [];
  const addedDependencies: string[] = [];

  // Every workspace this target receives, resolved once: the emission loop and the alias pass
  // below have to walk the same set, and the alias pass has to finish before the first manifest is
  // composed.
  const emittable = workspaces.flatMap((workspace) => {
    const disposition = dispositions.get(workspace.name);
    if (!disposition || disposition.disposition === 'exclude') return [];
    if (targetFor(workspace.name) !== target) return [];
    const layout = layouts.get(workspace.name);
    if (!layout || layout.disposition === 'deferred') return [];
    return [{ workspace, disposition, directory: layout.targetDirectory }];
  });

  const mirrorPackages = new Set(publicNames.values());
  await collectTargetAliases({ targetDirectory, emittable, publicNames, mirrorPackages });

  for (const { workspace, disposition, directory } of emittable) {
    const path = `${directory}/package.json`;
    const emitted = rewriteWorkspaceManifest(workspace, disposition, context);
    const existing = await readExistingManifest(targetDirectory, path);
    // COR-1229: a workspace the target has no manifest for is a first publish only when
    // `package-map.json` has no released version to seed from either. Where it does, that
    // version is a fact worth carrying forward, not a rewind — seeding it is strictly more
    // correct than emitting `0.0.0` over a package the registry already has, and both branches
    // below are reported rather than left implicit in the version alone.
    if (existing === undefined) {
      if (disposition.disposition === 'publish-as' && disposition.lastPublishedVersion !== null) {
        emitted['version'] = disposition.lastPublishedVersion;
        seededFromPackageMap.push(String(emitted['name']));
      } else {
        firstPublish.push(String(emitted['name']));
      }
    }
    const composed = composeManifest({
      policy: resolvedPolicy,
      target,
      emitted,
      existing,
      mirrorPackages,
    });
    for (const entry of composed.added) addedDependencies.push(`${path}: ${entry}`);

    files[path] = await serializeJson(composed.manifest, targetDirectory, path);
    files[`${directory}/LICENSE`] = licence;
    emittedWorkspaces.push({
      workspace: workspace.name,
      corvidaeDirectory: workspace.directory,
      targetDirectory: directory,
    });
  }

  const existingRoot = await readExistingManifest(targetDirectory, 'package.json');
  const composedRoot = composeManifest({
    policy: resolvedPolicy,
    target,
    emitted: buildRootManifest(target, root, context, existingRoot !== undefined),
    existing: existingRoot,
    mirrorPackages,
  });
  for (const entry of composedRoot.added) addedDependencies.push(`package.json: ${entry}`);
  files['package.json'] = await serializeJson(
    composedRoot.manifest,
    targetDirectory,
    'package.json',
  );

  return {
    target,
    files,
    firstPublish: firstPublish.toSorted(),
    seededFromPackageMap: seededFromPackageMap.toSorted(),
    droppedEdges: context.dropped,
    intraTargetEdges: new Map(
      [...context.intraTargetEdges].map(([consumer, edges]) => [
        consumer,
        [...edges].toSorted((left, right) => left.localeCompare(right)),
      ]),
    ),
    addedDependencies: addedDependencies.toSorted(),
    emitted: emittedWorkspaces,
    publicNames,
    deferred,
  };
}

/**
 * Two workspaces resolving to one public name would make one overwrite the other downstream.
 * `package-map.json`'s own loader checks this for published names; derived private names are new
 * here, so they are checked against the published ones too.
 */
function assertPublicNamesUnique(publicNames: ReadonlyMap<string, string>): void {
  const seen = new Map<string, string>();
  for (const [workspace, publicName] of publicNames) {
    const previous = seen.get(publicName);
    if (previous) {
      throw new ManifestTransformError(
        `${workspace} and ${previous} both resolve to ${publicName}; a public name must be unique`,
      );
    }
    seen.set(publicName, workspace);
  }
}

export interface StageResult extends ManifestPlan {
  directory: string;
  written: string[];
}

/**
 * Write the plan into a target clone and regenerate its lockfile.
 *
 * `bun.lock` is target-owned, so the transform never writes one; it is produced by running an
 * install in the staged tree, which is the only thing that can resolve the graph the target
 * actually has. `--ignore-scripts` keeps a preserved `prepare` hook — husky, in both targets —
 * from running during a staging install that exists only to produce the lockfile.
 */
export async function stageTarget(
  options: PlanOptions & { directory: string },
): Promise<StageResult> {
  const policy = options.policy ?? (await loadTargetOwnedPolicy());
  const plan = await planManifests({ ...options, policy });
  assertNothingDeferred(plan);
  const { written } = await writeTransformOutput({
    policy,
    target: options.target,
    directory: options.directory,
    files: plan.files,
  });
  await runInstall(options.directory);
  return { ...plan, directory: options.directory, written };
}

/**
 * Regenerate a staged target's lockfile.
 *
 * Exported because the surface half of the transform stages through its own path — it has two
 * gates to run between planning and writing — and a second copy of this would be a second place
 * for the `--ignore-scripts` reasoning above to drift.
 *
 * `--ignore-scripts` is correct *here* and wrong in `verifyTarget`, which is not an inconsistency
 * to tidy up. This install exists only to resolve a lockfile, and resolution does not depend on
 * lifecycle scripts, so skipping them is free. Verification is a claim about a tree that builds
 * and runs, and skipping them there silently left `better-sqlite3` with no compiled binding while
 * every check that stopped short of constructing a database still passed (COR-1278). `verifyTarget`
 * therefore wipes this `node_modules` and reinstalls with scripts enabled — Bun will not re-run an
 * already-linked package's scripts, so the wipe is what makes that second install mean anything.
 */
export async function runInstall(directory: string, extra: readonly string[] = []): Promise<void> {
  const install = Bun.spawn(['bun', 'install', '--ignore-scripts', ...extra], {
    cwd: directory,
    env: childProcessEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(install.stderr).text(),
    install.exited,
  ]);
  if (exitCode !== 0) {
    throw new ManifestTransformError(`bun install failed in ${directory}:\n${stderr}`);
  }
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function assertMirrorTarget(value: string | undefined): MirrorTarget {
  if (value !== undefined && (mirrorTargets as readonly string[]).includes(value)) {
    return value as MirrorTarget;
  }
  throw new ManifestTransformError(
    `Missing or unknown --target; expected one of ${mirrorTargets.join(', ')}`,
  );
}

export async function runManifestTransform(argv: readonly string[]): Promise<number> {
  try {
    const target = assertMirrorTarget(readOption(argv, 'target'));
    const directory = readOption(argv, 'directory');
    if (!directory) throw new ManifestTransformError('Missing required option --directory');
    const result = await stageTarget({
      corvidaeRoot:
        readOption(argv, 'corvidae-root') ?? new URL('../../', import.meta.url).pathname,
      target,
      targetDirectory: readOption(argv, 'target-clone'),
      directory,
    });
    process.stdout.write(`Staged ${result.written.length} file(s) for ${target} in ${directory}\n`);
    if (result.firstPublish.length > 0) {
      process.stdout.write(`First publish, seeded at 0.0.0: ${result.firstPublish.join(', ')}\n`);
    }
    if (result.seededFromPackageMap.length > 0) {
      process.stdout.write(
        `Seeded from package-map.json's lastPublishedVersion, target has no manifest yet: ${result.seededFromPackageMap.join(', ')}\n`,
      );
    }
    if (result.droppedEdges.length > 0) {
      process.stdout.write(`Dropped cross-target edges: ${result.droppedEdges.join(', ')}\n`);
    }
    if (result.addedDependencies.length > 0) {
      process.stdout.write(
        `Dependencies the target did not declare, added from corvidae:\n${result.addedDependencies
          .map((entry) => `  ${entry}`)
          .join('\n')}\n`,
      );
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runManifestTransform(Bun.argv.slice(2)));
