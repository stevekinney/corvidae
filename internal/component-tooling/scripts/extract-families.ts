/**
 * Extracts packages from Cinder's core into workspaces of their own (P-COR-101: COR-2083 tokens,
 * COR-2084 foundation, COR-2087 to COR-2091 the family layers), as `families.json` places them.
 *
 * ```sh
 * bun internal/component-tooling/scripts/extract-families.ts --package tokens [--dry-run]
 * bun internal/component-tooling/scripts/extract-families.ts --package foundation
 * bun internal/component-tooling/scripts/extract-families.ts --layer 1 --half 1   # COR-2087
 * bun internal/component-tooling/scripts/extract-families.ts --layer 1 --half 2   # COR-2088
 * bun internal/component-tooling/scripts/extract-families.ts --layer 2            # COR-2089
 * bun internal/component-tooling/scripts/extract-families.ts --all                # every package left
 * ```
 *
 * `--layer` counts the way `families.json` does: layer 0 is tokens, foundation and the tooling, so
 * the issues' "layer 0 families" are `--layer 1`, their "layer 1" is `--layer 2`, and so on.
 * `--core <dir>` names core's directory (default: `components/core`, which COR-2082's rename
 * creates; extraction runs after it);
 * `--no-install` skips `bun install`; `--dry-run` prints the plan and writes nothing.
 *
 * For each selected package it creates the workspace with `create-package`, moves the package's
 * files to the same path under `components/<package>` (`split-layout.ts`), rewrites every import
 * that now crosses a package to a package specifier, every relative path string that does to a
 * path that still reaches its file, and every `<core>/src/…` path in the repository's text files;
 * moves core's barrel statements that re-export the package into the package's barrel, leaving
 * core re-exporting the same names; regenerates core's `components.css` from
 * `components-css-order.json` (created from today's order on the first run); writes each package's
 * dependencies, exports and scripts; shards the inherited-key-reads allowlist; and stages the
 * result. It is idempotent: a file already moved is skipped, a statement already moved stays, and
 * a second run with the same selection changes nothing; a file a newer map places elsewhere (a test
 * that moved to core) moves there on the next run.
 *
 * A package moves only once everything its files import has, tests and fixtures included: a family
 * whose fixture mounts a family of a higher layer is deferred (and named) until that family moves,
 * and `--layer N` takes every lower-layer package still in core. `--package` refuses instead. It
 * refuses to run while `families.json` is stale: run `derive-families.ts` first and commit the diff.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { parseArgs } from 'node:util';

import ts from 'typescript';

import {
  coreExportTargets,
  coreNamedImports,
  type CoreNamedImport,
  type ExportTarget,
  type ModuleReader,
} from './core-exports.ts';
import { createPackage, packageManifest } from './create-package.ts';
import {
  type DerivedFamilies,
  type FamilyRules,
  deriveFromRepository,
  EXAMPLE_FILE,
  FAMILIES_PATH,
  findCycles,
  isTestFile,
  readRules,
  renderFamilies,
  REPOSITORY_ROOT,
} from './derive-families.ts';
import { exportNames } from './export-names.ts';
import {
  GENERATED_MARKER,
  isGenerated,
  joinVirtual,
  kindOf,
  PACKAGE_SCOPE,
  relativeSpecifier,
  resolutionCandidates,
  specifierFor,
  TOOLING_PACKAGE,
  virtualPathFor,
} from './split-layout.ts';

/** The packages core never hands over: core itself, and the tooling, which is already a workspace. */
const KEPT = new Set(['core', 'tooling']);
const CODE_FILE = /\.(?:ts|js|mjs|svelte|css)$/;
const TEXT_FILE =
  /\.(?:ts|js|mjs|cjs|svelte|css|json|jsonc|md|toml|ya?ml|html|txt)$|(?:^|\/)\.[a-z]+ignore$|\.oxlintrc\.json$/;
