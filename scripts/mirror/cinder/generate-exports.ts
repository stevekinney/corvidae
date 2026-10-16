import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  componentEnhancementKey,
  discoverComponentEnhancements,
} from '../../../components/cinder/scripts/lib/component-enhancements.ts';
import type { ComponentDiscovery } from '../../../components/cinder/scripts/lib/discover-components.ts';

/**
 * The emit half of `@lostgradient/cinder`'s exports generator, ported from the public
 * repository's `packages/components/scripts/generate-exports.ts` with the package root taken as
 * a parameter instead of read from `import.meta.dir`.
 *
 * COR-1186 ruled that the mirror transform *regenerates* this map rather than copying it:
 * corvidae's `components/cinder/package.json` keeps its one-line `{".": "./src/index.ts"}`, and
 * the 992-key published map is a description of a build tree corvidae never produces. Porting
 * the generator is the honest cost of that ruling.
 *
 * Discovery is not ported. `components/cinder/scripts/lib/discover-components.ts` already carries
 * upstream's algorithm line for line, so this module takes the discovered components as input and
 * only reproduces what upstream does with them.
 *
 * Fidelity is the whole point, so the structure below deliberately mirrors upstream's: the same
 * function boundaries, the same condition order, the same reserved-entry stitching order, and the
 * same `files` computation. Changing any of it silently narrows a published surface.
 */

export type ExportEntry = {
  types?: string;
  browser?: string;
  svelte?: string;
  bun?: string;
  import?: string;
  node?: string;
  default?: string;
};

/** JSON-only export entry: no `svelte` or `types` conditions. */
export type JsonExportEntry = { import: string; default: string };

export type ExportValue = ExportEntry | JsonExportEntry | string;
export type ExportsMap = Record<string, ExportValue>;

const STYLES_KEY = './styles';
const STYLES_ALL_KEY = './styles/all';
const STYLES_TOKENS_KEY = './styles/tokens';
const STYLES_FOUNDATION_KEY = './styles/foundation';
const STYLES_UTILITIES_KEY = './styles/utilities';
const STYLES_JSON_HIGHLIGHT_KEY = './styles/json-highlight';
const STYLES_GUARD_KEY = './styles/guard';
const ROOT_KEY = '.';
const PACKAGE_JSON_KEY = './package.json';
const ICONS_KEY = './icons';
const HIGHLIGHTERS_SHIKI_KEY = './highlighters/shiki';
const HIGHLIGHTERS_SHIKI_CURATED_KEY = './highlighters/shiki/curated';
const KNOWLEDGE_KEY = './knowledge';

/** Keys the generator owns at the top level but stitches in rather than computing. */
const RESERVED_KEYS = new Set([
  ROOT_KEY,
  STYLES_KEY,
  STYLES_ALL_KEY,
  STYLES_TOKENS_KEY,
  STYLES_FOUNDATION_KEY,
  STYLES_UTILITIES_KEY,
  STYLES_JSON_HIGHLIGHT_KEY,
  STYLES_GUARD_KEY,
  PACKAGE_JSON_KEY,
  ICONS_KEY,
  HIGHLIGHTERS_SHIKI_KEY,
  HIGHLIGHTERS_SHIKI_CURATED_KEY,
  KNOWLEDGE_KEY,
]);

/** The six hand-authored `styles*` subpaths and their canonical CSS targets, base first. */
const RESERVED_STYLES_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  [STYLES_KEY, './src/styles/index.css'],
  [STYLES_ALL_KEY, './src/styles/all.css'],
  [STYLES_TOKENS_KEY, './src/styles/tokens.css'],
  [STYLES_FOUNDATION_KEY, './src/styles/foundation.css'],
  [STYLES_UTILITIES_KEY, './src/styles/utilities.css'],
  [STYLES_JSON_HIGHLIGHT_KEY, './src/styles/json-highlight.css'],
];

