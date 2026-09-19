import { join } from 'node:path';

import { discoverComponents } from '../../components/cinder/scripts/lib/discover-components.ts';
import {
  discoverWorkspaces,
  ManifestTransformError,
  planManifests,
  targetFor,
  type ManifestPlan,
  type PlanOptions,
} from './manifests.ts';
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
 * Nothing here writes. `stageTarget` in `manifests.ts` is still what puts a plan on disk, and the
 * target-owned guard still runs over the whole file set before any of it lands.
 */

type JsonObject = Record<string, unknown>;

export interface SurfacePlan extends ManifestPlan {
  /** One result per published package, including the ones with no published predecessor. */
  parity: ParityResult[];
  /** Every exports target that cannot be shipped or has no source. Empty is the goal, not a given. */
  coverage: CoverageFinding[];
  typescript: TypeScriptPlan;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serialize(manifest: JsonObject): string {
  return `${JSON.stringify(manifest, undefined, 2)}\n`;
}

/**
 * Merge the build toolchain into a manifest's `devDependencies`.
 *
 * A `catalog:` value only survives in a target that has a workspace root to hold a catalog, which
 * is the same rule `manifests.ts` applies to corvidae's own specifiers; in the single-package weft
 * target it is inlined from corvidae's root catalog instead.
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
async function readTargetExports(
  targetDirectory: string | undefined,
  path: string,
): Promise<SurfaceExportsMap | undefined> {
  if (targetDirectory === undefined) return undefined;
  const file = Bun.file(join(targetDirectory, path));
  if (!(await file.exists())) return undefined;
  const manifest = (await file.json()) as JsonObject;
  const exports = manifest['exports'];
  return isJsonObject(exports) ? (exports as SurfaceExportsMap) : undefined;
}

function applySurfaceToManifest(
  manifest: JsonObject,
  entry: PackageSurfaceEntry,
  exports: SurfaceExportsMap,
  files: readonly string[],
): void {
  for (const [key, value] of Object.entries(entry.manifestFields)) manifest[key] = value;
  manifest['exports'] = exports;
  manifest['files'] = [...files];
  const scripts = isJsonObject(manifest['scripts'])
    ? (manifest['scripts'] as Record<string, string>)
    : {};
  manifest['scripts'] = { ...scripts, ...entry.build.scripts };
  if (entry.peerDependencies) manifest['peerDependencies'] = { ...entry.peerDependencies };
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
  const targetHasCatalog = options.target === 'cinder';

  const workspaces = await discoverWorkspaces(options.corvidaeRoot);
  const emitted = workspaces.filter((workspace) => targetFor(workspace.name) === options.target);
  const components = await discoverComponents();

  const parity: ParityResult[] = [];
  const coverage: CoverageFinding[] = [];
  const files = { ...manifestPlan.files };
  const directories: string[] = [];

  for (const workspace of emitted) {
    const disposition = await dispositionFor(workspace.name);
    if (disposition.disposition === 'exclude') continue;
    directories.push(workspace.directory);

    const path = `${workspace.directory}/package.json`;
    const serialized = files[path];
    if (serialized === undefined) continue;

    const entry = surface.packages[workspace.name];
    if (entry === undefined) {
      // A private workspace never reaches a tarball, so it keeps corvidae's source `exports`.
      if (disposition.disposition === 'private-workspace') continue;
      throw new ManifestTransformError(
        `${workspace.name} publishes as ${disposition.name} but package-surface.json carries no exports, files or build for it`,
      );
    }

    const packageRoot = join(options.corvidaeRoot, workspace.directory);
    const manifest = JSON.parse(serialized) as JsonObject;
    const resolved = resolveSurface({
      entry,
      packageRoot,
      components,
      // The target's own map, not the emitted one. The generator consults it only to preserve a
      // legacy flat subpath, and corvidae's `{".": "./src/index.ts"}` can never carry one — so
      // reading the emitted manifest here would make that pass permanently inert.
      existingExports: await readTargetExports(options.targetDirectory, path),
    });

    applySurfaceToManifest(manifest, entry, resolved.exports, resolved.files);
    applyToolchain(manifest, entry.build.toolchain, catalog, targetHasCatalog, workspace.name);
    files[path] = serialize(manifest);

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

  const typescript = await planTypeScriptConfiguration({
    corvidaeRoot: options.corvidaeRoot,
    target: options.target,
    workspaceDirectories: directories,
  });
  assertTypeScriptEdgeClosed(manifestPlan.droppedEdges, typescript);

  return {
    ...manifestPlan,
    files: { ...files, ...typescript.files },
    parity,
    coverage,
    typescript,
  };
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
