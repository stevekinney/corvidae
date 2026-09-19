import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dispositionFor, type WorkspaceDisposition } from './package-map.ts';
import {
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
 * - Every `@corvidae/*` name becomes the public name `package-map.json` assigns it, in the
 *   workspace's own `name` and in every internal dependency specifier.
 * - `workspace:*` survives only while both ends ship in the same target. An edge crossing targets
 *   has to become a published range, because the other end is a registry dependency downstream.
 * - `catalog:` survives only in a target that has a workspace root to hold a catalog. The weft
 *   target is a single package, so its specifiers are inlined to concrete ranges.
 * - `private: true` is stripped from anything the map publishes and kept on everything else.
 * - Every emitted package directory gets the root `LICENSE`, per COR-1183's ruling that
 *   per-package `LICENSE` is transform-owned while the root one is target-owned.
 *
 * Versions are never authored here. `target-owned.json` enumerates the manifest keys a target
 * owns but deliberately leaves them unenforced, because a whole-file write guard cannot express
 * "preserve this key inside a file you do write". `applyPreservedFields` closes that gap by
 * reading each enumerated JSON Pointer back out of the target's own manifest.
 */

export type MirrorTarget = 'weft' | 'cinder';

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
 * Per-target facts that are not in `package-map.json`, which rules on what a workspace *becomes*
 * rather than on which repository it lands in.
 *
 * `rootName` and `workspaces` are read off the targets as they exist today (`weft-monorepo` with
 * `packages/*`, `cinder-workspace` with its explicit list) rather than invented, so a sync does
 * not rewrite a key that was already correct. `catalog` records whether the target has a
 * workspace root able to hold one.
 */
const targetDefinitions = {
  weft: {
    rootName: 'weft-monorepo',
    workspaces: ['packages/*'],
    catalog: false,
    /** The weft target is a single-package repository; every other workspace ships elsewhere. */
    members: ['@corvidae/weft'] as readonly string[],
  },
  cinder: {
    rootName: 'cinder-workspace',
    workspaces: workspaceDirectories.map((directory) => `${directory}/*`),
    catalog: true,
    members: undefined,
  },
} as const satisfies Record<MirrorTarget, unknown>;

export const mirrorTargets = Object.keys(targetDefinitions) as readonly MirrorTarget[];

/** Which target a workspace ships from. Anything the weft repository does not own is monorepo source. */
export function targetFor(workspace: string): MirrorTarget {
  return targetDefinitions.weft.members.includes(workspace) ? 'weft' : 'cinder';
}

type JsonObject = Record<string, unknown>;

export interface DiscoveredWorkspace {
  /** The `@corvidae/*` name, read from the manifest rather than inferred from the directory. */
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
 * `package-map.json` only records a name for something that reaches the registry — so the name is
 * derived by re-scoping, which keeps the package identifiable downstream without claiming a
 * registry name. `private: true` is preserved alongside it, so the derived name is never published.
 */
export function publicNameFor(workspace: string, disposition: WorkspaceDisposition): string {
  if (disposition.disposition === 'publish-as') return disposition.name;
  if (disposition.disposition === 'exclude') {
    throw new ManifestTransformError(
      `${workspace} is excluded from the mirror and has no public name`,
    );
  }
  const [scope, ...rest] = workspace.split('/');
  if (scope !== '@corvidae' || rest.length !== 1) {
    throw new ManifestTransformError(
      `${workspace} is not a @corvidae/* workspace, so no public name can be derived for it`,
    );
  }
  return `@lostgradient/${rest[0]}`;
}

/** The published range a cross-target edge resolves to, which only a published package has. */
function publishedRangeFor(workspace: string, disposition: WorkspaceDisposition): string {
  if (disposition.disposition !== 'publish-as') {
    throw new ManifestTransformError(`${workspace} is not published, so it has no range`);
  }
  if (disposition.lastPublishedVersion === null) {
    throw new ManifestTransformError(
      `${workspace} ships from a different target but has never been published, so an edge to it cannot be expressed as a range; publish it first or move it into the same target`,
    );
  }
  return `^${disposition.lastPublishedVersion}`;
}

interface RewriteContext {
  target: MirrorTarget;
  /** Corvidae's root catalog, used to inline specifiers in a target that cannot hold one. */
  catalog: Readonly<Record<string, string>>;
  /** Public names, keyed by corvidae name, for every workspace on disk. */
  publicNames: ReadonlyMap<string, string>;
  dispositions: ReadonlyMap<string, WorkspaceDisposition>;
  /** Catalog entries this target must declare, accumulated as cross-target edges are resolved. */
  requiredCatalog: Map<string, string>;
  /** Edges dropped because the other end does not exist downstream, reported rather than silent. */
  dropped: string[];
}

/** Resolve one internal `@corvidae/*` edge, or `undefined` when the edge cannot be carried. */
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
  if (targetFor(dependency) === context.target) return [publicName, 'workspace:*'];

  if (disposition.disposition === 'private-workspace') {
    // A private workspace has no registry presence, so an edge to one cannot cross repositories.
    // Dropping is only safe where the edge is development-only in both senses: the map says the
    // workspace is tooling, and the consumer declares it as tooling. Anything an installed
    // package would need at runtime has to fail instead. COR-1189 vendors `@corvidae/typescript`
    // into the weft target to replace the one edge this removes today.
    if (disposition.basis !== 'development-only' || field !== 'devDependencies') {
      throw new ManifestTransformError(
        `${consumer} lists ${dependency} under ${field}, but ${dependency} ships from the ${targetFor(dependency)} target and is never published; only a devDependencies edge to development-only tooling can be dropped`,
      );
    }
    context.dropped.push(`${consumer} -> ${dependency}`);
    return undefined;
  }

  const range = publishedRangeFor(dependency, disposition);
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
  // Seeds a first publish. `applyPreservedFields` replaces this with the target's own version
  // whenever the target already carries one, so it only survives where nothing has been released.
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
): JsonObject {
  const definition = targetDefinitions[target];
  const emitted: JsonObject = {
    name: definition.rootName,
    private: true,
    workspaces: [...definition.workspaces],
  };
  for (const key of ['type', 'license', 'author', 'packageManager', 'engines', 'overrides']) {
    if (key in root) emitted[key] = root[key];
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

/** Read a JSON Pointer (RFC 6901) out of a parsed document. */
export function readPointer(document: unknown, pointer: string): unknown {
  let current = document;
  for (const token of decodePointer(pointer)) {
    if (!isJsonObject(current)) return undefined;
    current = current[token];
  }
  return current;
}

/** Write a JSON Pointer, creating intermediate objects, or delete it when `value` is `undefined`. */
export function writePointer(document: JsonObject, pointer: string, value: unknown): void {
  const tokens = decodePointer(pointer);
  const last = tokens.pop();
  if (last === undefined) throw new ManifestTransformError('Cannot write the whole document');
  let current = document;
  for (const token of tokens) {
    const next = current[token];
    if (isJsonObject(next)) {
      current = next;
      continue;
    }
    if (value === undefined) return;
    const created: JsonObject = {};
    current[token] = created;
    current = created;
  }
  if (value === undefined) delete current[last];
  else current[last] = value;
}

function decodePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new ManifestTransformError(`"${pointer}" is not a JSON Pointer`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/**
 * Carry every enumerated target-owned key out of the target's own manifest and into the emitted
 * one, so a file the transform does write still leaves those keys exactly as the target had them.
 *
 * A key the target does not carry is removed from the emitted manifest rather than left at
 * corvidae's value, because "the target owns this key" and "the target chose not to set it" are
 * the same statement.
 */
export function applyPreservedFields(
  policy: TargetOwnedPolicy,
  target: MirrorTarget,
  file: string,
  emitted: JsonObject,
  existing: JsonObject | undefined,
): void {
  if (existing === undefined) return;
  for (const entry of policy.fields.entries) {
    if (entry.targets !== undefined && !entry.targets.includes(target)) continue;
    if (!new Bun.Glob(entry.file).match(file)) continue;
    writePointer(emitted, entry.pointer, readPointer(existing, entry.pointer));
  }
}

export interface ManifestPlan {
  target: MirrorTarget;
  /** Target-relative path to file contents, ready for `writeTransformOutput`. */
  files: Record<string, string>;
  /** Public names emitted at `0.0.0` because the target carries no version for them yet. */
  firstPublish: string[];
  /** Internal edges dropped because the other end does not exist in this target. */
  droppedEdges: string[];
}

export interface PlanOptions {
  /** The corvidae checkout to read. */
  corvidaeRoot: string;
  target: MirrorTarget;
  /** A clone of the target repository, read for the keys the target owns. Optional on a fresh target. */
  targetDirectory?: string | undefined;
  policy?: TargetOwnedPolicy | undefined;
}

async function readExistingManifest(
  targetDirectory: string | undefined,
  path: string,
): Promise<JsonObject | undefined> {
  if (targetDirectory === undefined) return undefined;
  const file = Bun.file(join(targetDirectory, path));
  if (!(await file.exists())) return undefined;
  return (await file.json()) as JsonObject;
}

function serialize(manifest: JsonObject): string {
  return `${JSON.stringify(manifest, undefined, 2)}\n`;
}

/** Build every manifest and `LICENSE` this target receives, without writing anything. */
export async function planManifests({
  corvidaeRoot,
  target,
  targetDirectory,
  policy,
}: PlanOptions): Promise<ManifestPlan> {
  const resolvedPolicy = policy ?? (await loadTargetOwnedPolicy());
  const root = (await Bun.file(join(corvidaeRoot, 'package.json')).json()) as JsonObject;
  const catalog = isJsonObject(root['catalog']) ? (root['catalog'] as Record<string, string>) : {};

  const workspaces = await discoverWorkspaces(corvidaeRoot);
  const dispositions = new Map<string, WorkspaceDisposition>();
  const publicNames = new Map<string, string>();
  for (const workspace of workspaces) {
    // `dispositionFor` throws `PackageMapError` naming the workspace. Letting it propagate is the
    // point: an unmapped workspace must stop the sync rather than be skipped.
    const disposition = await dispositionFor(workspace.name);
    dispositions.set(workspace.name, disposition);
    if (disposition.disposition !== 'exclude') {
      publicNames.set(workspace.name, publicNameFor(workspace.name, disposition));
    }
  }
  assertPublicNamesUnique(publicNames);

  const context: RewriteContext = {
    target,
    catalog,
    publicNames,
    dispositions,
    requiredCatalog: new Map(),
    dropped: [],
  };

  const licence = await Bun.file(join(corvidaeRoot, 'LICENSE')).text();
  const files: Record<string, string> = {};
  const firstPublish: string[] = [];

  for (const workspace of workspaces) {
    const disposition = dispositions.get(workspace.name);
    if (!disposition || disposition.disposition === 'exclude') continue;
    if (targetFor(workspace.name) !== target) continue;

    const path = `${workspace.directory}/package.json`;
    const emitted = rewriteWorkspaceManifest(workspace, disposition, context);
    const existing = await readExistingManifest(targetDirectory, path);
    if (existing === undefined && disposition.disposition === 'publish-as') {
      assertNoPublishedPredecessor(workspace.name, disposition, targetDirectory, path);
    }
    applyPreservedFields(resolvedPolicy, target, path, emitted, existing);
    if (emitted['version'] === '0.0.0') firstPublish.push(String(emitted['name']));

    files[path] = serialize(emitted);
    files[`${workspace.directory}/LICENSE`] = licence;
  }

  const rootManifest = buildRootManifest(target, root, context);
  applyPreservedFields(
    resolvedPolicy,
    target,
    'package.json',
    rootManifest,
    await readExistingManifest(targetDirectory, 'package.json'),
  );
  files['package.json'] = serialize(rootManifest);

  return { target, files, firstPublish: firstPublish.toSorted(), droppedEdges: context.dropped };
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

/**
 * A package the registry already has must exist in the target clone. Seeding `0.0.0` for one would
 * silently rewind a released package, so an incomplete clone fails here instead.
 */
function assertNoPublishedPredecessor(
  workspace: string,
  disposition: WorkspaceDisposition,
  targetDirectory: string | undefined,
  path: string,
): void {
  if (disposition.disposition !== 'publish-as') return;
  if (disposition.lastPublishedVersion === null) return;
  if (targetDirectory === undefined) return;
  throw new ManifestTransformError(
    `${workspace} is published at ${disposition.lastPublishedVersion} but the target has no ${path}; refusing to seed a first-publish version over a released package`,
  );
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
  const written = await writeTransformOutput({
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
 */
export async function runInstall(directory: string, extra: readonly string[] = []): Promise<void> {
  const install = Bun.spawn(['bun', 'install', '--ignore-scripts', ...extra], {
    cwd: directory,
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
    if (result.droppedEdges.length > 0) {
      process.stdout.write(`Dropped cross-target edges: ${result.droppedEdges.join(', ')}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runManifestTransform(Bun.argv.slice(2)));