/**
 * Reorders an entry into the order TypeScript `nodenext` and the resolver matrix require:
 * `types`, `browser`, `bun`, `svelte`, `node`, `import`, `default`. `svelte` must precede `node`
 * because SvelteKit SSR activates both and conditional exports select the first match.
 */
export function orderedExportEntry(entry: ExportEntry): ExportEntry {
  const out: ExportEntry = {};
  if (entry.types !== undefined) out.types = entry.types;
  if (entry.browser !== undefined) out.browser = entry.browser;
  if (entry.bun !== undefined) out.bun = entry.bun;
  if (entry.svelte !== undefined) out.svelte = entry.svelte;
  if (entry.node !== undefined) out.node = entry.node;
  if (entry.import !== undefined) out.import = entry.import;
  if (entry.default !== undefined) out.default = entry.default;
  return out;
}

/** Canonical `{ types, default }` entry for a reserved styles subpath. */
export function stylesExport(cssPath: string): ExportEntry {
  return orderedExportEntry({ types: `${cssPath}.d.ts`, default: cssPath });
}

/**
 * The root barrel, the only entry whose `node` target is the shared server root.
 *
 * `import` names the same compiled file as `default`. Bun and Node resolve `node`, and bundlers
 * resolve `browser` or `svelte` first, so `import` only reaches generic ESM resolvers. Pointing it
 * at raw source made `import` and `default` disagree, which publint reads as a dual CJS/ESM publish
 * and answers with a demand for CommonJS-shaped types this ESM-only package cannot honestly ship.
 */
export function computeRootExport(): ExportEntry {
  return orderedExportEntry({
    types: './dist/index.d.ts',
    browser: './src/index.ts',
    svelte: './src/index.ts',
    node: './dist/server/index.js',
    import: './dist/index.js',
    default: './dist/index.js',
  });
}

/** The dev-only base-loaded guard module. */
export function stylesGuardExport(): ExportEntry {
  return orderedExportEntry({
    types: './dist/styles/base-guard.d.ts',
    browser: './src/styles/base-guard.ts',
    svelte: './src/styles/base-guard.ts',
    node: './dist/server/styles/base-guard.js',
    import: './src/styles/base-guard.ts',
    default: './dist/styles/base-guard.js',
  });
}

/** The Node-only knowledge-service boundary. Deliberately carries no source condition. */
export function knowledgeExport(): ExportEntry {
  return orderedExportEntry({
    types: './dist/cli/knowledge.d.ts',
    node: './dist/cli/knowledge.js',
    import: './dist/cli/knowledge.js',
    default: './dist/cli/knowledge.js',
  });
}

/** The shared icon barrel. */
function iconsExport(): ExportEntry {
  return orderedExportEntry({
    types: './dist/components/icons/index.d.ts',
    browser: './src/components/icons/index.ts',
    node: './dist/server/components/icons/index.js',
    svelte: './src/components/icons/index.ts',
    import: './src/components/icons/index.ts',
    default: './dist/components/icons/index.js',
  });
}

function highlightersShikiExport(source = 'default'): ExportEntry {
  return orderedExportEntry({
    types: `./dist/highlighters/shiki/${source}.d.ts`,
    browser: `./src/highlighters/shiki/${source}.ts`,
    svelte: `./src/highlighters/shiki/${source}.ts`,
    node: `./dist/server/highlighters/shiki/${source}.js`,
    import: `./src/highlighters/shiki/${source}.ts`,
    default: `./dist/highlighters/shiki/${source}.js`,
  });
}

function componentEnhancementExport(
  name: string,
  srcDir: string,
  distDir: string,
  serverDistDir: string,
): ExportEntry {
  const fileName = `${name}-enhancement`;
  return orderedExportEntry({
    types: `${distDir}/${fileName}.d.ts`,
    browser: `${srcDir}/${fileName}.ts`,
    node: `${serverDistDir}/${fileName}.js`,
    svelte: `${srcDir}/${fileName}.ts`,
    import: `${srcDir}/${fileName}.ts`,
    default: `${distDir}/${fileName}.js`,
  });
}

