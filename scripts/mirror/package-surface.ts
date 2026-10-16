import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { z } from 'zod';

import type { ComponentDiscovery } from '../../components/cinder/scripts/lib/discover-components.ts';
import { generateCinderSurface, type ExportsMap } from './cinder/generate-exports.ts';

/**
 * The distributable surface half of the mirror transform: the `exports` map, the `files`
 * allowlist and the build wiring each published workspace receives downstream.
 *
 * Corvidae carries none of these by design — `scripts/workspace-contract.test.ts` pins every
 * library's `exports` to `{".": "./src/index.ts"}` and forbids build scripts — so they are
 * vendored verbatim from the upstream manifests in `package-surface.json` rather than rewritten
 * from intuition. Cinder is the exception COR-1186 ruled on: its 992-key map is regenerated.
 *
 * Two checks live here because they are the ones that can be answered from a corvidae checkout
 * alone. Surface parity against the registry is a different question and lives in
 * `registry-baseline.ts`.
 */

const surfaceFile = new URL('./package-surface.json', import.meta.url);

export class PackageSurfaceError extends Error {}

const generatorMarker = z.object({ generator: z.literal('cinder') });

/**
 * An exports target, in every shape npm allows. Conditions nest (weft's root entry carries a
 * `bun` object holding its own `types` and `default`), an array is a fallback list, and `null`
 * deliberately blocks a condition — conversationalist uses `"browser": null` to keep two subpaths
 * out of browser bundles. A checker that assumed a flat string map would crash on all three.
 */
export type ExportTarget = string | null | ExportTarget[] | { [condition: string]: ExportTarget };
export type SurfaceExportsMap = Record<string, ExportTarget>;

const exportTargetSchema: z.ZodType<ExportTarget> = z.lazy(() =>
  z.union([
    z.string().min(1),
    z.null(),
    z.array(exportTargetSchema),
    z.record(z.string().min(1), exportTargetSchema),
  ]),
);

const packageEntrySchema = z.object({
  publicName: z.string().min(1),
  provenance: z.object({
    repository: z.string().min(1).nullable(),
    path: z.string().min(1).nullable(),
    commit: z.string().min(1).nullable(),
    version: z.string().min(1).nullable(),
    note: z.string().min(1).optional(),
  }),
  exports: z.union([generatorMarker, z.record(z.string().min(1), exportTargetSchema)]),
  files: z.union([generatorMarker, z.array(z.string().min(1)).min(1)]),
  build: z.object({
    scripts: z.record(z.string().min(1), z.string().min(1)),
    toolchain: z.record(z.string().min(1), z.string().min(1)),
    requiredInputs: z.array(z.string().min(1)),
    sourceRoot: z.string().min(1),
    packedBy: z.enum(['files', 'pack-script']),
  }),
  peerDependencies: z.record(z.string().min(1), z.string().min(1)).optional(),
  sideEffects: z.union([z.boolean(), z.array(z.string().min(1))]).optional(),
  bin: z.union([z.string().min(1), z.record(z.string().min(1), z.string().min(1))]).optional(),
  /** Top-level keys a published package needs beyond `exports`; see the document's documentation. */
  manifestFields: z.record(z.string().min(1), z.unknown()),
});

const packageSurfaceSchema = z.object({
  documentation: z.string().min(1),
  build: z.object({ policy: z.string().min(1) }),
  packages: z.record(z.string().min(1), packageEntrySchema),
  openQuestions: z.array(z.string().min(1)),
});

export type PackageSurfaceDocument = z.infer<typeof packageSurfaceSchema>;
export type PackageSurfaceEntry = z.infer<typeof packageEntrySchema>;

let cached: PackageSurfaceDocument | undefined;

export async function loadPackageSurface(
  source: URL | string = surfaceFile,
): Promise<PackageSurfaceDocument> {
  if (cached && source === surfaceFile) return cached;
  const parsed = packageSurfaceSchema.safeParse(await Bun.file(source).json());
  if (!parsed.success) {
    throw new PackageSurfaceError(
      `package-surface.json is malformed:\n${z.prettifyError(parsed.error)}`,
    );
  }
  if (source === surfaceFile) cached = parsed.data;
  return parsed.data;
}

function isGeneratorMarker(value: unknown): value is { generator: 'cinder' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { generator?: unknown }).generator === 'cinder'
  );
}

