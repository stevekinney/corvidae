import { join } from 'node:path';

import { discoverComponents } from '../../components/cinder/scripts/lib/discover-components.ts';
import { serializeJson } from './json-formatting.ts';
import {
  ManifestTransformError,
  planManifests,
  publicNameFor,
  readExistingManifest,
  targetHasCatalog as targetCanHoldCatalog,
  type ManifestPlan,
  type PlanOptions,
} from './manifests.ts';
import { renderMirrorVerifyWorkflow } from './mirror-verify-workflow.ts';
import { dispositionFor } from './package-map.ts';
import {
  checkTargetCoverage,
  loadPackageSurface,
  resolveSurface,
  type CoverageFinding,
  type PackageSurfaceEntry,
  type SurfaceExportsMap,
} from './package-surface.ts';
import { checkParity, loadRegistryBaseline, type ParityResult } from './registry-baseline.ts';
import {
  applyVersionConstants,
  assertSingleOwner,
  planSource,
  type EmittedWorkspace,
  type SourcePlan,
} from './source.ts';
import { assertNoSourceEscapes } from './target-resolvability.ts';
import {
  assertTypeScriptEdgeClosed,
  planTypeScriptConfiguration,
  type TypeScriptPlan,
} from './typescript-configuration.ts';

/**
 * The distributable half of the mirror transform, composed onto COR-1188's manifest half.
 *
 * `planManifests` answers what each package is called downstream and what it depends on. It
 * deliberately carries `exports` through untouched and never emits `files` or a build. This adds
 * those three, plus the TypeScript configuration each target needs, and runs the two gates that
 * decide whether the result is publishable: surface parity against the registry baseline, and
 * whether every exports target names something the package can actually ship.
 *
 * COR-1221 added the part none of that covered: the source itself. `planSource` reads each
 * emitted workspace's `src/` tree and this composes it with the manifests and the TypeScript
 * configuration, which is also where the three producers' claims on the plan's keys are checked
 * against each other. The merge is a spread, so an overlap would otherwise be a silent
 * last-writer-wins on a file one half of the transform thought it owned.
 *
 * The composed file set is also where the closure gate belongs. `assertNoSourceEscapes` asks
 * whether every module specifier in the emitted source lands on something the plan emits, which
 * is a question only this merge can answer: the source half alone would call a specifier into a
 * manifest an escape. It runs here rather than in `assertPublishable` because an unresolvable
 * import is not a finding to report alongside others — it is a plan that cannot be written.
 *
 * Nothing here writes. `stageTarget` in `manifests.ts` is still what puts a plan on disk, and the
 * target-owned guard still runs over the whole file set before any of it lands.
 */

type JsonObject = Record<string, unknown>;

/**
 * One package the target publishes, as the plan resolved it.
 *
 * The plan is otherwise a flat path-to-contents map, which is all a write needs but not enough to
 * pack, lint or smoke-test a package afterwards: those need to know which directory holds a
 * publishable manifest, what it is called on the registry, and which `exports` map it ended up
 * with. Everything here is already computed while building the plan, so it is recorded rather
 * than recovered by a second pass over the workspaces.
 */
export interface PublishedPackage {
  /** The `@lostgradient/*` workspace name. */
  workspace: string;
  /** Target-relative directory, the same one the manifest was written to. */
  directory: string;
  publicName: string;
  entry: PackageSurfaceEntry;
  exports: SurfaceExportsMap;
  files: string[];
  /**
   * The emitted manifest's `version`, read back out rather than recomputed: `target-owned.json`'s
   * `insideFiles` policy never overlays `version`, so this is always whatever `composeManifest`
   * already resolved — the target's own preserved version, or `0.0.0`/`package-map.json`'s
   * `lastPublishedVersion` on a first publish. COR-1286 needs it as a typed value so the shared
   * verification step list (`verify-steps.ts`) can compute a package's packed tarball filename
   * ahead of time with `packaging.ts`'s `tarballFilename`, the same way both `verifyTarget` and the
   * rendered `mirror-verify.yaml` workflow do.
   */
  version: string;
  /**
   * The public names of the other *published* packages in this target that this one depends on.
   *
   * COR-1289: verification builds and type-checks each published package in its own directory, and
   * a typecheck resolves an edge to a sibling package through that sibling's `exports`, which point
   * at `dist/`. A sibling that has not been built yet has no `dist/`, so the typecheck fails with
   * `Cannot find module '@lostgradient/<dependency>'` — which is exactly what agent-bureau hit,
   * `armorer` being first in discovery order with four unbuilt dependencies behind it. Recording
   * the edges here is what lets `verify-steps.ts` order the step list by them instead of by the
   * order the workspace walk happened to find directories in.
   *
   * Taken from `planManifests`'s `intraTargetEdges`, narrowed to the published set: an edge to a
   * private workspace in the same target is a real `workspace:*` edge but not a build order — a
   * private workspace is never packed and ships its source, so there is no `dist/` to wait for.
   */
  dependsOn: string[];
}