function manifestExport(): JsonExportEntry {
  return { import: './components.json', default: './components.json' };
}

function jsonSidecarExport(filePath: string): JsonExportEntry {
  return { import: filePath, default: filePath };
}

/**
 * The exports map must never contain a key that looks like a debug, scratch, or test-only
 * subpath. Anchored on `/` boundaries so `./template` and `./testament` are not rejected.
 */
export const FORBIDDEN_EXPORT_KEY_PATTERN =
  /(?:^|\/)(?:__[\w-]*|(?:test|temp|scratch)(?:-[\w-]*)?)(?:\/|$)/i;

export class CinderExportsError extends Error {}

/** Throws on the first forbidden key so a sync fails with a named offender. */
export function assertNoForbiddenExportKeys(
  exportsMap: Readonly<Record<string, unknown>>,
  pattern: RegExp = FORBIDDEN_EXPORT_KEY_PATTERN,
): void {
  for (const key of Object.keys(exportsMap)) {
    if (pattern.test(key)) {
      throw new CinderExportsError(
        `Forbidden exports key "${key}" matches /${pattern.source}/${pattern.flags} — refusing to publish`,
      );
    }
  }
}

export type DeprecatedExperimentalAlias = {
  name: string;
  hasCss: boolean;
  hasExamples: boolean;
};

/**
 * Components promoted out of `src/components/experimental/<name>/` that keep their old
 * `experimental/<name>` import path working through a shim for one major version.
 */
export const DEPRECATED_EXPERIMENTAL_ALIASES: readonly DeprecatedExperimentalAlias[] = [
  { name: 'json-viewer', hasCss: true, hasExamples: false },
  { name: 'message', hasCss: true, hasExamples: false },
];

/**
 * The deprecated alias entries. The component entry resolves to the shim under
 * `src/components/experimental/<name>/`; every metadata subpath resolves to the promoted
 * component's new, non-experimental location.
 */
export function computeDeprecatedExperimentalAliases(
  aliases: readonly DeprecatedExperimentalAlias[] = DEPRECATED_EXPERIMENTAL_ALIASES,
): ExportsMap {
  const out: ExportsMap = {};
  for (const { name, hasCss, hasExamples } of aliases) {
    const aliasPrefix = `./experimental/${name}`;
    const shimSrcDir = `./src/components/experimental/${name}`;
    const shimDistDir = `./dist/components/experimental/${name}`;
    const shimServerDistDir = `./dist/server/components/experimental/${name}`;
    const newSrcDir = `./src/components/${name}`;
    const newDistDir = `./dist/components/${name}`;
    const newServerDistDir = `./dist/server/components/${name}`;

    out[aliasPrefix] = orderedExportEntry({
      types: `${shimDistDir}/index.d.ts`,
      browser: `${shimSrcDir}/index.ts`,
      svelte: `${shimSrcDir}/index.ts`,
      node: `${shimServerDistDir}/index.js`,
      import: `${shimSrcDir}/index.ts`,
      default: `${shimDistDir}/index.js`,
    });
    out[`${aliasPrefix}/schema`] = orderedExportEntry({
      types: `${newDistDir}/${name}.schema.d.ts`,
      browser: `${newSrcDir}/${name}.schema.ts`,
      svelte: `${newSrcDir}/${name}.schema.ts`,
      node: `${newServerDistDir}/${name}.schema.js`,
      import: `${newSrcDir}/${name}.schema.ts`,
      default: `${newDistDir}/${name}.schema.js`,
    });
    out[`${aliasPrefix}/variables`] = orderedExportEntry({
      types: `${newDistDir}/${name}.variables.d.ts`,
      browser: `${newSrcDir}/${name}.variables.ts`,
      svelte: `${newSrcDir}/${name}.variables.ts`,
      node: `${newServerDistDir}/${name}.variables.js`,
      import: `${newSrcDir}/${name}.variables.ts`,
      default: `${newDistDir}/${name}.variables.js`,
    });
    if (hasCss) {
      out[`${aliasPrefix}/styles`] = orderedExportEntry({
        types: `${newDistDir}/${name}.css.d.ts`,
        default: `${newDistDir}/${name}.css`,
      });
    }
    if (hasExamples) {
      out[`${aliasPrefix}/examples`] = jsonSidecarExport(`${newSrcDir}/${name}.examples.json`);
    }
  }
  return out;
}