export interface ResolvedSurface {
  publicName: string;
  exports: SurfaceExportsMap;
  files: string[];
  build: PackageSurfaceEntry['build'];
  peerDependencies?: Record<string, string> | undefined;
  sideEffects?: boolean | string[] | undefined;
  bin?: string | Record<string, string> | undefined;
  manifestFields: Readonly<Record<string, unknown>>;
}

export interface ResolveOptions {
  entry: PackageSurfaceEntry;
  /** The workspace directory the surface describes, used by the cinder generator. */
  packageRoot: string;
  /** Required whenever the entry is generated; ignored otherwise. */
  components?: readonly ComponentDiscovery[] | undefined;
  /** The target's current map, consulted only by the generator's legacy-subpath pass. */
  existingExports?: SurfaceExportsMap | undefined;
}

/** The literal surface, or the generated one for the entry COR-1186 put under a generator. */
export function resolveSurface({
  entry,
  packageRoot,
  components,
  existingExports,
}: ResolveOptions): ResolvedSurface {
  const generated = isGeneratorMarker(entry.exports) || isGeneratorMarker(entry.files);
  if (!generated) {
    return {
      publicName: entry.publicName,
      exports: entry.exports,
      files: entry.files as string[],
      build: entry.build,
      peerDependencies: entry.peerDependencies,
      sideEffects: entry.sideEffects,
      bin: entry.bin,
      manifestFields: entry.manifestFields,
    };
  }
  if (components === undefined) {
    throw new PackageSurfaceError(
      `${entry.publicName} has a generated surface but no discovered components were supplied`,
    );
  }
  const surface = generateCinderSurface({
    packageRoot,
    components,
    existingExports: existingExports as ExportsMap | undefined,
  });
  return {
    publicName: entry.publicName,
    exports: surface.exports,
    files: surface.files,
    build: entry.build,
    peerDependencies: entry.peerDependencies,
    sideEffects: entry.sideEffects,
    bin: entry.bin,
    manifestFields: entry.manifestFields,
  };
}

/**
 * Whether npm's `files` allowlist would publish one package-relative path.
 *
 * npm applies the list in order and lets a later pattern override an earlier one, so a `!`
 * negation only removes what precedes it. A bare directory or path entry publishes that path and
 * everything beneath it, which is why each pattern is tried both literally and as a `/**` prefix.
 */
export function filesCoverPath(files: readonly string[], path: string): boolean {
  let included = false;
  for (const pattern of files) {
    const negated = pattern.startsWith('!');
    const glob = negated ? pattern.slice(1) : pattern;
    if (!matchesGlob(glob, path)) continue;
    included = !negated;
  }
  return included;
}

function matchesGlob(glob: string, path: string): boolean {
  if (new Bun.Glob(glob).match(path)) return true;
  if (glob.includes('*')) return false;
  return new Bun.Glob(`${glob.replace(/\/$/, '')}/**`).match(path);
}

/** Strip the leading `./` an exports target always carries. */
function packageRelative(target: string): string {
  return target.startsWith('./') ? target.slice(2) : target;
}

/** The source extension a build output came from. A `.css.d.ts` stub is emitted beside its CSS. */
function sourceExtensionFor(path: string): string {
  if (path.endsWith('.css.d.ts')) return path.slice(0, -'.d.ts'.length);
  // A dual-format build emits `.d.cts` beside `.d.ts` (and `.d.mts` where the ESM half is
  // disambiguated) from the same single `.ts` source, so all three map back to it.
  if (path.endsWith('.d.cts') || path.endsWith('.d.mts')) {
    return `${path.slice(0, -'.d.cts'.length)}.ts`;
  }
  if (path.endsWith('.d.ts')) return `${path.slice(0, -'.d.ts'.length)}.ts`;
  if (path.endsWith('.cjs') || path.endsWith('.mjs') || path.endsWith('.js')) {
    return `${path.slice(0, path.lastIndexOf('.'))}.ts`;
  }
  return path;
}

/**
 * Every source file a build could plausibly compile into one target, in the order a resolver
 * would try them. A target passes the check when any one of them exists.
 *
 * Several candidates rather than one because the mapping is genuinely ambiguous. `dist/X.js` may
 * come from `X.ts` or from `X/index.ts`. `dist/server/X.js` is cinder's SSR mirror of `dist/X.js`,
 * built from the same source, but it is also weft's genuine `src/server/X` — so both readings are
 * offered and either one existing is enough. A wildcard target resolves to nothing checkable and
 * yields no candidates at all.
 */