const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|@import\s+(?:url\(\s*)?|\bmock\.module\(\s*)(['"])([^'"\n]+)\2/g;
const PATH_STRING = /(['"`])(\.\.?\/[^'"`\n$*{}]+)\1/g;
const MARKDOWN_FILE = /\.md$/;
/** A relative Markdown link's target, without its fragment: `](../alert/README.md#usage)`. */
const MARKDOWN_LINK = /\]\((\.\.?\/[^)\s#?]+)(?:[#?][^)\s]*)?\)/g;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.types', '.turbo', 'coverage', '.metadata']);
export const ORDER_FILE = 'components-css-order.json';
const COMPONENTS_CSS = 'src/styles/components.css';
const BARREL = 'src/index.ts';
const PACKAGE_STYLESHEET = 'src/styles/index.css';
const ALLOWLIST = 'inherited-key-reads-allowlist.json';
/** Files the extraction never rewrites: the map it reads and its own source. */
const UNREWRITTEN = [
  'internal/component-tooling/families.json',
  'internal/component-tooling/family-rules.json',
  'internal/component-tooling/family-rules.fixture.json',
  'internal/component-tooling/scripts/extract-families.ts',
  'internal/component-tooling/scripts/move-cinder-tooling.ts',
  // It prints the theme JSON under core-relative names, and finds the tokens package itself.
  'internal/component-tooling/scripts/css-fingerprint.ts',
  'internal/component-tooling/scripts/extract-families.test.ts',
  'internal/component-tooling/scripts/split-layout.ts',
  'internal/component-tooling/scripts/derive-families.ts',
  'internal/component-tooling/scripts/derive-families.test.ts',
];

export type Selection =
  | { kind: 'packages'; names: string[] }
  | { kind: 'layer'; layer: number; half?: 1 | 2 }
  | { kind: 'all' };

export interface ExtractOptions {
  root: string;
  /** Core's directory, relative to `root`. */
  core: string;
  families: DerivedFamilies;
  rules: FamilyRules;
  selection: Selection;
  dryRun?: boolean;
  /** Every file under a directory (relative to `root`), as paths relative to that directory. */
  listFiles?: (directory: string) => string[];
  /** Formats a file's text the way the repository's Prettier configuration does. */
  format?: (path: string, text: string) => Promise<string>;
}

export interface Rewrite {
  importer: string;
  specifier: string;
  target: string;
}

export interface ExtractResult {
  selected: string[];
  moves: { from: string; to: string }[];
  created: string[];
  written: string[];
  rewrites: Rewrite[];
  warnings: string[];
  /**
   * Each path a file still writes to where a moved file or directory was, which no rewrite could
   * follow: the run fails on any (see {@link deadPaths}).
   */
  dead: string[];
}

/** Every file under `directory`, skipping installs and build output. */
export function walkFiles(root: string, directory: string): string[] {
  const files: string[] = [];
  const walk = (relativeDirectory: string) => {
    const absolute = join(root, directory, relativeDirectory);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk('');
  return files.toSorted();
}

/** The packages a selection names, dependencies first. */
/**
 * The packages a selection names, dependencies first. `--layer N` takes the layer (or its
 * alphabetical half, rounded up) and every package of a lower layer still in core, so a package an
 * earlier run deferred moves with the first layer that can take it.
 */
export function selectPackages(
  families: DerivedFamilies,
  selection: Selection,
  extracted: ReadonlySet<string> = new Set(),
): string[] {
  const names = Object.keys(families.packages).filter((name) => !KEPT.has(name));
  let selected: string[];
  if (selection.kind === 'all') selected = names.filter((name) => !extracted.has(name));
  else if (selection.kind === 'packages') {
    const unknown = selection.names.filter((name) => !names.includes(name));
    if (unknown.length > 0)
      throw new Error(`No extractable package is named ${unknown.join(', ')}.`);
    selected = selection.names;
  } else {
    const layerOf = (name: string) => families.packages[name]?.layer ?? 0;
    const layer = names.filter((name) => layerOf(name) === selection.layer).toSorted();
    const middle = Math.ceil(layer.length / 2);
    const own =
      selection.half === undefined
        ? layer
        : selection.half === 1
          ? layer.slice(0, middle)
          : layer.slice(middle);
    const earlier = names.filter((name) => layerOf(name) < selection.layer);
    selected = [...earlier, ...own].filter((name) => !extracted.has(name));
  }
  const layerOf = (name: string) => families.packages[name]?.layer ?? 0;
  return [...new Set(selected)].toSorted((a, b) => layerOf(a) - layerOf(b) || a.localeCompare(b));
}

interface Plan {
  options: Required<Omit<ExtractOptions, 'selection'>> & { selection: Selection };
  /** Every package of the map extracted once this run is done. */
  extracted: Set<string>;
  selected: string[];
  /** Each virtual path's package. */
  owner: Map<string, string>;
  /** Each package's component directories. */
  components: Map<string, string[]>;
  result: ExtractResult;
  /** Export keys each package needs for the modules other packages import. */
  exportKeys: Map<string, Set<string>>;
  pending: Map<string, string>;
  /** The directory (core's or a package's) each placed file was found in. */
  location: Map<string, string>;
  /** Each written file's text before the run (undefined for a new file). */
  originals: Map<string, string | undefined>;
  /** Whether no family is left in core after this run, so core's tests leave its components path. */
  relocateCoreTests: boolean;
  /** Where each name core's barrel exports comes from, read once before anything moves. */
  coreExports?: Map<string, ExportTarget>;
}

function packageDirectory(plan: Plan, name: string): string {
  return plan.extracted.has(name) ? posix.join('components', name) : plan.options.core;
}

/**
 * Where a package keeps a virtual path: the same path, except that once every family has left,
 * core keeps its files from under the components directory in the map's `coreTestsDirectory`
 * (`src/component-tests/<component>/…`), so core's components directory can go (COR-2091).
 */
function physicalPath(plan: Plan, name: string, path: string): string {
  const tests = plan.options.families.coreTestsDirectory;
  if (name !== 'core' || !plan.relocateCoreTests || tests === undefined) return path;
  return path.startsWith(COMPONENTS_PREFIX)
    ? `${tests}/${path.slice(COMPONENTS_PREFIX.length)}`
    : path;
}

/** The virtual path a file of core's at `path` (relative to core) stands for. */
function coreVirtualPath(plan: Plan, path: string): string {
  const tests = plan.options.families.coreTestsDirectory;
  if (tests === undefined || !path.startsWith(`${tests}/`)) return path;
  return `${COMPONENTS_PREFIX}${path.slice(tests.length + 1)}`;
}

const COMPONENTS_PREFIX = 'src/components/';

/** Where a virtual path of `name` is now: its new home once moved, where it was found until then. */
function currentPath(plan: Plan, name: string, path: string): string {
  const home = posix.join(packageDirectory(plan, name), physicalPath(plan, name, path));
  if (plan.pending.has(home) || existsSync(join(plan.options.root, home))) return home;
  return plan.location.get(path) ?? posix.join(plan.options.core, path);
}

function read(plan: Plan, path: string): string {
  const pending = plan.pending.get(path);
  if (pending !== undefined) return pending;
  return readFileSync(join(plan.options.root, path), 'utf8');
}

function write(plan: Plan, path: string, text: string): void {
  const absolute = join(plan.options.root, path);
  if (existsSync(absolute) && readFileSync(absolute, 'utf8') === text && !plan.pending.has(path)) {
    return;
  }
  if (!plan.result.written.includes(path)) {
    plan.result.written.push(path);
    plan.originals.set(path, existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined);
  }
  if (plan.options.dryRun) {
    plan.pending.set(path, text);
    return;
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

function isExtractedPackage(root: string, core: string, name: string): boolean {
  const directory = posix.join('components', name);
  if (directory === core) return false;
  const manifest = join(root, directory, 'package.json');
  if (!existsSync(manifest)) return false;
  const { name: packageName } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
  if (packageName !== `${PACKAGE_SCOPE}${name}`) {
    throw new Error(`${directory} is ${packageName}, not ${PACKAGE_SCOPE}${name}.`);
  }
  return true;
}

/** Each virtual path the map places, from the files core and the extracted packages hold now. */
function buildOwnership(plan: Plan): string[] {
  const { families, rules, root, core, listFiles } = plan.options;
  const problems: string[] = [];
  const componentOwner = new Map<string, string>();
  for (const [name, entry] of Object.entries(families.packages)) {
    plan.components.set(name, entry.components);
    for (const component of entry.components) componentOwner.set(component, name);
    for (const module of entry.modules) plan.owner.set(module, name);
  }
  const movedToCore = new Set(
    families.testMoves.filter((move) => move.to === 'core').map((move) => move.file),
  );
  // The derivation reads src only; a row's patterns outside it (the token scripts) place the rest.
  const outside = rules.moves
    .filter((row) => row.when === undefined)
    .map((row) => ({
      target: row.target,
      patterns: row.patterns.filter((pattern) => !pattern.startsWith('src/')),
    }));
  const directories = [core, ...[...plan.extracted].map((name) => posix.join('components', name))];
  for (const directory of directories) {
    for (const listed of listFiles(directory)) {
      const absolute = join(root, directory, listed);
      // Core's tests directory holds files the map names by their components path.
      const path = directory === core ? coreVirtualPath(plan, listed) : listed;
      if (
        CODE_FILE.test(path) &&
        existsSync(absolute) &&
        isGenerated(readFileSync(absolute, 'utf8'))
      ) {
        continue;
      }
      const row = path.startsWith('src/')
        ? undefined
        : outside.find((candidate) =>
            candidate.patterns.some((pattern) => new Bun.Glob(pattern).match(path)),
          );
      if (path.startsWith('src/') || directory === core || row !== undefined) {
        const earlier = plan.location.get(path);
        if (earlier !== undefined) {
          problems.push(`${path} is at both ${earlier} and ${posix.join(directory, listed)}.`);
        }
        plan.location.set(path, posix.join(directory, listed));
      }
      const component = /^src\/components\/([^/]+)\//.exec(path)?.[1];
      if (path.startsWith('src/') && component !== undefined && componentOwner.has(component)) {
        if (!plan.owner.has(path)) {
          plan.owner.set(
            path,
            movedToCore.has(path) ? 'core' : (componentOwner.get(component) as string),
          );
        }
        continue;
      }
      if (row !== undefined) {
        plan.owner.set(path, row.target);
        continue;
      }
      if (path.startsWith('src/') && !plan.owner.has(path)) {
        problems.push(`${posix.join(directory, path)} is in no package of families.json.`);
      } else if (directory === core && !PACKAGE_FILES.has(path) && !plan.owner.has(path)) {
        // Core keeps the rest of its directory (its other scripts, baselines and documentation).
        plan.owner.set(path, 'core');
      }
    }
  }
  return problems;
}

/** The files every package has its own of, which no path names across packages. */
const PACKAGE_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'tsconfig.browser.json',
  'bunfig.toml',
  'README.md',
]);

/**
 * Moves each file the selection takes to its package, and each file a newer map places elsewhere
 * (a test that moved to core) to where it now belongs.
 */
function planMoves(plan: Plan): void {
  const { root, core } = plan.options;
  for (const [path, name] of plan.owner) {
    const from = plan.location.get(path);
    if (from === undefined) continue;
    const home =
      plan.selected.includes(name) || plan.extracted.has(name)
        ? posix.join('components', name)
        : core;
    const to = posix.join(home, physicalPath(plan, name, path));
    if (from === to) continue;
    if (existsSync(join(root, to))) throw new Error(`Both ${from} and ${to} exist.`);
    plan.result.moves.push({ from, to });
  }
}

function applyMoves(plan: Plan): void {
  const { root } = plan.options;
  for (const { from, to } of plan.result.moves) {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    renameSync(join(root, from), join(root, to));
  }
  // Leave no empty directory behind below a package's src, scripts or documentation.
  const directories = new Set(plan.result.moves.map(({ from }) => dirname(from)));
  for (const directory of [...directories].toSorted((a, b) => b.length - a.length)) {
    const base = directory.split('/').slice(0, 3).join('/');
    let at = directory;
    while (at.length > base.length && at.startsWith(`${base}/`)) {
      const absolute = join(root, at);
      if (!existsSync(absolute) || readdirSync(absolute).length > 0) break;
      rmSync(absolute, { recursive: true });
      at = dirname(at);
    }
  }
}

/** Creates each selected package that has no manifest yet, without the scaffold's placeholders. */
function scaffold(plan: Plan): void {
  const { root, core } = plan.options;
  for (const name of plan.selected) {
    const directory = posix.join('components', name);
    if (existsSync(join(root, directory, 'package.json'))) continue;
    plan.result.created.push(directory);
    if (plan.options.dryRun) continue;
    createPackage(root, name);
    for (const placeholder of [
      `src/components/${name}/${name}.svelte`,
      'src/index.test.ts',
      'src/index.ts',
      PACKAGE_STYLESHEET,
    ]) {
      rmSync(join(root, directory, placeholder), { force: true });
    }
    for (const empty of [`src/components/${name}`, 'src/components', 'src/styles']) {
      const absolute = join(root, directory, empty);
      if (existsSync(absolute) && readdirSync(absolute).length === 0)
        rmSync(absolute, { recursive: true });
    }
    // Every package runs its tests the way core does; writeTsconfigs gives it core's compiler setup.
    const bunfig = join(root, core, 'bunfig.toml');
    if (existsSync(bunfig))
      writeFileSync(join(root, directory, 'bunfig.toml'), readFileSync(bunfig, 'utf8'));
    // Every workspace has a README (workspace-contract.integration.test.ts).
    const readme = join(root, directory, 'README.md');
    if (!existsSync(readme)) writeFileSync(readme, packageReadme(plan, name));
  }
}

/** A new package's README: what it holds and where it came from. */
function packageReadme(plan: Plan, name: string): string {
  const components = plan.components.get(name) ?? [];
  const holds =
    kindOf(name) === 'family'
      ? `the ${components.map((component) => `\`${component}\``).join(', ')} component${components.length === 1 ? '' : 's'}`
      : `Cinder's ${name}`;
  return `# ${PACKAGE_SCOPE}${name}\n\nThis package holds ${holds}, which the Cinder package split (P-COR-101) moved out of \`${CORE_PACKAGE}\`. \`${CORE_PACKAGE}\` re-exports what it holds.\n`;
}

/** The ambient module shapes a package compiles against; core keeps its own in `src/ambient.d.ts`. */
const AMBIENT = '../../internal/component-tooling/types/component-ambient.d.ts';

/** Each extracted package's `tsconfig.json` and `tsconfig.browser.json`: core's, with the ambient shapes. */
function writeTsconfigs(plan: Plan): void {
  for (const file of ['tsconfig.json', 'tsconfig.browser.json']) {
    const source = posix.join(plan.options.core, file);
    if (!plan.pending.has(source) && !existsSync(join(plan.options.root, source))) continue;
    const config = JSON.parse(read(plan, source)) as { include?: string[] };
    const include = [...(config.include ?? ['src'])];
    if (!include.includes(AMBIENT)) include.push(AMBIENT);
    const text = `${JSON.stringify({ ...config, include }, null, 2)}\n`;
    for (const name of plan.extracted) {
      const directory = posix.join('components', name);
      if (
        !plan.pending.has(posix.join(directory, 'package.json')) &&
        !existsSync(join(plan.options.root, directory, 'package.json'))
      ) {
        continue;
      }
      write(plan, posix.join(directory, file), text);
    }
  }
}

/** The virtual path a relative reference in `importer` names, if the map places it. */
function resolveVirtual(plan: Plan, importer: string, specifier: string): string | undefined {
  // A path into core's tests directory names the file the map keeps under its components path.
  const base = coreVirtualPath(plan, joinVirtual(importer, specifier));
  return resolutionCandidates(base).find((candidate) => plan.owner.has(candidate));
}

/** Packages whose files sit under a virtual directory. */
function ownersUnder(plan: Plan, directory: string): Set<string> {
  const owners = new Set<string>();
  const prefix = directory.endsWith('/') ? directory : `${directory}/`;
  for (const [path, name] of plan.owner) if (path.startsWith(prefix)) owners.add(name);
  return owners;
}

function addExportKey(plan: Plan, name: string, key: string | undefined): void {
  if (key === undefined) return;
  const keys = plan.exportKeys.get(name) ?? new Set<string>();
  keys.add(key);
  plan.exportKeys.set(name, keys);
}

function packageOf(plan: Plan, path: string): { name: string; virtual: string } | undefined {
  for (const name of plan.extracted) {
    const prefix = `components/${name}/`;
    if (path.startsWith(prefix)) return { name, virtual: path.slice(prefix.length) };
  }
  const prefix = `${plan.options.core}/`;
  if (!path.startsWith(prefix)) return undefined;
  const virtual = coreVirtualPath(plan, path.slice(prefix.length));
  // A dry run moves nothing, so a file still in core counts as its new package's.
  const owner = plan.owner.get(virtual);
  if (plan.options.dryRun && owner !== undefined && plan.selected.includes(owner)) {
    return { name: owner, virtual };
  }
  return { name: 'core', virtual };
}

/** The packages each candidate's files import by relative path, each with one importing file. */
function importedPackages(
  plan: Plan,
  candidates: ReadonlySet<string>,
): Map<string, Map<string, string>> {
  const imported = new Map<string, Map<string, string>>();
  for (const [path, name] of plan.owner) {
    if (!candidates.has(name) || !CODE_FILE.test(path)) continue;
    const text = read(plan, currentPath(plan, name, path));
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[3] ?? '';
      if (!specifier.startsWith('.')) continue;
      const target = resolveVirtual(plan, path, specifier);
      const owner = target === undefined ? undefined : plan.owner.get(target);
      if (owner === undefined || owner === name || owner === 'tooling') continue;
      const packages = imported.get(name) ?? new Map<string, string>();
      if (!packages.has(owner)) packages.set(owner, `${path} imports ${specifier}`);
      imported.set(name, packages);
    }
    // An example's names from core's barrel need the packages that hold them (item 4).
    if (!EXAMPLE_FILE.test(path)) continue;
    for (const statement of coreNamedImports(text)) {
      for (const element of statement.elements) {
        const owner = exampleImportSource(plan, element.name)?.owner ?? 'core';
        if (owner === name || owner === 'tooling') continue;
        const packages = imported.get(name) ?? new Map<string, string>();
        if (!packages.has(owner)) {
          packages.set(owner, `${path} imports ${element.name} from @lostgradient/cinder`);
        }
        imported.set(name, packages);
      }
    }
  }
  return imported;
}

/**
 * Reads modules for {@link coreExportTargets} by virtual path, wherever they are now; a package's
 * generated barrel is read as `generated:<package>:src/index.ts`.
 */
function planReader(plan: Plan): ModuleReader {
  const virtual = (file: string) => file.replace(/^generated:[^:]+:/, '');
  return {
    read: (file) => {
      if (file.startsWith('generated:')) {
        const [, name = ''] = file.split(':');
        const path = posix.join('components', name, virtual(file));
        return existsSync(join(plan.options.root, path)) ? read(plan, path) : undefined;
      }
      const owner = plan.owner.get(file);
      if (owner === undefined) return undefined;
      const path = currentPath(plan, owner, file);
      return plan.pending.has(path) || existsSync(join(plan.options.root, path))
        ? read(plan, path)
        : undefined;
    },
    resolve: (from, specifier) => {
      if (specifier.startsWith('.')) return resolveVirtual(plan, virtual(from), specifier);
      const named = virtualPathFor(specifier);
      if (named === undefined) return undefined;
      if (named.path === 'src/index.ts') return `generated:${named.name}:src/index.ts`;
      return plan.owner.has(named.path) ? named.path : undefined;
    },
  };
}

/** Where an example imports one of core's barrel names from instead (item 4). */
function exampleImportSource(
  plan: Plan,
  name: string,
): { owner: string; specifier: string; imported: string } | undefined {
  plan.coreExports ??= coreExportTargets('src/index.ts', planReader(plan));
  const target = plan.coreExports.get(name);
  if (target === undefined) return undefined;
  const first = target.firstSpecifier;
  if (first.startsWith(PACKAGE_SCOPE) && !first.slice(PACKAGE_SCOPE.length).includes('/')) {
    return { owner: first.slice(PACKAGE_SCOPE.length), specifier: first, imported: name };
  }
  const firstOwner =
    target.firstModule === undefined ? undefined : plan.owner.get(target.firstModule);
  if (firstOwner !== undefined && firstOwner !== 'core') {
    // Core's barrel statement for the name moves to that package's barrel, which exports it.
    return { owner: firstOwner, specifier: `${PACKAGE_SCOPE}${firstOwner}`, imported: name };
  }
  const file = target.file.replace(/^generated:[^:]+:/, '');
  const owner = plan.owner.get(file);
  if (owner === undefined || owner === 'core')
    return { owner: 'core', specifier: '', imported: name };
  const named = specifierFor(owner, file, plan.components.get(owner));
  addExportKey(plan, owner, named.exportKey);
  return { owner, specifier: named.specifier, imported: target.imported };
}

/**
 * An example's `import { … } from '@lostgradient/cinder'` as imports from the packages that hold
 * the names, or undefined while one of them is core's or still in core.
 */
function rewriteExampleImport(plan: Plan, statement: CoreNamedImport): string | undefined {
  const bySpecifier = new Map<string, string[]>();
  for (const element of statement.elements) {
    const source = exampleImportSource(plan, element.name);
    if (source === undefined || source.owner === 'core' || !plan.extracted.has(source.owner)) {
      return undefined;
    }
    const imported =
      source.imported === element.local ? element.local : `${source.imported} as ${element.local}`;
    const elements = bySpecifier.get(source.specifier) ?? [];
    elements.push(`${element.typeOnly && !statement.typeOnly ? 'type ' : ''}${imported}`);
    bySpecifier.set(source.specifier, elements);
  }
  return [...bySpecifier]
    .map(
      ([specifier, elements]) =>
        `import ${statement.typeOnly ? 'type ' : ''}{ ${elements.join(', ')} } from '${specifier}';`,
    )
    .join('\n');
}

/**
 * The cycles the selected and extracted packages would form through everything their files import,
 * tests included, checked before anything moves.
 */
function selectionCycles(plan: Plan): string[][] {
  const members = new Set([...plan.selected, ...plan.extracted]);
  const imported = importedPackages(plan, new Set(plan.selected));
  const graph = new Map<string, Set<string>>();
  for (const name of plan.selected) {
    const edges = new Set(
      [
        ...(imported.get(name)?.keys() ?? []),
        ...(plan.options.families.packages[name]?.dependencies ?? []),
      ].filter((target) => members.has(target) && target !== name),
    );
    graph.set(name, edges);
  }
  for (const name of plan.extracted) {
    const path = join(plan.options.root, 'components', name, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    const edges = new Set(
      [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
        .filter((dependency) => dependency.startsWith(PACKAGE_SCOPE))
        .map((dependency) => dependency.slice(PACKAGE_SCOPE.length))
        .filter((target) => members.has(target) && target !== name),
    );
    graph.set(name, edges);
  }
  return findCycles(graph);
}

/**
 * The candidates that can move now: a package moves only once everything its files import has
 * (its source dependencies, and what its tests and fixtures mount), so a family whose fixture
 * mounts a family of a higher layer waits for it. Repeats to a fixpoint; the rest are deferred.
 */
function closeSelection(
  plan: Plan,
  candidates: readonly string[],
): { ready: string[]; deferred: string[] } {
  const imported = importedPackages(plan, new Set(candidates));
  const ready = new Set(candidates);
  const reasons = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    // Deleting the current element while iterating a Set is safe.
    for (const name of ready) {
      const needs = new Map(imported.get(name));
      for (const dependency of plan.options.families.packages[name]?.dependencies ?? []) {
        if (!needs.has(dependency)) needs.set(dependency, `families.json lists ${dependency}`);
      }
      for (const [needed, witness] of needs) {
        if (needed === 'tooling' || plan.extracted.has(needed) || ready.has(needed)) continue;
        ready.delete(name);
        reasons.set(name, `${name} waits for ${needed}, which stays in core (${witness}).`);
        changed = true;
        break;
      }
    }
  }
  return {
    ready: candidates.filter((name) => ready.has(name)),
    deferred: candidates
      .filter((name) => !ready.has(name))
      .map((name) => reasons.get(name) ?? name),
  };
}

/**
 * Rewrites one file of core or of an extracted package: an import that now crosses packages to a
 * package specifier, and a relative path string that does to a relative path that still reaches it.
 */
/**
 * The specifier a file of core's needs for another of core's when core's tests directory took one
 * of them (COR-2091), or undefined when the written one still reaches it.
 */
function movedWithinCore(
  plan: Plan,
  home: { name: string; virtual: string },
  name: string,
  target: string,
  specifier: string,
): string | undefined {
  if (!plan.relocateCoreTests || home.name !== 'core' || name !== 'core') return undefined;
  const importer = physicalPath(plan, 'core', home.virtual);
  const physicalTarget = physicalPath(plan, 'core', target);
  const reached = posix.normalize(
    posix.join(posix.dirname(importer), specifier.split('?')[0] ?? ''),
  );
  if (resolutionCandidates(reached).includes(physicalTarget)) return undefined;
  const query = specifier.includes('?') ? specifier.slice(specifier.indexOf('?')) : '';
  return `${relativeSpecifier(importer, physicalTarget)}${query}`;
}

/**
 * A path a file writes: where its written form starts and how long it is, the path it stands for
 * from the file's directory (`./…` or `../…`), and how a path that replaces it is written back.
 */
interface WrittenPath {
  start: number;
  length: number;
  text: string;
  render: (path: string) => string;
}

/** The file's own directory: `import.meta.dir`, `import.meta.dirname`, `dirname(fileURLToPath(import.meta.url))`. */
const DIRECTORY_ANCHOR = String.raw`(?:import\.meta\.dirname|import\.meta\.dir|dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\))`;
const SEGMENT_LITERAL = String.raw`(?:'[^'\n$]*'|"[^"\n$]*")`;
/** `join(import.meta.dir, '..', 'tokens', file)`: the run of literal segments after the anchor. */
const ANCHORED_JOIN = new RegExp(
  String.raw`\b(?:join|resolve)\(\s*${DIRECTORY_ANCHOR}\s*,\s*(${SEGMENT_LITERAL}(?:\s*,\s*${SEGMENT_LITERAL})*)`,
  'g',
);
/** `` `${import.meta.dir}/components/_scroll-fade.css` ``: the literal text after the anchor. */
const ANCHORED_TEMPLATE = /`\$\{import\.meta\.dir(?:name)?\}\/([^`$\n]+)/g;

/** A relative path written as segments, `./`-prefixed unless it climbs. */
function segmentsPath(segments: readonly string[]): string | undefined {
  const joined = posix.join(...segments);
  if (joined === '.' || joined === '') return undefined;
  return joined === '..' || joined.startsWith('../') ? joined : `./${joined}`;
}

/** The literal segments of a run of quoted strings separated by commas. */
function literalSegments(run: string): string[] {
  return [...run.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((match) => match[1] ?? match[2] ?? '');
}

/**
 * The paths a file writes from its own directory, each with where it starts: a code file's quoted
 * relative strings (not the specifiers {@link rewriteFile} handles first), the literal segments it
 * joins to its directory (`join(import.meta.dir, 'tokens', file)`) and the literal tail of a
 * template on it (`` `${import.meta.dir}/components/x.css` ``); a Markdown file's link targets.
 */
function relativePaths(path: string, text: string): WrittenPath[] {
  const identity = (replacement: string) => replacement;
  if (MARKDOWN_FILE.test(path)) {
    return [...text.matchAll(MARKDOWN_LINK)].map((match) => ({
      start: (match.index ?? 0) + 2,
      length: (match[1] ?? '').length,
      text: match[1] ?? '',
      render: identity,
    }));
  }
  const paths: WrittenPath[] = [];
  for (const match of text.matchAll(ANCHORED_JOIN)) {
    const run = match[1] ?? '';
    const segments = literalSegments(run);
    const joined = segmentsPath(segments);
    if (joined === undefined) continue;
    // The run's text between its first and last quote is replaced: by one literal where it was
    // one, and by segments where it was segments, so what reads the run's shape (the map's
    // placement rules) reads the same shape after the rewrite.
    const quote = run[0] ?? "'";
    const start = (match.index ?? 0) + match[0].length - run.length + 1;
    paths.push({
      start,
      length: run.length - 2,
      text: joined,
      render:
        segments.length === 1
          ? identity
          : (replacement) =>
              replacement
                .split('/')
                .filter((segment) => segment !== '' && segment !== '.')
                .join(`${quote}, ${quote}`),
    });
  }
  for (const match of text.matchAll(ANCHORED_TEMPLATE)) {
    const tail = match[1] ?? '';
    const written = segmentsPath([tail]);
    if (written === undefined) continue;
    paths.push({
      start: (match.index ?? 0) + match[0].length - tail.length,
      length: tail.length,
      text: tail.endsWith('/') && !written.endsWith('/') ? `${written}/` : written,
      render: (replacement) => (replacement.startsWith('./') ? replacement.slice(2) : replacement),
    });
  }
  const claimed = paths.map(({ start, length }) => [start, start + length] as const);
  for (const match of text.matchAll(PATH_STRING)) {
    // A specifier is handled apart; skip any string the specifier pattern matched.
    const before = text.slice(Math.max(0, (match.index ?? 0) - 24), match.index);
    if (
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|@import\s+(?:url\(\s*)?|mock\.module\(\s*)$/.test(
        before,
      )
    ) {
      continue;
    }
    const start = (match.index ?? 0) + 1;
    if (claimed.some(([from, to]) => start >= from && start < to)) continue;
    const written = match[2] ?? '';
    paths.push({ start, length: written.length, text: written, render: identity });
  }
  return paths;
}

/**
 * Where a relative path `path` writes should point now, or undefined when it still reaches its
 * file. It is resolved from `logical`, where the file is, and names a file in core or (written by an
 * earlier run) another package; it is rewritten when the package that holds that file has moved it.
 */
function retargetPath(plan: Plan, path: string, logical: string, text: string): string | undefined {
  const pointedPath = posix.normalize(posix.join(posix.dirname(logical), text));
  const pointed = packageOf(plan, pointedPath);
  if (pointed === undefined) return undefined;
  const pointedDirectory = packageDirectory(plan, pointed.name);
  const base = pointed.virtual;
  // A path that names a directory (`join(import.meta.dir, '..')`, core's `src`) names the
  // directory, never the `index.ts` a module specifier would resolve it to.
  const directoryOwners = plan.owner.has(base) ? new Set<string>() : ownersUnder(plan, base);
  const file =
    directoryOwners.size > 0
      ? undefined
      : resolutionCandidates(base).find((candidate) => plan.owner.has(candidate));
  let owner: string | undefined = file === undefined ? undefined : plan.owner.get(file);
  if (owner === undefined) {
    const owners = directoryOwners;
    // A package whose files under the directory are kept elsewhere (core's, in its tests directory
    // once every family has left) does not share the directory any more.
    for (const name of owners) {
      if (owners.size > 1 && !physicalPath(plan, name, posix.join(base, 'file')).startsWith(base)) {
        owners.delete(name);
      }
    }
    if (owners.size === 1) owner = [...owners][0];
    else if (
      owners.size > 1 &&
      [...owners].some((name) => packageDirectory(plan, name) !== pointedDirectory)
    ) {
      plan.result.warnings.push(`${path}: ${text} names a directory several packages share.`);
    }
  }
  if (owner === undefined) return undefined;
  const absoluteTarget = posix.join(packageDirectory(plan, owner), physicalPath(plan, owner, base));
  if (packageDirectory(plan, owner) === pointedDirectory && absoluteTarget === pointedPath) {
    return undefined;
  }
  let replacement = posix.relative(posix.dirname(logical), absoluteTarget);
  if (text.endsWith('/') && !replacement.endsWith('/')) replacement += '/';
  if (!replacement.startsWith('.')) replacement = `./${replacement}`;
  return replacement;
}

/** Core's package name, which a family's tests may not name: it is no dependency of a family. */
const CORE_PACKAGE_NAME = '@lostgradient/cinder';
const CORE_MOCK =
  /\bmock\.module\(\s*(['"])@lostgradient\/cinder\1\s*,\s*(?:async\s*)?\(\)\s*=>\s*([^\n]+?)\)\s*;/g;

/** Each `mock.module('@lostgradient/cinder', () => …)` in `text`: where the name starts, the factory. */
function coreMocks(text: string): { start: number; factory: string }[] {
  return [...text.matchAll(CORE_MOCK)].map((match) => ({
    start: (match.index ?? 0) + match[0].indexOf(CORE_PACKAGE_NAME),
    factory: match[2] ?? '',
  }));
}

/**
 * The specifier a moved test should mock instead of core's barrel: the one it imports the module
 * its mock factory returns from (`const inputModule = await import('../input/index.ts')`, or a
 * destructured `const { default: Input } = await import(…)`), as the package that holds that
 * module names it, or as written when the test's own package holds it.
 */
function mockedModuleSpecifier(
  plan: Plan,
  home: { name: string; virtual: string },
  text: string,
  factory: string,
): string | undefined {
  const identifiers = [...factory.matchAll(/[A-Za-z_$][\w$]*/g)]
    .map((match) => match[0])
    .filter((name) => name !== 'default');
  for (const identifier of identifiers) {
    const name = identifier.replaceAll('$', '\\$');
    const binding = new RegExp(
      String.raw`(?:\bconst\s+(?:${name}|\{[^}]*\b${name}\b[^}]*\})\s*=\s*await\s+import\(\s*|\bimport\s+(?:${name}|\{[^}]*\b${name}\b[^}]*\})\s+from\s+)(['"])([^'"\n]+)\1`,
    ).exec(text);
    const specifier = binding?.[2];
    if (specifier === undefined) continue;
    if (!specifier.startsWith('.')) return specifier;
    const target = resolveVirtual(plan, home.virtual, specifier);
    if (target === undefined) return undefined;
    const owner = plan.owner.get(target) as string;
    if (owner === home.name) return specifier;
    if (owner === 'core') return undefined;
    const named = specifierFor(owner, target, plan.components.get(owner));
    addExportKey(plan, owner, named.exportKey);
    return named.specifier;
  }
  return undefined;
}

function rewriteFile(plan: Plan, path: string): void {
  const home = packageOf(plan, path);
  if (home === undefined || !(CODE_FILE.test(path) || MARKDOWN_FILE.test(path))) return;
  const directory = packageDirectory(plan, home.name);
  const original = read(plan, path);
  if (isGenerated(original)) return;
  const rewritten = new Map<number, { length: number; text: string }>();
  const specifiers = MARKDOWN_FILE.test(path) ? [] : original.matchAll(SPECIFIER);
  for (const match of specifiers) {
    const specifier = match[3] ?? '';
    if (!specifier.startsWith('.')) continue;
    const target = resolveVirtual(plan, home.virtual, specifier);
    if (target === undefined) continue;
    const name = plan.owner.get(target) as string;
    if (packageDirectory(plan, name) === directory) {
      // Within core, a file core's tests directory took is reached from where each file is now.
      const moved = movedWithinCore(plan, home, name, target, specifier);
      if (moved !== undefined) {
        const start = (match.index ?? 0) + (match[1] ?? '').length + 1;
        rewritten.set(start, { length: specifier.length, text: moved });
      }
      continue;
    }
    if (name === 'core') {
      plan.result.warnings.push(`${path} imports ${specifier}, which core keeps.`);
      continue;
    }
    const named = specifierFor(name, target, plan.components.get(name));
    addExportKey(plan, name, named.exportKey);
    const query = specifier.includes('?') ? specifier.slice(specifier.indexOf('?')) : '';
    const start = (match.index ?? 0) + (match[1] ?? '').length + 1;
    rewritten.set(start, { length: specifier.length, text: `${named.specifier}${query}` });
    plan.result.rewrites.push({
      importer: path,
      specifier: `${named.specifier}${query}`,
      // The tooling's modules resolve to the tooling workspace, whatever core still holds.
      target:
        name === 'tooling'
          ? posix.join('internal/component-tooling', target)
          : posix.join(packageDirectory(plan, name), physicalPath(plan, name, target)),
    });
  }
  // An example a package holds imports each core barrel name from its package instead (item 4).
  if (home.name !== 'core' && EXAMPLE_FILE.test(path)) {
    for (const statement of coreNamedImports(original)) {
      const replacement = rewriteExampleImport(plan, statement);
      if (replacement === undefined) {
        plan.result.warnings.push(
          `${path} imports from @lostgradient/cinder what no package of it holds.`,
        );
        continue;
      }
      rewritten.set(statement.start, {
        length: statement.end - statement.start,
        text: replacement,
      });
    }
  }
  // A moved test that mocks core's barrel mocks the module it hands the mock instead: the one its
  // component now imports from the package that holds it (core's name is no dependency of it).
  if (home.name !== 'core') {
    for (const mock of coreMocks(original)) {
      const replacement = mockedModuleSpecifier(plan, home, original, mock.factory);
      if (replacement === undefined) {
        plan.result.warnings.push(
          `${path} mocks @lostgradient/cinder with a module it names nowhere.`,
        );
        continue;
      }
      rewritten.set(mock.start, { length: CORE_PACKAGE_NAME.length, text: replacement });
    }
  }
  for (const { start, length, text, render } of relativePaths(path, original)) {
    if (rewritten.has(start)) continue;
    const logical = posix.join(directory, physicalPath(plan, home.name, home.virtual));
    const replacement = retargetPath(plan, path, logical, text);
    if (replacement !== undefined) rewritten.set(start, { length, text: render(replacement) });
  }
  if (rewritten.size === 0) return;
  let next = original;
  for (const [start, { length, text }] of [...rewritten].toSorted(([a], [b]) => b - a)) {
    next = `${next.slice(0, start)}${text}${next.slice(start + length)}`;
  }
  write(plan, path, next);
}

/**
 * Rewrites `<core>/src/…` and `<core>/scripts/…` paths in a text file anywhere in the repository to
 * the package that now holds the file or directory they name.
 */
function rewriteRepositoryPaths(plan: Plan, path: string): void {
  const { core } = plan.options;
  if (UNREWRITTEN.includes(path) || !TEXT_FILE.test(path)) return;
  const original = read(plan, path);
  let next = original;
  // A file no package holds (chat, an application, a document) reaching into core by a relative
  // path follows the file it names to the package that holds it now.
  if (packageOf(plan, path) === undefined) {
    const replacements = relativePaths(path, next).flatMap(({ start, length, text, render }) => {
      const replacement = retargetPath(plan, path, path, text);
      return replacement === undefined ? [] : [{ start, length, replacement: render(replacement) }];
    });
    for (const { start, length, replacement } of replacements.toSorted(
      (a, b) => b.start - a.start,
    )) {
      next = `${next.slice(0, start)}${replacement}${next.slice(start + length)}`;
    }
  }
  if (next.includes(core)) {
    const pattern = new RegExp(
      // A segment ends on a name character, so a sentence's full stop is not part of the path.
      `${escapeRegExp(core)}/((?:src|scripts|documentation)(?:/[\\w.@-]*[\\w@-])*)`,
      'g',
    );
    next = next.replace(pattern, (whole, written: string) => {
      const virtual = coreVirtualPath(plan, written);
      const owner = ownerOfPath(plan, virtual);
      if (owner === undefined) return whole;
      return `${packageDirectory(plan, owner)}/${physicalPath(plan, owner, virtual)}`;
    });
  }
  // The same path inside a regular expression literal, written with `\/`.
  const escapedCore = core.replaceAll('/', '\\/');
  if (next.includes(escapedCore)) {
    const pattern = new RegExp(
      `${escapeRegExp(escapedCore)}\\\\/((?:src|scripts|documentation)(?:\\\\/[\\w.@-]+)*)`,
      'g',
    );
    next = next.replace(pattern, (whole, escaped: string) => {
      const virtual = coreVirtualPath(plan, escaped.replaceAll('\\/', '/'));
      const owner = ownerOfPath(plan, virtual);
      if (owner === undefined) return whole;
      return `${packageDirectory(plan, owner)}/${physicalPath(plan, owner, virtual)}`.replaceAll(
        '/',
        '\\/',
      );
    });
  }
  for (const fixup of fixups(core)) {
    if (plan.extracted.has(fixup.package) && !next.includes(fixup.to)) {
      next = next.replaceAll(fixup.from, fixup.to);
    }
  }
  // Core's check baselines name files relative to core (`src/…`), so an entry follows its file to
  // the package that takes it (`../<package>/src/…`), as the checks name it once it has moved.
  const baseline = path.startsWith(`${core}/scripts/`) && path.endsWith('-baseline.json');
  if (CODE_FILE.test(path) || baseline) next = rewriteSegmentedPaths(plan, path, next);
  if (next !== original) write(plan, path, next);
}

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The package that holds a virtual file, or every file under a virtual directory. */
function ownerOfPath(plan: Plan, virtual: string): string | undefined {
  const owner = plan.owner.get(virtual);
  if (owner !== undefined) return owner;
  const owners = ownersUnder(plan, virtual);
  return owners.size === 1 ? [...owners][0] : undefined;
}

/**
 * Text replacements a move needs that no path pattern finds, applied once the named package has
 * moved, and only to a file that does not hold `to` already, so a rerun adds nothing: a command
 * that names the package that now runs a script, and the inputs that list core's scripts directory
 * gaining the token scripts beside it (`core` is core's directory).
 */
function fixups(core: string): readonly { package: string; from: string; to: string }[] {
  return [
    ...['tokens:generate', 'tokens:check'].map((script) => ({
      package: 'tokens',
      from: `bun run --filter=@lostgradient/cinder ${script}`,
      to: `bun run --filter=@lostgradient/tokens ${script}`,
    })),
    {
      package: 'tokens',
      from: `"$TURBO_ROOT$/${core}/scripts/**",\n`,
      to: `"$TURBO_ROOT$/${core}/scripts/**",\n        "$TURBO_ROOT$/components/tokens/scripts/**",\n`,
    },
    {
      package: 'tokens',
      from: `  '${core}/scripts',\n`,
      to: `  '${core}/scripts',\n  'components/tokens/scripts',\n`,
    },
  ];
}

const SEGMENTED =
  /(?:(['"])([\w.@-]+)\1\s*,\s*)?(['"])(src|scripts|documentation)\3((?:\s*,\s*(['"])[\w.@-]+\6)+)/g;
const SINGLE = /(['"])((?:src|scripts|documentation)\/[\w.@/-]+)\1/g;

/**
 * Rewrites a path a script builds from a package root and core-relative segments (`join(root,
 * 'src', 'tokens', 'registry.generated.json')`, or `join(root, 'src/tokens/…')`) when another
 * package now holds what it names: the root is assumed to be a package's directory under
 * `components/`, so `'..', '<package>'` reaches the sibling. A file outside the component packages
 * is read only when it names core, so a path into its own `src` is left alone.
 */
function rewriteSegmentedPaths(plan: Plan, path: string, text: string): string {
  const home = packageOf(plan, path)?.name;
  const coreName = posix.basename(plan.options.core);
  const scripts = path.startsWith('internal/component-tooling/scripts/');
  if (home === undefined && !scripts && !text.includes(coreName)) return text;
  // Outside the packages a test often builds a tree of its own, which these paths would mistake:
  // there, only a path that names core (`'components', '<core>', 'src', …`) is core's.
  const ownTree = home === undefined && isTestFile(path);
  const target = (virtual: string): string | undefined => {
    const owner = ownerOfPath(plan, virtual);
    if (owner === undefined || owner === 'tooling') return undefined;
    const directory = packageDirectory(plan, owner);
    const base = home === undefined ? plan.options.core : packageDirectory(plan, home);
    return directory === base ? undefined : posix.basename(directory);
  };
  let next = text.replace(
    SEGMENTED,
    (
      whole,
      quote: string | undefined,
      previous: string | undefined,
      startQuote: string,
      start: string,
      rest: string,
    ) => {
      if (ownTree && previous !== coreName) return whole;
      const segments = [...rest.matchAll(/(['"])([\w.@-]+)\1/g)].map((match) => match[2] ?? '');
      const name = target([start, ...segments].join('/'));
      if (name === undefined || previous === name) return whole;
      const tail = `${startQuote}${start}${startQuote}${rest}`;
      if (previous === coreName && quote !== undefined) {
        return `${quote}${name}${quote}, ${tail}`;
      }
      const head = previous === undefined ? '' : `${quote}${previous}${quote}, `;
      return `${head}${startQuote}..${startQuote}, ${startQuote}${name}${startQuote}, ${tail}`;
    },
  );
  next = next.replace(SINGLE, (whole, quote: string, virtual: string) => {
    if (ownTree) return whole;
    const name = target(virtual.replace(/\/$/, ''));
    return name === undefined ? whole : `${quote}../${name}/${virtual}${quote}`;
  });
  // A path an earlier run pointed into core (`'../cinder/src/…'`) follows the file when it moves on.
  next = next.replace(SIBLING_SINGLE, (whole, quote: string, sibling: string, virtual: string) => {
    if (sibling !== coreName) return whole;
    const name = target(virtual.replace(/\/$/, ''));
    return name === undefined || name === coreName
      ? whole
      : `${quote}../${name}/${virtual}${quote}`;
  });
  return next;
}

const SIBLING_SINGLE = /(['"])\.\.\/([\w-]+)\/((?:src|scripts|documentation)\/[\w.@/-]+)\1/g;

/** An example's code as a component's `<name>.examples.json` copies it: without its module script. */
function exampleBody(text: string): string {
  return text.replace(/^<script lang="ts" module>[\s\S]*?<\/script>\n\n/, '');
}

/**
 * Keeps each `<component>.examples.json` a package holds the copy of its examples it was: an
 * entry whose `code` was its example's body (`examples/<id>.example.svelte`) before the run takes
 * the body the run wrote, imports from the packages that hold the names included. An entry that
 * differed from its example before stays as it was.
 */
async function syncExampleArtifacts(plan: Plan): Promise<void> {
  const { root } = plan.options;
  const updates = new Map<string, { examples?: { id?: unknown; code?: unknown }[] }>();
  for (const path of plan.result.written) {
    if (!EXAMPLE_FILE.test(path) || packageOf(plan, path)?.name === 'core') continue;
    const before = plan.originals.get(path);
    if (before === undefined) continue;
    const componentDirectory = posix.dirname(posix.dirname(path));
    const artifact = posix.join(
      componentDirectory,
      `${posix.basename(componentDirectory)}.examples.json`,
    );
    if (!existsSync(join(root, artifact))) continue;
    const parsed =
      updates.get(artifact) ??
      (JSON.parse(readFileSync(join(root, artifact), 'utf8')) as {
        examples?: { id?: unknown; code?: unknown }[];
      });
    const id = posix.basename(path).replace(EXAMPLE_FILE, '');
    const entry = parsed.examples?.find((example) => example.id === id);
    if (entry === undefined || entry.code !== exampleBody(before)) continue;
    entry.code = exampleBody(readFileSync(join(root, path), 'utf8'));
    updates.set(artifact, parsed);
  }
  for (const [artifact, parsed] of updates) {
    const absolute = join(root, artifact);
    const text = await plan.options.format(absolute, `${JSON.stringify(parsed, null, 2)}\n`);
    if (text === readFileSync(absolute, 'utf8')) continue;
    if (!plan.result.written.includes(artifact)) plan.result.written.push(artifact);
    writeFileSync(absolute, text);
  }
}

const SEGMENT_RUN = new RegExp(`${SEGMENT_LITERAL}(?:\\s*,\\s*${SEGMENT_LITERAL})+`, 'g');

/**
 * Each path a file still writes into core's directory where a file or directory that left core
 * was, once every rewrite has run: the guard behind them. It reads every code and Markdown file in
 * the repository: the relative paths and the paths on a file's own directory {@link relativePaths}
 * finds, from where the file is and, when that reaches nothing, from where it was before it moved;
 * and each `<core>/…` path from the repository root, written whole or as segments (`'components',
 * '<core>', 'src', …`). A path counts when the map places what it names in one package that holds
 * it elsewhere now; a directory several packages share (core's components directory) is no one
 * package's, so a reader that walks it is left to its own tests.
 */
function deadPaths(plan: Plan): string[] {
  const { root, core } = plan.options;
  const directoryOwners = new Map<string, Set<string>>();
  for (const [path, name] of plan.owner) {
    for (let at = posix.dirname(path); at !== '.'; at = posix.dirname(at)) {
      const owners = directoryOwners.get(at) ?? new Set<string>();
      owners.add(name);
      directoryOwners.set(at, owners);
    }
  }
  /** Where the package that holds a path into core keeps it now, when that is not there. */
  const movedTo = (reached: string): string | undefined => {
    if (!reached.startsWith(`${core}/`)) return undefined;
    const written = reached.slice(core.length + 1).replace(/\/$/, '');
    const virtual = coreVirtualPath(plan, written);
    let owner = plan.owner.get(virtual);
    if (owner === undefined) {
      const owners = directoryOwners.get(virtual);
      if (owners?.size === 1) owner = [...owners][0];
    }
    if (owner === undefined || owner === 'tooling') return undefined;
    const now = posix.join(packageDirectory(plan, owner), physicalPath(plan, owner, virtual));
    return now === posix.join(core, written) ? undefined : now;
  };
  const dead: string[] = [];
  for (const path of plan.options.listFiles('.')) {
    if (UNREWRITTEN.includes(path) || !TEXT_FILE.test(path)) continue;
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    const text = readFileSync(absolute, 'utf8');
    if (isGenerated(text)) continue;
    const home = packageOf(plan, path);
    const before = home === undefined ? path : posix.join(core, home.virtual);
    const check = (written: string, reached: string): boolean => {
      const now = movedTo(reached);
      if (now !== undefined) dead.push(`${path}: ${written} reaches ${reached}, now ${now}.`);
      return now !== undefined;
    };
    for (const { text: written } of relativePaths(path, text)) {
      const clean = written.replace(/[?#].*$/, '');
      const reached = posix.normalize(posix.join(posix.dirname(path), clean));
      if (check(written, reached) || existsSync(join(root, reached))) continue;
      const earlier = posix.normalize(posix.join(posix.dirname(before), clean));
      if (earlier !== reached) check(written, earlier);
    }
    const whole = new RegExp(`(?<![\\w/.-])${escapeRegExp(core)}/[\\w.@/-]*[\\w@-]`, 'g');
    for (const match of text.matchAll(whole)) check(match[0], match[0]);
    const coreSegments = core.split('/');
    for (const match of text.matchAll(SEGMENT_RUN)) {
      const segments = literalSegments(match[0]);
      const at = segments.findIndex((_, index) =>
        coreSegments.every((segment, offset) => segments[index + offset] === segment),
      );
      if (at === -1 || segments.length <= at + coreSegments.length) continue;
      check(match[0].replaceAll(/\s+/g, ' '), posix.join(...segments.slice(at)));
    }
  }
  return dead;
}

type ExportedNames = { runtime: string[]; types: string[] };

function clauseNames(declaration: ts.ExportDeclaration): ExportedNames | undefined {
  const clause = declaration.exportClause;
  if (clause === undefined) return undefined;
  if (ts.isNamespaceExport(clause)) {
    return declaration.isTypeOnly
      ? { runtime: [], types: [clause.name.text] }
      : { runtime: [clause.name.text], types: [] };
  }
  const names: ExportedNames = { runtime: [], types: [] };
  for (const element of clause.elements) {
    if (declaration.isTypeOnly || element.isTypeOnly) names.types.push(element.name.text);
    else names.runtime.push(element.name.text);
  }
  return names;
}

function reexport(names: ExportedNames, specifier: string): string {
  const lines: string[] = [];
  if (names.runtime.length > 0)
    lines.push(`export { ${names.runtime.join(', ')} } from '${specifier}';`);
  if (names.types.length > 0)
    lines.push(`export type { ${names.types.join(', ')} } from '${specifier}';`);
  return lines.join('\n');
}

function barrelHeader(name: string): string {
  return `// ${GENERATED_MARKER}: the barrel of ${PACKAGE_SCOPE}${name}, which core's barrel re-exports by name.\n`;
}

/**
 * What core's barrel says instead of a statement that re-exports a package's module. A family's
 * component module is re-exported from that module (`@lostgradient/<family>/components/<component>/
 * index.ts`), keeping the statement's clause, which is what `generate-root-registries.ts` writes:
 * importing a family's barrel would evaluate every member's stylesheet where core named its first
 * member, and change the order of the rules in `cinder.components`. Anything else is re-exported
 * by name from the package's barrel.
 */
function coreReexport(
  plan: Plan,
  entry: {
    statement: ts.ExportDeclaration;
    source: string;
    name: string;
    target: string;
    names: ExportedNames;
  },
): string {
  const { statement, source, name, target, names } = entry;
  if (kindOf(name) !== 'family' || !target.startsWith('src/components/')) {
    return reexport(names, `${PACKAGE_SCOPE}${name}`);
  }
  const own = specifierFor(name, target, plan.components.get(name));
  addExportKey(plan, name, own.exportKey);
  const moduleSpecifier = statement.moduleSpecifier;
  if (statement.exportClause === undefined || moduleSpecifier === undefined) {
    return reexport(names, own.specifier);
  }
  return `${source.slice(statement.getStart(), moduleSpecifier.getStart())}'${own.specifier}'${source.slice(moduleSpecifier.getEnd(), statement.getEnd())}`;
}

/**
 * Moves each statement of core's barrel that re-exports a selected package into that package's
 * barrel, and leaves core re-exporting the same names from the package (or, for a family of several
 * components, from each component's module), so core's export list and its CSS order are unchanged.
 * An `export *` becomes the names it exports, which `export-names.ts` can read.
 */
function splitBarrel(plan: Plan): void {
  const { core } = plan.options;
  const path = posix.join(core, BARREL);
  const source = read(plan, path);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const moved = new Map<string, string[]>();
  const replacements: { start: number; end: number; text: string }[] = [];
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const target = resolveVirtual(plan, BARREL, specifier);
    const name = target === undefined ? undefined : plan.owner.get(target);
    if (target === undefined || name === undefined || !plan.extracted.has(name)) continue;
    let names = clauseNames(statement);
    if (names === undefined) {
      const absolute = join(plan.options.root, currentPath(plan, name, target));
      const all = exportNames(absolute);
      names = { runtime: all.runtime.filter((entry) => entry !== 'default'), types: all.types };
    }
    const statements = moved.get(name) ?? [];
    statements.push(source.slice(statement.getFullStart(), statement.getEnd()).trim());
    moved.set(name, statements);
    replacements.push({
      start: statement.getStart(),
      end: statement.getEnd(),
      text: coreReexport(plan, { statement, source, name, target, names }),
    });
  }
  if (replacements.length === 0) return;
  let next = source;
  for (const { start, end, text } of replacements.toSorted((a, b) => b.start - a.start)) {
    next = `${next.slice(0, start)}${text}${next.slice(end)}`;
  }
  write(plan, path, next);
  for (const [name, statements] of moved) {
    const barrel = posix.join('components', name, BARREL);
    const absolute = join(plan.options.root, barrel);
    const existing =
      plan.pending.get(barrel) ?? (existsSync(absolute) ? readFileSync(absolute, 'utf8') : '');
    const body = isGenerated(existing) ? existing : barrelHeader(name);
    const normalize = (text: string) => text.replaceAll(/\s+/g, ' ');
    const present = normalize(body);
    const added = statements.filter((statement) => !present.includes(normalize(statement)));
    write(plan, barrel, `${body.trimEnd()}\n\n${added.join('\n\n')}\n`);
  }
}

/** Each package that has no barrel statement yet still gets an (empty) barrel. */
function ensureBarrels(plan: Plan): void {
  for (const name of plan.selected) {
    const barrel = posix.join('components', name, BARREL);
    if (plan.pending.has(barrel) || existsSync(join(plan.options.root, barrel))) continue;
    write(plan, barrel, `${barrelHeader(name)}\nexport {};\n`);
  }
}

export interface OrderEntry {
  /** The virtual path of the stylesheet. */
  path: string;
  /** The comment that preceded its import, verbatim. */
  comment?: string;
  /** The comment followed the previous import with no blank line between (the region's end). */
  tight?: true;
}

export interface ComponentsCssOrder {
  $comment: string;
  imports: OrderEntry[];
  /** Text after the last import. */
  trailer?: string;
  /** Component stylesheets components.css does not import (their component entry does). */
  unlisted?: string[];
}

const IMPORT_LINE = /@import\s+(['"])([^'"]+)\1\s*;/g;

/** The order file for a `components.css` that still imports every stylesheet by relative path. */
export function readComponentsCssOrder(text: string): ComponentsCssOrder {
  const imports: OrderEntry[] = [];
  let last = 0;
  for (const match of text.matchAll(IMPORT_LINE)) {
    const specifier = match[2] ?? '';
    if (!specifier.startsWith('.')) {
      throw new Error(
        `${COMPONENTS_CSS} imports ${specifier}; create ${ORDER_FILE} from a components.css that imports by relative path.`,
      );
    }
    const between = text.slice(last, match.index);
    const comment = between.trim();
    imports.push({
      path: joinVirtual(COMPONENTS_CSS, specifier),
      ...(comment === '' ? {} : { comment }),
      ...(comment !== '' && last > 0 && !/^[ \t]*\n[ \t]*\n/.test(between)
        ? { tight: true as const }
        : {}),
    });
    last = (match.index ?? 0) + match[0].length;
  }
  const trailer = text.slice(last).trim();
  return {
    $comment:
      "The order of core's components.css (P-COR-101). extract-families.ts regenerates components.css from it; a component stylesheet missing from it fails the extraction, so place a new component here.",
    imports,
    ...(trailer === '' ? {} : { trailer }),
  };
}

/**
 * How core's `components.css` names an ordered stylesheet, as `generate-root-registries.ts`
 * writes it: by relative path while core holds it, by the holding package's subpath once a package
 * does, each stylesheet on its own line, so the order never changes.
 */
function stylesheetSpecifier(plan: Plan, path: string): string {
  const name = plan.owner.get(path);
  if (name === undefined) throw new Error(`${ORDER_FILE} names ${path}, which no package holds.`);
  if (packageDirectory(plan, name) === plan.options.core)
    return relativeSpecifier(COMPONENTS_CSS, path);
  return specifierFor(name, path, plan.components.get(name)).specifier;
}

/** The order file, created from today's `components.css` on the first run, before any rewrite. */
function readOrder(plan: Plan): ComponentsCssOrder {
  const { core, root } = plan.options;
  const orderPath = posix.join(core, ORDER_FILE);
  if (plan.pending.has(orderPath) || existsSync(join(root, orderPath))) {
    return JSON.parse(read(plan, orderPath)) as ComponentsCssOrder;
  }
  const order = readComponentsCssOrder(read(plan, posix.join(core, COMPONENTS_CSS)));
  const listed = new Set(order.imports.map((entry) => entry.path));
  const unlisted = componentStylesheets(plan).filter((path) => !listed.has(path));
  if (unlisted.length > 0) order.unlisted = unlisted;
  write(plan, orderPath, `${JSON.stringify(order, null, 2)}\n`);
  return order;
}

/** Every family component's own stylesheet, `src/components/<component>/<component>.css`. */
function componentStylesheets(plan: Plan): string[] {
  return [...plan.owner]
    .filter(([path, name]) => {
      const component = /^src\/components\/([^/]+)\/([^/]+)\.css$/.exec(path);
      return component !== null && component[1] === component[2] && name !== 'core';
    })
    .map(([path]) => path)
    .toSorted();
}

/** Regenerates core's `components.css` and each extracted family's stylesheet from the order file. */
function regenerateStylesheets(plan: Plan): void {
  const { core } = plan.options;
  const orderPath = posix.join(core, ORDER_FILE);
  const order = readOrder(plan);
  const listed = new Set([...order.imports.map((entry) => entry.path), ...(order.unlisted ?? [])]);
  const missing = componentStylesheets(plan).filter((path) => !listed.has(path));
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} in no line of ${orderPath}: place each in "imports" (or "unlisted"), then re-run.`,
    );
  }
  const lines: string[] = [];
  for (const entry of order.imports) {
    if (entry.comment !== undefined) lines.push(...(entry.tight ? [] : ['']), entry.comment);
    lines.push(`@import '${stylesheetSpecifier(plan, entry.path)}';`);
  }
  if (order.trailer !== undefined) lines.push('', order.trailer);
  write(plan, posix.join(core, COMPONENTS_CSS), `${lines.join('\n').trim()}\n`);
  for (const name of plan.extracted) {
    if (kindOf(name) !== 'family') continue;
    const own = order.imports.filter((entry) => plan.owner.get(entry.path) === name);
    const imports = own.map(
      (entry) => `@import '${relativeSpecifier(PACKAGE_STYLESHEET, entry.path)}';`,
    );
    write(
      plan,
      posix.join('components', name, PACKAGE_STYLESHEET),
      `/* ${GENERATED_MARKER}: the stylesheet of ${PACKAGE_SCOPE}${name}, in ${ORDER_FILE}'s order. */\n${imports.join('\n')}\n`,
    );
  }
}

type Manifest = {
  name?: string;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
};

const BUILTIN = /^(?:node:|bun:|bun$|\$)/;
const CORE_PACKAGE = `${PACKAGE_SCOPE}cinder`;

/** Source text without its comments, so a usage example in a comment adds no dependency. */
function withoutComments(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/<!--[\s\S]*?-->/g, '')
    .replaceAll(/(^|[^:'"`\w])\/\/.*$/gm, '$1');
}

function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || BUILTIN.test(specifier))
    return undefined;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  // Text a pattern caught in a generated or minified file is no package name.
  return name !== undefined && /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name)
    ? name
    : undefined;
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b)));
}

function readManifest(plan: Plan, path: string): Manifest {
  return JSON.parse(read(plan, path)) as Manifest;
}

const ENTRY = (path: string) => ({
  types: `./.types/${path.replace(/\.ts$/, '.d.ts')}`,
  svelte: `./${path}`,
  default: `./${path}`,
});

/** The dependencies a package's files import, as the version core's manifest gives each. */
/** The names of the repository's verification workspaces, `testing/*`. */
function testingPackages(plan: Plan): Set<string> {
  const directory = join(plan.options.root, 'testing');
  const names = new Set<string>();
  if (!existsSync(directory)) return names;
  for (const entry of readdirSync(directory)) {
    const manifest = join(directory, entry, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
    if (name !== undefined) names.add(name);
  }
  return names;
}

function scanDependencies(
  plan: Plan,
  name: string,
  coreManifest: Manifest,
): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  problems: string[];
} {
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  const problems: string[] = [];
  const versions = { ...coreManifest.devDependencies, ...coreManifest.dependencies };
  const verification = testingPackages(plan);
  for (const [path, owner] of plan.owner) {
    if (owner !== name || !CODE_FILE.test(path)) continue;
    const text = withoutComments(read(plan, currentPath(plan, name, path)));
    for (const match of text.matchAll(SPECIFIER)) {
      const dependency = packageNameOf(match[3] ?? '');
      if (dependency === undefined || dependency === `${PACKAGE_SCOPE}${name}`) continue;
      if (dependency === CORE_PACKAGE) {
        problems.push(`${path} imports ${CORE_PACKAGE}, which depends on ${name}.`);
        continue;
      }
      const workspace = dependency.startsWith(PACKAGE_SCOPE);
      const version = workspace ? 'workspace:*' : versions[dependency];
      if (version === undefined) {
        problems.push(`${path} imports ${dependency}, which core's manifest does not list.`);
        continue;
      }
      // A verification workspace (testing/*) is only ever a development dependency, whatever file
      // names it: a test helper's name need not say it is one.
      if (isTestFile(path) || path.startsWith('scripts/') || verification.has(dependency)) {
        devDependencies[dependency] = version;
      } else dependencies[dependency] = version;
    }
  }
  for (const dependency of Object.keys(dependencies)) delete devDependencies[dependency];
  // The type declarations core lists for a dependency come with it.
  for (const dependency of [...Object.keys(dependencies), ...Object.keys(devDependencies)]) {
    const types = `@types/${dependency.replace(/^@/, '').replace('/', '__')}`;
    const version = versions[types];
    if (version !== undefined) devDependencies[types] = version;
  }
  return { dependencies, devDependencies, problems };
}

/** Writes each extracted package's manifest and core's, from the map and the imports. */
function writeManifests(plan: Plan): void {
  const { core, families } = plan.options;
  const corePath = posix.join(core, 'package.json');
  const coreManifest = readManifest(plan, corePath);
  const graph = new Map<string, Set<string>>();
  for (const name of [...plan.extracted].toSorted()) {
    const path = posix.join('components', name, 'package.json');
    if (!plan.pending.has(path) && !existsSync(join(plan.options.root, path))) continue;
    const manifest = readManifest(plan, path);
    const kind = kindOf(name);
    const exportsField: Record<string, unknown> = { '.': ENTRY('src/index.ts') };
    if (kind === 'family') {
      exportsField['./styles'] = './src/styles/index.css';
      exportsField['./*.css'] = './src/components/*/*.css';
      exportsField['./components/*'] = './src/components/*';
    } else {
      exportsField['./*.css'] = './src/styles/*.css';
      exportsField['./*'] = './src/*';
    }
    const previous = manifest.exports ?? {};
    // Keep the module keys an earlier run added; the scaffold's own keys are replaced above.
    const keys = new Set([
      ...Object.keys(previous).filter((key) => !(key in exportsField) && key !== './styles'),
      ...(plan.exportKeys.get(name) ?? []),
    ]);
    for (const key of [...keys].toSorted()) {
      exportsField[key] = key.startsWith('./scripts/') ? key : `./src/${key.slice(2)}`;
    }
    const scanned = scanDependencies(plan, name, coreManifest);
    plan.result.warnings.push(...scanned.problems);
    const dependencies: Record<string, string> = { svelte: 'catalog:', ...scanned.dependencies };
    for (const dependency of families.packages[name]?.dependencies ?? []) {
      dependencies[dependency === 'tooling' ? TOOLING_PACKAGE : `${PACKAGE_SCOPE}${dependency}`] =
        'workspace:*';
    }
    // The scaffold's tools and what the files import now: a test that moved on takes its own.
    const devDependencies: Record<string, string> = {
      ...(packageManifest(name)['devDependencies'] as Record<string, string>),
      ...scanned.devDependencies,
    };
    for (const dependency of Object.keys(dependencies)) delete devDependencies[dependency];
    const edges = new Set<string>();
    for (const dependency of [...Object.keys(dependencies), ...Object.keys(devDependencies)]) {
      if (!dependency.startsWith(PACKAGE_SCOPE)) continue;
      const target = dependency.slice(PACKAGE_SCOPE.length);
      if (target === 'cinder') {
        plan.result.warnings.push(`${name} imports ${PACKAGE_SCOPE}cinder, which depends on it.`);
      }
      if (plan.extracted.has(target)) edges.add(target);
    }
    graph.set(name, edges);
    const hasDirectory = (directory: string) =>
      plan.owner.has(directory) ||
      [...plan.owner].some(([file, owner]) => owner === name && file.startsWith(`${directory}/`));
    const sources = hasDirectory('scripts') ? 'src scripts' : 'src';
    const scripts = { ...manifest.scripts };
    const checks = [
      `oxlint --deny-warnings --type-aware --tsconfig ./tsconfig.json ${sources}`,
      'bun ../../scripts/check-inherited-key-reads.ts',
    ];
    if (hasDirectory('src/components')) {
      checks.push(
        'bun ../../internal/component-tooling/scripts/check-prop-conventions.ts src/components',
      );
    }
    if (name === 'foundation') {
      checks.push('bun ../../internal/component-tooling/scripts/check-foundation-imports.ts');
    }
    // A moved script core's own scripts ran (`bun run tokens:check` in its lint) joins the lint.
    for (const moved of Object.keys(movedScripts(plan, coreManifest, name))) {
      const invoked = Object.values(coreManifest.scripts ?? {}).some((command) =>
        new RegExp(`\\bbun run ${moved.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(
          command,
        ),
      );
      if (invoked) checks.push(`bun run ${moved}`);
    }
    // …and stays there on a later run, once core no longer holds it.
    for (const step of (manifest.scripts?.['lint'] ?? '').split(' && ')) {
      if (/^bun run \S+$/.test(step) && !checks.includes(step)) checks.push(step);
    }
    scripts['lint'] = checks.join(' && ');
    scripts['lint:fix'] =
      `oxlint --deny-warnings --fix --type-aware --tsconfig ./tsconfig.json ${sources}`;
    scripts['test'] = (scripts['test'] ?? '')
      .replace(/ src$/, ` ${sources}`)
      .replace(' --pass-with-no-tests', '');
    // A package whose every test the map gives to core, or the isolated lane (`*.slow.test.ts`,
    // `*.integration.test.ts`), has none in this lane, and `bun test` fails on a run that finds
    // no test file.
    const tested = [...plan.owner].some(
      ([file, owner]) =>
        owner === name &&
        /\.test\.[cm]?[jt]s$/.test(file) &&
        !/\.(?:slow|integration)\.test\./.test(file),
    );
    if (!tested) {
      scripts['test'] = scripts['test'].replace(
        'bun-test-junit.ts ',
        'bun-test-junit.ts --pass-with-no-tests ',
      );
    }
    // svelte-check fails on a package with no Svelte file; TypeScript checks one of those.
    const svelte = [...plan.owner].some(
      ([file, owner]) => owner === name && file.endsWith('.svelte'),
    );
    // Like every component workspace, the browser configuration checks the source alone (no Bun
    // or Node types), and the full one the tests and tooling (workspace-contract).
    scripts['typecheck'] = svelte
      ? 'svelte-check --workspace . --tsconfig ./tsconfig.browser.json --fail-on-warnings && svelte-check --workspace . --tsconfig ./tsconfig.json --fail-on-warnings'
      : 'tsc --noEmit -p ./tsconfig.browser.json && tsc --noEmit -p ./tsconfig.json';
    Object.assign(scripts, movedScripts(plan, coreManifest, name), metadataScripts(kind));
    const next: Manifest = {
      ...manifest,
      exports: exportsField,
      scripts,
      dependencies: sortRecord(dependencies),
      devDependencies: sortRecord(devDependencies),
    };
    write(plan, path, `${JSON.stringify(next, null, 2)}\n`);
  }
  const cycles = findCycles(graph);
  if (cycles.length > 0) {
    throw new Error(
      `The extracted packages' manifests form cycles: ${cycles.map((cycle) => cycle.join(' -> ')).join('; ')}.`,
    );
  }
  writeCoreManifest(plan, corePath, coreManifest);
}

/** Core's scripts that run a file `name` now holds, which move to `name`'s manifest. */
function movedScripts(plan: Plan, coreManifest: Manifest, name: string): Record<string, string> {
  const moved: Record<string, string> = {};
  for (const [script, command] of Object.entries(coreManifest.scripts ?? {})) {
    const paths = [...command.matchAll(/\b((?:src|scripts)\/[\w./-]+\.ts)\b/g)].map(
      (match) => match[1] ?? '',
    );
    if (
      paths.length > 0 &&
      paths.every((path) => plan.owner.get(path) === name && plan.extracted.has(name))
    ) {
      moved[script] = command;
    }
  }
  return moved;
}

function writeCoreManifest(plan: Plan, path: string, manifest: Manifest): void {
  const scripts = { ...manifest.scripts };
  for (const name of plan.extracted) {
    for (const script of Object.keys(movedScripts(plan, manifest, name))) {
      delete scripts[script];
      for (const [other, command] of Object.entries(scripts)) {
        scripts[other] = command
          .replaceAll(` && bun run ${script}`, '')
          .replaceAll(`bun run ${script} && `, '');
      }
    }
  }
  const dependencies = { ...manifest.dependencies };
  for (const name of plan.extracted) dependencies[`${PACKAGE_SCOPE}${name}`] = 'workspace:*';
  const exportsField: Record<string, unknown> = { ...manifest.exports };
  for (const [key, value] of Object.entries(exportsField)) {
    const target = typeof value === 'string' ? value : (value as { default?: string }).default;
    if (target === undefined || !target.startsWith('./src/')) continue;
    const virtual = target.slice(2);
    const owner = plan.owner.get(virtual);
    if (owner === undefined || !plan.extracted.has(owner)) continue;
    // Core keeps the subpath: a one-line entry re-exports it from the package that now holds it.
    const entry = `src/exports/${key.slice(2).replaceAll('/', '-')}.ts`;
    const specifier = specifierFor(owner, virtual, plan.components.get(owner)).specifier;
    write(
      plan,
      posix.join(plan.options.core, entry),
      `// ${GENERATED_MARKER}: core's ${key} subpath, which ${PACKAGE_SCOPE}${owner} now holds.\nexport * from '${specifier}';\n`,
    );
    exportsField[key] = ENTRY(entry);
  }
  write(
    plan,
    path,
    `${JSON.stringify({ ...manifest, exports: exportsField, scripts, dependencies: sortRecord(dependencies) }, null, 2)}\n`,
  );
}

type AllowlistFile = { description: string; entries: { file: string }[] };

/** Moves each inherited-key-reads allowlist entry to the package that now holds its file. */
function shardAllowlists(plan: Plan): void {
  const { core } = plan.options;
  const corePath = posix.join(core, ALLOWLIST);
  if (!plan.pending.has(corePath) && !existsSync(join(plan.options.root, corePath))) return;
  const coreList = JSON.parse(read(plan, corePath)) as AllowlistFile;
  const kept: AllowlistFile['entries'] = [];
  const moved = new Map<string, AllowlistFile['entries']>();
  for (const entry of coreList.entries) {
    const owner = plan.owner.get(entry.file);
    if (owner === undefined || !plan.extracted.has(owner)) kept.push(entry);
    else moved.set(owner, [...(moved.get(owner) ?? []), entry]);
  }
  if (moved.size === 0) return;
  write(plan, corePath, `${JSON.stringify({ ...coreList, entries: kept }, null, 2)}\n`);
  for (const [name, entries] of moved) {
    const path = posix.join('components', name, ALLOWLIST);
    const existing =
      plan.pending.has(path) || existsSync(join(plan.options.root, path))
        ? (JSON.parse(read(plan, path)) as AllowlistFile)
        : { description: coreList.description, entries: [] };
    const all = [...existing.entries, ...entries].toSorted((a, b) => a.file.localeCompare(b.file));
    write(plan, path, `${JSON.stringify({ ...existing, entries: all }, null, 2)}\n`);
  }
}

/**
 * The `metadata` task a family runs (COR-2078): it generates its own components' schema,
 * variables and examples copy into its `.metadata/`. Core's `metadata` task runs after every
 * dependency's (`^metadata` in `turbo.json`) and copies each family component's files into core's
 * `.metadata/` (`generate-component-artifacts.ts`), so `@lostgradient/cinder/<component>/schema`,
 * `/variables` and `/examples` keep resolving.
 */
function metadataScripts(kind: string): Record<string, string> {
  return kind === 'family'
    ? {
        metadata:
          'bun ../../internal/component-tooling/scripts/generate-component-artifacts.ts --package-root .',
      }
    : {};
}

/** Plans, and unless it is a dry run applies, one extraction. */
export async function extractFamilies(options: ExtractOptions): Promise<ExtractResult> {
  const plan: Plan = {
    options: {
      dryRun: false,
      listFiles: (directory) => walkFiles(options.root, directory),
      format: async (_path, text) => text,
      ...options,
    },
    extracted: new Set(),
    selected: [],
    owner: new Map(),
    components: new Map(),
    result: {
      selected: [],
      moves: [],
      created: [],
      written: [],
      rewrites: [],
      warnings: [],
      dead: [],
    },
    exportKeys: new Map(),
    pending: new Map(),
    location: new Map(),
    originals: new Map(),
    relocateCoreTests: false,
  };
  const { root, core, families } = plan.options;
  for (const name of Object.keys(families.packages)) {
    if (!KEPT.has(name) && isExtractedPackage(root, core, name)) plan.extracted.add(name);
  }
  // Ownership reads the tree before this run, so packages selected now are listed from core.
  const problems = buildOwnership(plan);
  if (problems.length > 0) {
    throw new Error(
      `families.json is stale; run derive-families.ts and commit the diff:\n- ${problems.join('\n- ')}`,
    );
  }
  const { ready, deferred } = closeSelection(
    plan,
    selectPackages(families, plan.options.selection, plan.extracted),
  );
  if (plan.options.selection.kind === 'packages' && deferred.length > 0) {
    throw new Error(deferred.join('\n'));
  }
  plan.result.warnings.push(...deferred.map((reason) => `deferred: ${reason}`));
  plan.selected = ready;
  plan.relocateCoreTests = Object.entries(families.packages).every(
    ([name, entry]) => entry.kind !== 'family' || plan.extracted.has(name) || ready.includes(name),
  );
  plan.result.selected = ready;
  const cycles = selectionCycles(plan);
  if (cycles.length > 0) {
    throw new Error(
      `The selection's packages would cycle through what their files import: ${cycles.map((cycle) => cycle.join(' -> ')).join('; ')}. Re-derive families.json.`,
    );
  }
  readOrder(plan);
  planMoves(plan);
  scaffold(plan);
  for (const name of plan.selected) plan.extracted.add(name);
  if (!plan.options.dryRun) applyMoves(plan);
  splitBarrel(plan);
  ensureBarrels(plan);
  const directories = [core, ...[...plan.extracted].map((name) => posix.join('components', name))];
  for (const directory of directories) {
    for (const path of plan.options.listFiles(directory))
      rewriteFile(plan, posix.join(directory, path));
  }
  regenerateStylesheets(plan);
  writeManifests(plan);
  writeTsconfigs(plan);
  shardAllowlists(plan);
  for (const path of plan.options.listFiles('.')) rewriteRepositoryPaths(plan, path);
  if (!plan.options.dryRun) {
    for (const path of plan.result.written) {
      // Everything the run wrote that Prettier formats, so `format:check` holds after it.
      if (!/\.(?:ts|js|mjs|css|json|jsonc|svelte|md|ya?ml)$/.test(path)) continue;
      const absolute = join(root, path);
      const text = readFileSync(absolute, 'utf8');
      const formatted = await plan.options.format(absolute, text);
      if (formatted !== text) writeFileSync(absolute, formatted);
    }
    // A file the run wrote and formatting returned to what it was is not a change.
    plan.result.written = plan.result.written.filter(
      (path) => readFileSync(join(root, path), 'utf8') !== plan.originals.get(path),
    );
    await syncExampleArtifacts(plan);
    plan.result.dead = deadPaths(plan);
  }
  return plan.result;
}

/**
 * Core's directory, `components/core`. Extraction runs after COR-2082's rename
 * (`rename-cinder-to-core.ts`), which gives core that name.
 */
export function defaultCore(root: string): string {
  const core = 'components/core';
  if (existsSync(join(root, core, 'package.json'))) return core;
  throw new Error(
    `${core} does not exist: run internal/component-tooling/scripts/rename-cinder-to-core.ts first.`,
  );
}

function trackedFiles(root: string, directory: string): string[] {
  const result = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', directory],
    { cwd: root, stdout: 'pipe', stderr: 'inherit' },
  );
  if (result.exitCode !== 0) throw new Error(`git ls-files ${directory} failed.`);
  const prefix = directory === '.' ? '' : `${directory}/`;
  return result.stdout
    .toString()
    .split('\0')
    .filter((path) => path !== '' && existsSync(join(root, path)))
    .map((path) => path.slice(prefix.length))
    .toSorted();
}

async function prettierFormat(path: string, text: string): Promise<string> {
  const prettier = await import('prettier');
  const options = await prettier.resolveConfig(path);
  const info = await prettier.getFileInfo(path, {
    ignorePath: join(REPOSITORY_ROOT, '.prettierignore'),
  });
  if (info.ignored) return text;
  return prettier.format(text, { ...options, filepath: path });
}

const SIDE_EFFECT_IMPORT = /^\s*import\s+(['"])([^'"\n]+)\1/gm;
const ORGANIZE_IMPORTS_IGNORE = '// organize-imports-ignore';

/** The specifiers of a file's side-effect imports (`import './x.css'`), in order. */
export function sideEffectImports(text: string): string[] {
  return [...text.matchAll(SIDE_EFFECT_IMPORT)].map((match) => match[2] ?? '');
}

/**
 * Formats a rewritten file, unless sorting its imports would move a side-effect import: a
 * rewritten specifier sorts differently (`@lostgradient/input/input.css` before
 * `../button/button.css`), and the order of stylesheet imports is cascade order in a bundle. Such
 * a file keeps its order under `// organize-imports-ignore` and is formatted otherwise.
 */
export async function formatKeepingImportOrder(
  path: string,
  text: string,
  format: (path: string, text: string) => Promise<string>,
): Promise<string> {
  const formatted = await format(path, text);
  const before = sideEffectImports(text);
  if (before.join('\n') === sideEffectImports(formatted).join('\n')) return formatted;
  if (text.includes(ORGANIZE_IMPORTS_IGNORE)) return formatted;
  const pinned = path.endsWith('.svelte')
    ? text.replace(/(<script\b[^>]*>)/, `$1\n  ${ORGANIZE_IMPORTS_IGNORE}`)
    : `${ORGANIZE_IMPORTS_IGNORE}\n${text}`;
  return format(path, pinned);
}

function verify(root: string, rewrites: readonly Rewrite[]): string[] {
  const failures: string[] = [];
  for (const { importer, specifier, target } of rewrites) {
    let resolved: string;
    try {
      resolved = Bun.resolveSync(specifier.split('?')[0] ?? '', dirname(join(root, importer)));
    } catch (error) {
      failures.push(`${importer}: ${specifier} does not resolve (${(error as Error).message}).`);
      continue;
    }
    if (relative(root, resolved) !== target && !resolved.endsWith(target)) {
      failures.push(
        `${importer}: ${specifier} resolves to ${relative(root, resolved)}, not ${target}.`,
      );
    }
  }
  return failures;
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      package: { type: 'string', multiple: true },
      layer: { type: 'string' },
      half: { type: 'string' },
      all: { type: 'boolean' },
      core: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'no-install': { type: 'boolean' },
      'skip-derive-check': { type: 'boolean' },
    },
  });
  let selection: Selection;
  if (values.all === true) selection = { kind: 'all' };
  else if (values.layer !== undefined) {
    const half = values.half === undefined ? undefined : Number(values.half);
    if (half !== undefined && half !== 1 && half !== 2) throw new Error('--half is 1 or 2.');
    selection = {
      kind: 'layer',
      layer: Number(values.layer),
      ...(half === undefined ? {} : { half }),
    };
  } else if (values.package !== undefined) selection = { kind: 'packages', names: values.package };
  else {
    process.stderr.write(
      'Usage: extract-families.ts (--package <name>… | --layer <n> [--half 1|2] | --all) [--core <dir>] [--dry-run] [--no-install]\n',
    );
    return 2;
  }
  const root = REPOSITORY_ROOT;
  const core = values.core ?? defaultCore(root);
  const rules = readRules();
  const families = JSON.parse(readFileSync(FAMILIES_PATH, 'utf8')) as DerivedFamilies;
  if (values['skip-derive-check'] !== true) {
    const current = await renderFamilies(
      deriveFromRepository({ ...rules, packageRoot: core }, root),
    );
    if (current !== readFileSync(FAMILIES_PATH, 'utf8')) {
      process.stderr.write(
        'families.json is stale: run `bun internal/component-tooling/scripts/derive-families.ts` and commit the diff first.\n',
      );
      return 1;
    }
  }
  const dryRun = values['dry-run'] === true;
  const result = await extractFamilies({
    root,
    core,
    families,
    rules,
    selection,
    dryRun,
    listFiles: (directory) => trackedFiles(root, directory),
    format: (path, text) => formatKeepingImportOrder(path, text, prettierFormat),
  });
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(
    `${dryRun ? 'Would extract' : 'Extracted'} ${result.selected.length} package(s): ${result.selected.join(', ')}`,
  );
  out(
    `${result.created.length} created, ${result.moves.length} files moved, ${result.rewrites.length} imports rewritten, ${result.written.length} files written.`,
  );
  for (const warning of result.warnings) out(`warning: ${warning}`);
  // A path that still reaches where a moved file was is a reader the rewrites missed: stop here,
  // unstaged, with every one named, rather than leave it to fail in a test or a browser suite.
  for (const line of result.dead) out(`dead path: ${line}`);
  if (result.dead.length > 0) return 1;
  if (dryRun) {
    for (const { from, to } of result.moves.slice(0, 40)) out(`  ${from} -> ${to}`);
    if (result.moves.length > 40) out(`  … and ${result.moves.length - 40} more moves`);
    return 0;
  }
  if (values['no-install'] !== true) {
    const install = Bun.spawnSync(['bun', 'install'], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (install.exitCode !== 0) return install.exitCode ?? 1;
    const failures = verify(root, result.rewrites);
    for (const failure of failures) out(`unresolved: ${failure}`);
    if (failures.length > 0) return 1;
  }
  const stage = Bun.spawnSync(
    [
      'git',
      'add',
      '-A',
      '--',
      core,
      ...result.selected.map((name) => `components/${name}`),
      ...result.moves.flatMap(({ from, to }) => [from, to]),
      ...result.written,
      'bun.lock',
    ],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  );
  return stage.exitCode ?? 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