/** The `*.tokens.json` documents under `src/tokens/`, relative to it, sorted. */
function discoverTokenDocumentPaths(tokensDirectory: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relativePath);
      else if (entry.name.endsWith('.tokens.json')) found.push(relativePath);
    }
  };
  walk(tokensDirectory, '');
  return found.toSorted();
}

/** Every `tokens*` subpath, discovered from what `tokens:generate` wrote rather than hand-listed. */
function tokenExports(packageRoot: string): ExportsMap {
  const out: ExportsMap = {};
  const tokensDirectory = join(packageRoot, 'src', 'tokens');
  if (!existsSync(tokensDirectory)) return out;

  if (existsSync(join(tokensDirectory, 'index.json'))) {
    out['./tokens'] = jsonSidecarExport('./src/tokens/index.json');
  }
  if (existsSync(join(tokensDirectory, 'cinder.resolver.json'))) {
    out['./tokens/resolver'] = jsonSidecarExport('./src/tokens/cinder.resolver.json');
  }
  for (const relativePath of discoverTokenDocumentPaths(tokensDirectory)) {
    const subpath = relativePath.replace(/\.tokens\.json$/, '');
    out[`./tokens/${subpath}`] = jsonSidecarExport(`./src/tokens/${relativePath}`);
  }
  const resolvedDirectory = join(tokensDirectory, 'resolved');
  if (existsSync(resolvedDirectory)) {
    for (const entry of readdirSync(resolvedDirectory).toSorted()) {
      if (!entry.endsWith('.json')) continue;
      out[`./tokens/resolved/${entry.slice(0, -'.json'.length)}`] = jsonSidecarExport(
        `./src/tokens/resolved/${entry}`,
      );
    }
  }
  // The pure token kernel (COR-491). Like the registry it ships source for the `browser`,
  // `svelte` and `import` conditions; its generated validators, base digest and catalogue sit
  // beside it under `src/tokens/runtime/`, which `STATIC_FILES_GLOBS` publishes.
  if (existsSync(join(tokensDirectory, 'runtime', 'index.ts'))) {
    out['./tokens/runtime'] = orderedExportEntry({
      types: './dist/tokens/runtime/index.d.ts',
      browser: './src/tokens/runtime/index.ts',
      node: './dist/server/tokens/runtime/index.js',
      svelte: './src/tokens/runtime/index.ts',
      import: './src/tokens/runtime/index.ts',
      default: './dist/tokens/runtime/index.js',
    });
  }
  if (existsSync(join(tokensDirectory, 'registry.generated.ts'))) {
    out['./tokens/registry'] = orderedExportEntry({
      types: './dist/tokens/registry.generated.d.ts',
      browser: './src/tokens/registry.generated.ts',
      node: './dist/server/tokens/registry.generated.js',
      svelte: './src/tokens/registry.generated.ts',
      import: './src/tokens/registry.generated.ts',
      default: './dist/tokens/registry.generated.js',
    });
  }
  return out;
}

function componentDirectories(
  name: string,
  isExperimental: boolean,
): { srcDir: string; distDir: string; serverDistDir: string } {
  const segment = isExperimental ? `experimental/${name}` : name;
  return {
    srcDir: `./src/components/${segment}`,
    distDir: `./dist/components/${segment}`,
    serverDistDir: `./dist/server/components/${segment}`,
  };
}