export function sourceCandidatesForTarget(target: string, sourceRoot: string): string[] {
  const relative = packageRelative(target);
  if (relative.includes('*')) return [];
  if (relative === 'package.json' || !relative.includes('/')) return [relative];
  if (relative.startsWith('src/')) return [relative];
  if (!relative.startsWith('dist/')) return [];

  const withoutDist = relative.slice('dist/'.length);
  const tails = [withoutDist];
  if (withoutDist.startsWith('server/')) tails.push(withoutDist.slice('server/'.length));

  const candidates: string[] = [];
  for (const tail of tails) {
    const source = sourceExtensionFor(tail);
    candidates.push(`${sourceRoot}/${source}`);
    const extension = source.slice(source.lastIndexOf('.'));
    candidates.push(`${sourceRoot}/${source.slice(0, -extension.length)}/index${extension}`);
  }
  return candidates;
}

/**
 * Every concrete file an exports value can resolve to, paired with the condition path that
 * reaches it — `bun.default` for a nested condition, `browser[1]` for a fallback array element.
 * A `null` target yields nothing: it blocks a condition rather than naming a file.
 */
export function flattenExportTarget(
  value: ExportTarget,
  condition = 'default',
): [string, string][] {
  if (value === null) return [];
  if (typeof value === 'string') return [[condition, value]];
  if (Array.isArray(value)) {
    return value.flatMap((element, index) =>
      flattenExportTarget(element, `${condition}[${index}]`),
    );
  }
  return Object.entries(value).flatMap(([nested, element]) =>
    flattenExportTarget(element, condition === 'default' ? nested : `${condition}.${nested}`),
  );
}

export type CoverageProblem = 'not-shipped' | 'no-source';

export interface CoverageFinding {
  publicName: string;
  subpath: string;
  condition: string;
  target: string;
  problem: CoverageProblem;
  /** The source path that was looked for, when the problem is a missing source. */
  sourcePath?: string | undefined;
}

export interface CoverageOptions {
  publicName: string;
  exports: SurfaceExportsMap;
  files: readonly string[];
  sourceRoot: string;
  /** The checkout the source must exist in. */
  packageRoot: string;
  /**
   * The `bin` field, checked alongside the exports targets. A published binary is a path into the
   * same build output and fails the same two ways, so leaving it out would let a manifest ship an
   * executable entry pointing at a file the build cannot produce.
   */
  bin?: string | Record<string, string> | undefined;
}

/**
 * Every exports target that either the `files` allowlist would not publish or that no source in
 * the checkout could produce.
 *
 * Both halves matter and they fail differently. A target outside `files` resolves in the
 * repository and 404s from the registry. A target with no source is a subpath the build cannot
 * fill, which is how a consolidation that dropped a file surfaces here rather than at install
 * time.
 */
export function checkTargetCoverage({
  publicName,
  exports,
  files,
  sourceRoot,
  packageRoot,
  bin,
}: CoverageOptions): CoverageFinding[] {
  const findings: CoverageFinding[] = [];
  for (const [subpath, value] of Object.entries(binEntries(bin))) {
    exports = { ...exports, [subpath]: value };
  }
  for (const [subpath, value] of Object.entries(exports)) {
    for (const [condition, target] of flattenExportTarget(value)) {
      const relative = packageRelative(target);
      // npm always publishes the manifest and no build produces it, so the self-export is
      // outside both halves of this check rather than exempt from one of them.
      if (relative === 'package.json') continue;
      if (!filesCoverPath(files, relative)) {
        findings.push({ publicName, subpath, condition, target, problem: 'not-shipped' });
        continue;
      }
      const candidates = sourceCandidatesForTarget(target, sourceRoot);
      if (candidates.length === 0) continue;
      if (candidates.some((candidate) => existsSync(join(packageRoot, candidate)))) continue;
      findings.push({
        publicName,
        subpath,
        condition,
        target,
        problem: 'no-source',
        sourcePath: candidates.join(' or '),
      });
    }
  }
  return findings;
}

/**
 * The `bin` field as pseudo-subpaths, so one walker covers both. A binary's target is not relative
 * by convention (weft writes `dist/cli-main.js`, cinder writes `./dist/cli/index.js`), so it is
 * normalized here rather than in the resolver.
 */
function binEntries(bin: string | Record<string, string> | undefined): SurfaceExportsMap {
  if (bin === undefined) return {};
  const asRelative = (target: string): string => (target.startsWith('./') ? target : `./${target}`);
  if (typeof bin === 'string') return { 'bin:.': asRelative(bin) };
  return Object.fromEntries(
    Object.entries(bin).map(([name, target]) => [`bin:${name}`, asRelative(target)]),
  );
}