/**
 * A workspace that ships to the target but never to the registry.
 *
 * Recorded because its source ships now. Before COR-1221 a private workspace was a manifest and a
 * tsconfig, so there was nothing in it to check; now it is code, and code nothing type-checks is
 * code the mirror publishes to a repository without knowing whether it compiles.
 */
export interface PrivateWorkspace {
  workspace: string;
  /** Target-relative directory, the same one the manifest was written to. */
  directory: string;
  publicName: string;
  /** Whether the emitted manifest declares a `typecheck` script. */
  typechecks: boolean;
  /** Whether the emitted source includes TypeScript, which is what makes a typecheck meaningful. */
  emitsTypeScript: boolean;
}

export interface SurfacePlan extends Omit<ManifestPlan, 'files'> {
  /**
   * Target-relative path to file contents. Bytes as well as text since COR-1221: the source half
   * emits whatever a workspace's `src/` tree holds, including one PNG baseline fixture.
   */
  files: Record<string, string | Uint8Array>;
  /** One result per published package, including the ones with no published predecessor. */
  parity: ParityResult[];
  /** Every exports target that cannot be shipped or has no source. Empty is the goal, not a given. */
  coverage: CoverageFinding[];
  typescript: TypeScriptPlan;
  /** The packages this target publishes, in discovery order. Private workspaces are absent. */
  published: PublishedPackage[];
  /** The workspaces this target receives but never publishes, in discovery order. */
  privateWorkspaces: PrivateWorkspace[];
  source: SourcePlan;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge the build toolchain into a manifest's `devDependencies`.
 *
 * A `catalog:` value only survives in a target that has a workspace root to hold a catalog, which
 * is the same rule `manifests.ts` applies to corvidae's own specifiers; in the single-package weft
 * target it is inlined from corvidae's root catalog instead.
 *
 * A package the manifest already declares is left exactly as it is. This list exists to make sure
 * the build's own imports resolve, which a dependency the target already pins does; overwriting
 * the pin would retune the target's toolchain as a side effect of a build-input check, and
 * `target-owned.json` gives third-party ranges to whichever manifest already declares them.
 */
function applyToolchain(
  manifest: JsonObject,
  toolchain: Readonly<Record<string, string>>,
  catalog: Readonly<Record<string, string>>,
  targetHasCatalog: boolean,
  consumer: string,
): void {
  if (Object.keys(toolchain).length === 0) return;
  const existing = isJsonObject(manifest['devDependencies'])
    ? (manifest['devDependencies'] as Record<string, string>)
    : {};
  const merged: Record<string, string> = { ...existing };
  for (const [dependency, specifier] of Object.entries(toolchain)) {
    if (dependency in merged) continue;
    if (specifier !== 'catalog:' || targetHasCatalog) {
      merged[dependency] = specifier;
      continue;
    }
    const range = catalog[dependency];
    if (range === undefined) {
      throw new ManifestTransformError(
        `${consumer} needs ${dependency} to build, but corvidae's root catalog does not declare it and this target has no catalog to inline from`,
      );
    }
    merged[dependency] = range;
  }
  manifest['devDependencies'] = Object.fromEntries(
    Object.entries(merged).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

/** The exports map the target already publishes, or `undefined` on a fresh target. */
function readExports(existing: JsonObject | undefined): SurfaceExportsMap | undefined {
  const exports = existing?.['exports'];
  return isJsonObject(exports) ? (exports as SurfaceExportsMap) : undefined;
}

/**
 * Write one package's published surface onto its manifest.
 *
 * Two classes of key, split by `target-owned.json`'s `insideFiles` rule and by where the value
 * comes from. `exports`, `files`, `bin` and `sideEffects` are recomputed from corvidae's source
 * every run and gated against the registry baseline, so they are written unconditionally. The
 * rest — `manifestFields` and `peerDependencies` — are, by `package-surface.json`'s own account,
 * ports of what the target publishes today; where the target still carries the key it holds the
 * authoritative copy of the same fact, so they are supplied only as defaults. `existing` is the
 * target's own manifest, `undefined` on a package the target does not have, where nothing can be
 * preserved and every default applies.
 *
 * `build.scripts` merge rather than replace for the same reason: a build script is the transform's
 * because it produces the artifact, and every other script in the block is the target's.
 */
function applySurfaceToManifest(
  manifest: JsonObject,
  entry: PackageSurfaceEntry,
  exports: SurfaceExportsMap,
  files: readonly string[],
  existing: JsonObject | undefined,
): void {
  const supplies = (key: string): boolean => existing === undefined || !(key in existing);
  for (const [key, value] of Object.entries(entry.manifestFields)) {
    if (supplies(key)) manifest[key] = value;
  }
  manifest['exports'] = exports;
  manifest['files'] = [...files];
  const scripts = isJsonObject(manifest['scripts'])
    ? (manifest['scripts'] as Record<string, string>)
    : {};
  manifest['scripts'] = { ...scripts, ...entry.build.scripts };
  if (entry.peerDependencies && supplies('peerDependencies')) {
    manifest['peerDependencies'] = { ...entry.peerDependencies };
  }
  if (entry.sideEffects !== undefined) manifest['sideEffects'] = entry.sideEffects;
  if (entry.bin !== undefined) manifest['bin'] = entry.bin;
}

/**
 * Build the complete plan for one target: manifests, distributable surfaces, build wiring and
 * TypeScript configuration, with both gates evaluated but not enforced.
 *
 * Enforcement is the caller's, so a sync can report every problem in one pass instead of stopping
 * at the first package. `assertPublishable` is the one call that turns the findings into a failure.
 */
export async function planSurface(options: PlanOptions): Promise<SurfacePlan> {
  const manifestPlan = await planManifests(options);
  const surface = await loadPackageSurface();
  const baseline = await loadRegistryBaseline();
  const root = (await Bun.file(join(options.corvidaeRoot, 'package.json')).json()) as JsonObject;
  const catalog = isJsonObject(root['catalog']) ? (root['catalog'] as Record<string, string>) : {};
  const targetHasCatalog = targetCanHoldCatalog(options.target);

  const components = await discoverComponents();

  const parity: ParityResult[] = [];
  const coverage: CoverageFinding[] = [];
  const published: PublishedPackage[] = [];
  const privateWorkspaces: PrivateWorkspace[] = [];
  const files = { ...manifestPlan.files };
  const emittedWorkspaces: EmittedWorkspace[] = [];

  for (const workspace of manifestPlan.emitted) {
    const disposition = await dispositionFor(workspace.workspace, options.packageMap);
    if (disposition.disposition === 'exclude') continue;

    const path = `${workspace.targetDirectory}/package.json`;
    const serialized = files[path];
    if (serialized === undefined) continue;

    const entry = surface.packages[workspace.workspace];
    if (entry === undefined) {
      // A private workspace never reaches a tarball, so it keeps corvidae's source `exports`.
      if (disposition.disposition === 'private-workspace') {
        emittedWorkspaces.push(workspace);
        privateWorkspaces.push({
          workspace: workspace.workspace,
          directory: workspace.targetDirectory,
          publicName: publicNameFor(workspace.workspace, disposition),
          typechecks: hasTypecheckScript(JSON.parse(serialized) as JsonObject),
          emitsTypeScript: false,
        });
        continue;
      }
      throw new ManifestTransformError(
        `${workspace.workspace} publishes as ${disposition.name} but package-surface.json carries no exports, files or build for it`,
      );
    }

    emittedWorkspaces.push({ ...workspace, entry });
    const packageRoot = join(options.corvidaeRoot, workspace.corvidaeDirectory);
    const manifest = JSON.parse(serialized) as JsonObject;
    const existing = await readExistingManifest(options.targetDirectory, path);
    const resolved = resolveSurface({
      entry,
      packageRoot,
      components,
      // The target's own map, not the emitted one. The generator consults it only to preserve a
      // legacy flat subpath, and corvidae's `{".": "./src/index.ts"}` can never carry one — so
      // reading the emitted manifest here would make that pass permanently inert.
      existingExports: readExports(existing),
    });

    applySurfaceToManifest(manifest, entry, resolved.exports, resolved.files, existing);
    applyToolchain(manifest, entry.build.toolchain, catalog, targetHasCatalog, workspace.workspace);
    files[path] = await serializeJson(manifest, options.targetDirectory, path);

    published.push({
      workspace: workspace.workspace,
      directory: workspace.targetDirectory,
      publicName: resolved.publicName,
      entry,
      exports: resolved.exports,
      files: resolved.files,
      version: manifestVersion(manifest, resolved.publicName),
      // Filled once the loop knows the whole published set; see below.
      dependsOn: [],
    });

    parity.push(checkParity(baseline, resolved.publicName, resolved.exports));
    coverage.push(
      ...checkTargetCoverage({
        publicName: resolved.publicName,
        exports: resolved.exports,
        files: resolved.files,
        sourceRoot: entry.build.sourceRoot,
        packageRoot,
        bin: resolved.bin,
      }),
    );
  }

  // COR-1289: narrow the transform's own intra-target edges to the edges between published
  // packages. Deferred until the loop is done for the same reason `emitsTypeScript` is below —
  // a package's dependency can be discovered after the package itself, which is the whole defect
  // being fixed, so the published set is only complete once every workspace has been walked.
  const publishedNames = new Set(published.map((entry) => entry.publicName));
  for (const entry of published) {
    entry.dependsOn = (manifestPlan.intraTargetEdges.get(entry.workspace) ?? []).filter((name) =>
      publishedNames.has(name),
    );
  }

  const typescript = await planTypeScriptConfiguration({
    corvidaeRoot: options.corvidaeRoot,
    target: options.target,
    workspaces: emittedWorkspaces,
    targetDirectory: options.targetDirectory,
    policy: options.policy,
  });
  assertTypeScriptEdgeClosed(manifestPlan.droppedEdges, typescript);

  const source = await planSource(options.corvidaeRoot, emittedWorkspaces, options.targetDirectory);
  // COR-1192: the exported version literal follows the composed manifest's `version`, which
  // `published` has just resolved, so tag, manifest and `VERSION` agree at every sync.
  applyVersionConstants(source.files, published);
  for (const entry of privateWorkspaces) {
    entry.emitsTypeScript = source.typeScriptWorkspaces.includes(entry.workspace);
  }
  assertSingleOwner([
    { owner: 'manifests', paths: Object.keys(files) },
    { owner: 'typescript-configuration', paths: Object.keys(typescript.files) },
    { owner: 'source', paths: Object.keys(source.files) },
  ]);

  // COR-1286: the one transform-emitted verification workflow. It is not manifest, TypeScript-
  // config or source-tree output — it is generated straight from `published`/`privateWorkspaces`,
  // which this function has just finished computing — and, unlike those three producers, it needs
  // a real clone: it reads the target's own release workflow for the Bun version and install line
  // to match (`renderMirrorVerifyWorkflow`). `options.targetDirectory` is optional (`committed-
  // plans.ts` plans both targets with none, for `surface.test.ts`/`source.test.ts`/`target-
  // resolvability.test.ts`'s own assertions about the committed tree, against no clone at all), so
  // this is conditional rather than unconditional the way the other three are: a plan with nothing
  // to read the release workflow from emits no verification workflow to pair with it, exactly as
  // it emits nothing else that depends on comparing against an existing target file.
  const mirrorVerifyWorkflow =
    options.targetDirectory === undefined
      ? undefined
      : await renderMirrorVerifyWorkflow({
          targetDirectory: options.targetDirectory,
          bunLockPath: join(options.corvidaeRoot, 'bun.lock'),
          published,
          privateWorkspaces,
        });
  const merged = {
    ...files,
    ...typescript.files,
    ...source.files,
    // `target-owned.json`'s narrowed `.github/**` enumeration never claims this path, by
    // construction: every entry there names a specific release-adjacent filename, and
    // `.github/workflows/mirror-verify.yaml` is not one of them.
    ...(mirrorVerifyWorkflow === undefined
      ? {}
      : { '.github/workflows/mirror-verify.yaml': mirrorVerifyWorkflow }),
  };
  // Over the merged set rather than the source half alone: a specifier that names a manifest or a
  // tsconfig is satisfied by the other two producers, and the question the gate asks is whether
  // the *target* can resolve it, not which half of the transform wrote it.
  assertNoSourceEscapes(merged);

  return {
    ...manifestPlan,
    files: merged,
    parity,
    coverage,
    typescript,
    published,
    privateWorkspaces,
    source,
  };
}

/** Whether an emitted manifest declares the script `verifyTarget` runs over a private workspace. */
function hasTypecheckScript(manifest: JsonObject): boolean {
  const scripts = manifest['scripts'];
  return isJsonObject(scripts) && typeof scripts['typecheck'] === 'string';
}

/**
 * A published manifest's `version`, failing loudly rather than publishing an undefined one.
 *
 * `target-owned.json`'s `insideFiles` policy never overlays `version` — `manifests.ts` always
 * resolves it before `planSurface` reaches this manifest, to the target's own preserved version,
 * to `0.0.0` on a fresh target, or to `package-map.json`'s `lastPublishedVersion` on a seeded
 * first publish — so a manifest reaching here without a string `version` is a manifest pipeline
 * defect, not a case this function is meant to paper over with a fallback.
 */
function manifestVersion(manifest: JsonObject, publicName: string): string {
  const version = manifest['version'];
  if (typeof version !== 'string' || version.length === 0) {
    throw new ManifestTransformError(
      `${publicName}'s emitted manifest has no string \`version\`; manifests.ts's composeManifest is expected to resolve one before planSurface writes the manifest.`,
    );
  }
  return version;
}

/**
 * A coverage finding that upstream's own packaging explains rather than a defect.
 *
 * The four packages in the cinder repository stage their tarball through
 * `scripts/pack-for-publish.ts`, which rewrites every source condition to its `dist` equivalent
 * before packing. Their repository manifests therefore point at `src/` paths the `files`
 * allowlist does not publish, on purpose. Anything else outside the allowlist is a real defect.
 */
export function isExpectedPackRewrite(
  finding: CoverageFinding,
  entry: PackageSurfaceEntry,
): boolean {
  if (finding.problem !== 'not-shipped') return false;
  if (entry.build.packedBy !== 'pack-script') return false;
  return finding.target.startsWith(`./${entry.build.sourceRoot}/`);
}

export class SurfaceError extends Error {}

/** Findings the packaging does not explain, keyed by public name for message stability. */
export function unresolvedFindings(
  plan: SurfacePlan,
  entries: Readonly<Record<string, PackageSurfaceEntry>>,
): CoverageFinding[] {
  const byPublicName = new Map(
    Object.values(entries).map((entry) => [entry.publicName, entry] as const),
  );
  return plan.coverage.filter((finding) => {
    const entry = byPublicName.get(finding.publicName);
    return entry === undefined || !isExpectedPackRewrite(finding, entry);
  });
}

/** `publicName subpath` for each unresolved finding, deduplicated and sorted. */
export function unresolvedSubpaths(findings: readonly CoverageFinding[]): string[] {
  return [
    ...new Set(findings.map((finding) => `${finding.publicName} ${finding.subpath}`)),
  ].toSorted();
}

/**
 * Refuse to publish a plan that narrows a published surface or points at something that cannot
 * ship. Both halves throw rather than warn: a subpath that disappears is a broken import for
 * somebody, and a subpath whose source is gone is a broken import that the build cannot even warn
 * about. Every offender is named in one message so a sync reports the whole problem at once.
 */
export function assertPublishable(
  plan: SurfacePlan,
  entries: Readonly<Record<string, PackageSurfaceEntry>>,
): void {
  const lines: string[] = [];
  const narrowed = plan.parity.filter((result) => result.missing.length > 0);
  if (narrowed.length > 0) {
    lines.push('These packages drop published subpaths:');
    for (const result of narrowed) {
      lines.push(
        `  ${result.publicName} (${result.baselineVersion}): ${result.missing.join(', ')}`,
      );
    }
  }
  const unresolved = unresolvedFindings(plan, entries);
  if (unresolved.length > 0) {
    lines.push('These exports targets cannot be shipped from this checkout:');
    for (const finding of unresolved) {
      lines.push(
        finding.problem === 'not-shipped'
          ? `  ${finding.publicName} ${finding.subpath} [${finding.condition}] -> ${finding.target}: no files entry publishes it`
          : `  ${finding.publicName} ${finding.subpath} [${finding.condition}] -> ${finding.target}: no source at ${finding.sourcePath}`,
      );
    }
  }
  if (lines.length > 0) throw new SurfaceError(lines.join('\n'));
}