/** Every discovered component's subpaths, plus the package-level manifest and token entries. */
export function computeExports(
  components: readonly ComponentDiscovery[],
  packageRoot: string,
): ExportsMap {
  const out: ExportsMap = {};
  const enhancementKeys = new Set(
    discoverComponentEnhancements(components, join(packageRoot, 'src', 'components')).map(
      componentEnhancementKey,
    ),
  );

  out['./manifest'] = manifestExport();
  Object.assign(out, tokenExports(packageRoot));

  for (const { name, isExperimental, hasCss } of components) {
    const prefix = isExperimental ? `./experimental/${name}` : `./${name}`;
    const { srcDir, distDir, serverDistDir } = componentDirectories(name, isExperimental);

    out[prefix] = orderedExportEntry({
      types: `${distDir}/index.d.ts`,
      browser: `${srcDir}/index.ts`,
      svelte: `${srcDir}/index.ts`,
      node: `${serverDistDir}/index.js`,
      import: `${srcDir}/index.ts`,
      default: `${distDir}/index.js`,
    });
    out[`${prefix}/schema`] = orderedExportEntry({
      types: `${distDir}/${name}.schema.d.ts`,
      browser: `${srcDir}/${name}.schema.ts`,
      svelte: `${srcDir}/${name}.schema.ts`,
      node: `${serverDistDir}/${name}.schema.js`,
      import: `${srcDir}/${name}.schema.ts`,
      default: `${distDir}/${name}.schema.js`,
    });
    out[`${prefix}/variables`] = orderedExportEntry({
      types: `${distDir}/${name}.variables.d.ts`,
      browser: `${srcDir}/${name}.variables.ts`,
      svelte: `${srcDir}/${name}.variables.ts`,
      node: `${serverDistDir}/${name}.variables.js`,
      import: `${srcDir}/${name}.variables.ts`,
      default: `${distDir}/${name}.variables.js`,
    });

    // Emitting `/styles` for a component with no source sidecar would publish a dead export.
    if (hasCss) {
      out[`${prefix}/styles`] = orderedExportEntry({
        types: `${distDir}/${name}.css.d.ts`,
        default: `${distDir}/${name}.css`,
      });
    }

    const componentDirectory = join(
      packageRoot,
      'src',
      'components',
      ...(isExperimental ? ['experimental', name] : [name]),
    );
    if (existsSync(join(componentDirectory, `${name}.examples.json`))) {
      out[`${prefix}/examples`] = jsonSidecarExport(`${srcDir}/${name}.examples.json`);
    }
    if (existsSync(join(componentDirectory, `${name}.constraints.json`))) {
      out[`${prefix}/constraints`] = jsonSidecarExport(`${srcDir}/${name}.constraints.json`);
    }
    if (enhancementKeys.has(componentEnhancementKey({ name, isExperimental }))) {
      out[`${prefix}/enhancement`] = componentEnhancementExport(
        name,
        srcDir,
        distDir,
        serverDistDir,
      );
    }
  }
  return out;
}

/**
 * The package-relative source path a legacy entry resolves from, used to test whether its
 * on-disk target still exists. Returns `undefined` for a bare-string entry, in which case the
 * caller preserves the entry conservatively rather than dropping it.
 */
export function legacyEntrySourcePath(entry: ExportValue): string | undefined {
  if (typeof entry === 'string') return undefined;
  const svelte = 'svelte' in entry ? entry.svelte : undefined;
  return svelte ?? entry.default;
}

/**
 * Whether a legacy flat entry survives regeneration. Preserved when its source still exists,
 * dropped when it is gone — which makes the pass self-healing for hides and renames.
 */
export function shouldPreserveLegacyEntry(entry: ExportValue, packageRoot: string): boolean {
  const sourcePath = legacyEntrySourcePath(entry);
  if (!sourcePath) return true;
  return existsSync(join(packageRoot, sourcePath));
}

const FLAT_LEGACY_KEY_PATTERN = /^\.\/(experimental\/)?[a-z][a-z0-9-]*$/;
const METADATA_SUFFIXES = ['/schema', '/variables', '/styles', '/examples', '/constraints'];