/** One line per finding, grouped by subpath, suitable for a failure message. */
export function describeCoverage(findings: readonly CoverageFinding[]): string {
  return findings
    .map((finding) =>
      finding.problem === 'not-shipped'
        ? `${finding.publicName} ${finding.subpath} [${finding.condition}] -> ${finding.target}: no files entry publishes it`
        : `${finding.publicName} ${finding.subpath} [${finding.condition}] -> ${finding.target}: no source at ${finding.sourcePath}`,
    )
    .join('\n');
}

/** The files a build command reads that corvidae does not carry, missing from a target clone. */
export function missingBuildInputs(
  entry: PackageSurfaceEntry,
  targetPackageDirectory: string,
): string[] {
  return entry.build.requiredInputs.filter(
    (input) => !existsSync(join(targetPackageDirectory, input)),
  );
}

export interface ImportGraphFinding {
  publicName: string;
  subpath: string;
  /** The source file the subpath's export target names. */
  entry: string;
  /** What the entry's import graph reaches: a package-relative path, or a bare package name. */
  reached: string;
  importedBy: string;
  problem: 'not-shipped' | 'undeclared-dependency';
}

export interface ImportGraphOptions {
  publicName: string;
  exports: SurfaceExportsMap;
  files: readonly string[];
  packageRoot: string;
  /** Dependencies the published manifest declares; a bare import must be one of them. */
  dependencies: ReadonlySet<string>;
  /** Limit the check to these subpaths. Defaults to every export. */
  subpaths?: readonly string[];
}

const importSpecifier =
  /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*|\bexport\s+\*\s+from\s+)['"]([^'"]+)['"]/g;

/** The package name of a bare specifier (`@scope/name/sub` -> `@scope/name`). */
function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier);
}

function resolveRelative(
  packageRoot: string,
  importer: string,
  specifier: string,
): string | undefined {
  const base = normalize(join(dirname(importer), specifier));
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(join(packageRoot, candidate))) return candidate;
  }
  return undefined;
}

/**
 * Whether everything a subpath's source entry imports is actually published.
 *
 * `checkTargetCoverage` asks whether the file an export names is shipped. An entry that is
 * shipped but imports a module no `files` entry covers resolves in the repository and fails from
 * the registry, one edge further out. This walks each source entry's relative imports (including
 * JSON imported with an attribute) and reports a reached file `files` does not publish, and a
 * bare import the manifest does not declare as a dependency. `node:` and `bun:` specifiers are
 * never allowed to hide here: they are not packages, so they count as undeclared.
 */
export function checkPublishedImportGraph(options: ImportGraphOptions): ImportGraphFinding[] {
  const findings: ImportGraphFinding[] = [];
  const wanted = options.subpaths === undefined ? undefined : new Set(options.subpaths);
  for (const [subpath, value] of Object.entries(options.exports)) {
    if (wanted !== undefined && !wanted.has(subpath)) continue;
    const entries = new Set(
      flattenExportTarget(value)
        .map(([, target]) => packageRelative(target))
        .filter((relative) => /^src\/.*\.(?:ts|js|mjs)$/.test(relative)),
    );
    for (const entry of entries) {
      const seen = new Set<string>();
      const queue = [entry];
      for (let head = 0; head < queue.length; head++) {
        const file = queue[head]!;
        if (seen.has(file)) continue;
        seen.add(file);
        if (!/\.(?:ts|js|mjs)$/.test(file)) continue;
        const text = readFileSync(join(options.packageRoot, file), 'utf8');
        for (const match of text.matchAll(importSpecifier)) {
          const specifier = match[1]!;
          if (specifier.startsWith('.')) {
            const resolved = resolveRelative(options.packageRoot, file, specifier);
            if (resolved === undefined) continue;
            if (!filesCoverPath(options.files, resolved)) {
              findings.push({
                publicName: options.publicName,
                subpath,
                entry,
                reached: resolved,
                importedBy: file,
                problem: 'not-shipped',
              });
              continue;
            }
            queue.push(resolved);
          } else if (!options.dependencies.has(packageNameOf(specifier))) {
            findings.push({
              publicName: options.publicName,
              subpath,
              entry,
              reached: packageNameOf(specifier),
              importedBy: file,
              problem: 'undeclared-dependency',
            });
          }
        }
      }
    }
  }
  return findings;
}