function collectLegacyEntries(
  existingExports: ExportsMap,
  computed: ExportsMap,
  components: readonly ComponentDiscovery[],
  packageRoot: string,
): ExportsMap {
  const migratedNames = new Set(
    components.map((component) =>
      component.isExperimental ? `./experimental/${component.name}` : `./${component.name}`,
    ),
  );
  const legacy: ExportsMap = {};
  for (const [key, entry] of Object.entries(existingExports)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (migratedNames.has(key)) continue;
    if (key in computed) continue;
    if (METADATA_SUFFIXES.some((suffix) => key.endsWith(suffix))) continue;
    if (key === './manifest') continue;
    if (!FLAT_LEGACY_KEY_PATTERN.test(key)) continue;
    if (!shouldPreserveLegacyEntry(entry, packageRoot)) continue;
    legacy[key] = entry;
  }
  return legacy;
}

/**
 * The static `files` globs the package always ships, verbatim and in order. The generator
 * preserves these exactly — it never flattens them into hundreds of per-component paths — and
 * appends the computed root-level artifact entries after them.
 */
export const STATIC_FILES_GLOBS: readonly string[] = [
  'dist',
  '!dist/**/*.test.svelte.d.ts',
  '!dist/**/*.spec.svelte.d.ts',
  '!dist/**/*-test.svelte.d.ts',
  '!dist/**/*-test-*.svelte.d.ts',
  '!dist/**/*fixture*.svelte.d.ts',
  '!dist/**/*harness*.svelte.d.ts',
  '!dist/**/__test-helpers__/**/*.svelte.d.ts',
  'src/index.ts',
  'src/exports/**/*.ts',
  'src/schema-types.ts',
  'src/components/**/*.ts',
  '!src/components/**/*-test-helpers.ts',
  '!src/components/**/*-test-support.ts',
  '!src/components/**/*-test-support.svelte.ts',
  '!src/components/**/*-snippet-helpers.ts',
  '!src/components/**/*.test.ts',
  '!src/components/**/*.spec.ts',
  '!src/components/**/*.type-test.ts',
  '!src/components/**/*.fixture.ts',
  '!src/components/**/*-fixture.ts',
  '!src/components/**/*-fixtures.ts',
  '!src/components/**/*fixtures.ts',
  '!src/components/**/test/**',
  'src/components/**/*.svelte',
  '!src/components/**/*.type-test.svelte',
  '!src/components/**/*.test.svelte',
  '!src/components/**/*.spec.svelte',
  '!src/components/**/*-test.svelte',
  '!src/components/**/*fixture*.svelte',
  '!src/components/**/_*-test-harness.svelte',
  '!src/components/**/*harness*.svelte',
  'src/components/**/*.json',
  'src/components/**/*.md',
  '!src/components/**/*.a11y.md',
  'src/components/**/*.css',
  'src/_internal/**/*.ts',
  '!src/_internal/**/*.test.ts',
  '!src/_internal/**/*-test-helpers.ts',
  '!src/_internal/**/*-test-support.ts',
  'src/_internal/**/*.svelte',
  'src/styles/**/*.css',
  'src/styles/**/*.css.d.ts',
  'src/styles/base-guard.ts',
  'src/tokens/**/*.json',
  'src/tokens/registry.generated.ts',
  'src/tokens/runtime/**/*.ts',
  'src/tokens/runtime/**/*.js',
  '!src/tokens/runtime/**/*.test.ts',
  '!src/tokens/runtime/**/*.test-support.ts',
  'src/components/icons/index.ts',
  'src/utilities/**/*.ts',
  '!src/utilities/**/*.test.ts',
  '!src/utilities/**/*-test-helpers.ts',
  '!src/utilities/**/*-test-support.ts',
  'src/highlighters/**/*.ts',
  '!src/highlighters/**/*.test.ts',
  '!src/highlighters/**/*.spec.ts',
  'README.md',
];

/** Root-level JSON artifacts no `dist`/`src/**` glob covers. `package.json` is always published. */
export const EXPLICIT_ROOT_FILE_ENTRIES: readonly string[] = [
  'components.json',
  'examples-exclusions.json',
];

/**
 * Root-level artifact paths the exports map points at. A root-level target has no directory
 * segment after the leading `./`.
 */
export function rootLevelExportTargets(exportsMap: ExportsMap): string[] {
  const out = new Set<string>();
  for (const value of Object.values(exportsMap)) {
    const targets = typeof value === 'string' ? [value] : Object.values(value);
    for (const target of targets) {
      if (typeof target !== 'string') continue;
      if (!target.startsWith('./')) continue;
      const rest = target.slice(2);
      if (rest.length === 0 || rest.includes('/')) continue;
      if (rest === 'package.json') continue;
      out.add(rest);
    }
  }
  return [...out];
}

/**
 * The static globs verbatim, followed by the computed root-level entries in bytewise order —
 * bytewise rather than locale-aware so the generated order is identical on every machine.
 */
export function computeFiles(
  exportsMap: ExportsMap,
  staticGlobs: readonly string[] = STATIC_FILES_GLOBS,
  explicitRootEntries: readonly string[] = EXPLICIT_ROOT_FILE_ENTRIES,
): string[] {
  const computedRoots = new Set<string>(explicitRootEntries);
  for (const target of rootLevelExportTargets(exportsMap)) {
    if (!staticGlobs.includes(target)) computedRoots.add(target);
  }
  const appended = [...computedRoots].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return [...staticGlobs, ...appended];
}

export interface CinderSurfaceOptions {
  /** The cinder package root to read — corvidae's `components/cinder`, or a staged copy of it. */
  packageRoot: string;
  components: readonly ComponentDiscovery[];
  /** The target's existing map, consulted only for the legacy flat-subpath preservation pass. */
  existingExports?: ExportsMap | undefined;
}

export interface CinderSurface {
  exports: ExportsMap;
  files: string[];
}

/**
 * Build cinder's `exports` and `files` in upstream's deterministic order: the root entry, the
 * self-export, the reserved styles entries base-first, the guard, icons, knowledge, the
 * component-owned enhancements at their historical position, the highlighter entries, then the
 * computed component subpaths and finally any preserved legacy flat subpaths.
 */
export function generateCinderSurface({
  packageRoot,
  components,
  existingExports = {},
}: CinderSurfaceOptions): CinderSurface {
  // Surface forbidden keys already on disk before anything is filtered or rewritten, so
  // regeneration cannot silently drop one instead of raising it.
  assertNoForbiddenExportKeys(existingExports);

  const componentComputed = computeExports(components, packageRoot);
  const computed: ExportsMap = {
    ...componentComputed,
    ...computeDeprecatedExperimentalAliases(),
  };
  for (const key of Object.keys(computed)) {
    if (RESERVED_KEYS.has(key)) {
      throw new CinderExportsError(
        `exports collision: computed key "${key}" overlaps a reserved entry`,
      );
    }
  }

  const next: ExportsMap = {};
  next[ROOT_KEY] = computeRootExport();
  next[PACKAGE_JSON_KEY] = './package.json';
  for (const [key, cssPath] of RESERVED_STYLES_ENTRIES) next[key] = stylesExport(cssPath);
  next[STYLES_GUARD_KEY] = stylesGuardExport();
  next[ICONS_KEY] = iconsExport();
  next[KNOWLEDGE_KEY] = knowledgeExport();
  for (const [key, entry] of Object.entries(componentComputed)) {
    if (key.endsWith('/enhancement')) next[key] = entry;
  }
  next[HIGHLIGHTERS_SHIKI_KEY] = highlightersShikiExport();
  next[HIGHLIGHTERS_SHIKI_CURATED_KEY] = highlightersShikiExport('index');
  for (const [key, entry] of Object.entries(computed)) next[key] = entry;
  for (const [key, entry] of Object.entries(
    collectLegacyEntries(existingExports, computed, components, packageRoot),
  )) {
    next[key] = entry;
  }

  assertNoForbiddenExportKeys(next);
  return { exports: next, files: computeFiles(next) };
}
