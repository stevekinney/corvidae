/**
 * Derives the Cinder family map (COR-2446) from `family-rules.json` and the import graph.
 *
 * ```sh
 * bun scripts/derive-families.ts          # write families.json
 * bun scripts/derive-families.ts --check  # exit 1 when families.json is stale
 * ```
 *
 * Every directory under the components directory is a component; one a family names belongs to
 * that family, and any other is a single-component family named after itself (a private,
 * underscore-prefixed directory must be named). Every other file is a module, placed by the first
 * move row that matches it. Package dependencies come from source imports (TypeScript, Svelte and
 * CSS `@import`) only: a test or a fixture never adds one. A family may import another family's
 * module while the graph stays acyclic; `subpathExports` lists each such module. A family test or
 * fixture that would need a package depending on its own family moves to core, with every test
 * that imports or builds it, and `testMoves` says why. The derivation fails, naming every problem,
 * when the rules and the tree disagree: a private directory no family names, a file no move row
 * places, a package cycle, or a test helper that imports a component.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';

import { format } from 'prettier';

import { isGenerated, PACKAGE_SCOPE, virtualPathFor } from './split-layout.ts';

export interface FamilyRule {
  name: string;
  components: string[];
  reason: string;
}

export type MoveCondition =
  'names-sibling-package' | 'names-component-stylesheet' | 'component-free' | 'companion-test';

export interface MoveRule {
  patterns: string[];
  target: string;
  when?: MoveCondition;
  helper?: boolean;
  note?: string;
}

export interface FamilyRules {
  packageRoot: string;
  componentsDirectory: string;
  families: FamilyRule[];
  moves: MoveRule[];
}

export type PackageKind = 'family' | 'foundation' | 'tokens' | 'core' | 'tooling';

export interface DerivedPackage {
  kind: PackageKind;
  layer: number;
  components: string[];
  dependencies: string[];
  modules: string[];
}

export interface TestMove {
  file: string;
  from: string;
  to: string;
  because: string;
}

export interface DerivedFamilies {
  summary: {
    packages: number;
    multiComponentFamilies: number;
    singleComponentFamilies: number;
    layerSizes: number[];
  };
  layers: string[][];
  packages: Record<string, DerivedPackage>;
  testMoves: TestMove[];
  /** Each family module another package imports, which its package exports by subpath, with its importers. */
  subpathExports: Record<string, string[]>;
}

/** The rules or the tree disagree; `problems` names each disagreement. */
export class FamilyDerivationError extends Error {
  readonly problems: string[];
  /** The map the rules would give were the problems allowed; absent while the packages cycle. */
  readonly partial: DerivedFamilies | undefined;
  constructor(problems: string[], partial?: DerivedFamilies) {
    super(`derive-families found ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    this.name = 'FamilyDerivationError';
    this.problems = problems;
    this.partial = partial;
  }
}

/** The packages that are not families. */
export const SHARED_PACKAGES: readonly PackageKind[] = ['foundation', 'tokens', 'core', 'tooling'];
const BY_IMPORTS = 'by-imports';
const COMPANION = 'companion';

const CODE_FILE = /\.(?:ts|svelte|js|mjs|css)$/;
const TEST_FILE =
  /(?:^|\/)(?:test|__test-helpers__|__fixtures__)\/|\.(?:test|bench)\.|-test\.svelte$|-test-|(?:^|[./_-])(?:fixtures?|test-helpers|test-support|test-utilities|test-harness)(?:[./-]|$)/;
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|@import\s+(?:url\(\s*)?)(['"])([^'"\n]+)\1/g;
const SIBLING_PACKAGE_PATH =
  /components\/(?:chat|editor|terminal)\/(?:src|components\.json)|['"]\.\.['"],\s*['"](?:chat|editor|terminal)['"],\s*['"]src['"]/;
// The last alternative is the same path once the split names it by package (`split-layout.ts`).
const COMPONENT_STYLESHEET_PATH =
  /src\/components\/|components\.css|\.\.\/components\/|['"]components['"]\s*[,)]|@lostgradient\/(?!tokens\/|foundation\/|cinder\/)[\w-]+\/(?:components\/|[\w-]+\.css['"]|styles['"])/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

function importSpecifiers(content: string): string[] {
  return [...content.matchAll(SPECIFIER)].map((match) => match[2] ?? '');
}

function resolveImport(
  files: ReadonlyMap<string, string>,
  from: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier.split('?')[0] ?? ''));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.svelte`,
    `${base}.svelte.ts`,
    `${base}/index.ts`,
    base.replace(/\.js$/, '.ts'),
  ];
  return candidates.find((candidate) => files.has(candidate));
}

/**
 * The files of a split tree (see `split-layout.ts`) that a specifier names: a relative one as
 * {@link resolveImport} resolves it; a package one of the split by its virtual path, and a
 * generated barrel or stylesheet as every file it names in turn.
 */
function resolveSplitImport(
  files: ReadonlyMap<string, string>,
  split: SplitPackages,
  from: string,
  specifier: string,
  seen = new Set<string>(),
): string[] {
  if (specifier.startsWith('.')) {
    const target = resolveImport(files, from, specifier);
    return target === undefined ? [] : [target];
  }
  const named = virtualPathFor(specifier);
  if (named === undefined || !split.packages.has(named.name)) return [];
  // A package's generated barrel shares its virtual path with core's, so it is looked up first.
  const key = `${named.name}:${named.path}`;
  const generated = split.generated.get(key);
  if (generated === undefined) return files.has(named.path) ? [named.path] : [];
  if (seen.has(key)) return [];
  seen.add(key);
  return importSpecifiers(generated).flatMap((inner) =>
    resolveSplitImport(files, split, named.path, inner, seen),
  );
}

/** The packages a split tree holds and its generated files, keyed `<package>:<virtual path>`. */
export interface SplitPackages {
  packages: ReadonlySet<string>;
  generated: ReadonlyMap<string, string>;
}

const UNSPLIT: SplitPackages = { packages: new Set(['tooling']), generated: new Map() };
const CORE_PACKAGE = `${PACKAGE_SCOPE}cinder`;
const CORE_BARREL = 'src/index.ts';

function globsMatch(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(path));
}

/** Test file stems from the longest to the shortest: `a.b.test.ts` gives `a.b`, then `a`. */
function companionCandidates(path: string): string[] {
  const directory = posix.dirname(path);
  const name = posix.basename(path);
  const testIndex = name.search(/\.test\.(?:ts|svelte)$/);
  if (testIndex <= 0) return [];
  const parts = name.slice(0, testIndex).split('.');
  const candidates: string[] = [];
  for (let length = parts.length; length > 0; length -= 1) {
    const stem = posix.join(directory, parts.slice(0, length).join('.'));
    candidates.push(`${stem}.ts`, `${stem}.svelte.ts`, `${stem}.svelte`, stem);
  }
  return candidates;
}

interface Placement {
  owner: string;
  rule: number | 'component' | 'unplaced';
}

interface Context {
  files: ReadonlyMap<string, string>;
  rules: FamilyRules;
  imports: Map<string, string[]>;
  componentOf: Map<string, string>;
  problems: string[];
}

function componentDirectoryOf(context: Context, path: string): string | undefined {
  const prefix = `${context.rules.componentsDirectory}/`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return undefined;
  const directory = rest.slice(0, slash);
  return context.componentOf.has(directory) ? directory : undefined;
}

/** Whether any file reached through test files only is inside a component directory. */
function reachesComponent(
  context: Context,
  start: string,
  familyModules = false,
): string | undefined {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const target of context.imports.get(file) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      if (componentDirectoryOf(context, target) !== undefined) return target;
      if (isTestFile(target)) queue.push(target);
      else if (familyModules) {
        // A module a row gives a family counts as that family's, like a component.
        const owner = placeByRows(context, target, false).owner;
        if (familyOf(owner)) return target;
      }
    }
  }
  return undefined;
}

function placeByRows(context: Context, path: string, allowCompanion: boolean): Placement {
  for (const [index, row] of context.rules.moves.entries()) {
    if (!globsMatch(row.patterns, path)) continue;
    const content = context.files.get(path) ?? '';
    if (row.when === 'names-sibling-package' && !SIBLING_PACKAGE_PATH.test(content)) continue;
    if (row.when === 'names-component-stylesheet' && !COMPONENT_STYLESHEET_PATH.test(content))
      continue;
    if (row.when === 'component-free' && reachesComponent(context, path, true) !== undefined)
      continue;
    if (row.when === 'companion-test') {
      if (!allowCompanion || !isTestFile(path)) continue;
      const companion = companionCandidates(path).find(
        (candidate) => candidate !== path && context.files.has(candidate) && !isTestFile(candidate),
      );
      if (companion === undefined) continue;
      const placed = placeFile(context, companion, false);
      if (placed.rule === 'unplaced') continue;
      return { owner: placed.owner, rule: index };
    }
    return { owner: row.target, rule: index };
  }
  return { owner: '', rule: 'unplaced' };
}

function placeFile(context: Context, path: string, allowCompanion = true): Placement {
  const directory = componentDirectoryOf(context, path);
  if (directory !== undefined) {
    return { owner: context.componentOf.get(directory) as string, rule: 'component' };
  }
  return placeByRows(context, path, allowCompanion);
}

function listComponentDirectories(context: Context): string[] {
  const prefix = `${context.rules.componentsDirectory}/`;
  const directories = new Set<string>();
  for (const path of context.files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash > 0) directories.add(rest.slice(0, slash));
  }
  const claimed = (directory: string) =>
    context.rules.moves.some(
      (row) =>
        row.when === undefined && globsMatch(row.patterns, `${prefix}${directory}/__directory__`),
    );
  return [...directories].filter((directory) => !claimed(directory)).toSorted();
}

function assignComponents(context: Context): void {
  const { rules, problems } = context;
  const directories = new Set(listComponentDirectories(context));
  const familyNames = new Set<string>();
  for (const family of rules.families) {
    if (familyNames.has(family.name)) problems.push(`Family "${family.name}" is listed twice.`);
    familyNames.add(family.name);
    for (const component of family.components) {
      const earlier = context.componentOf.get(component);
      if (earlier !== undefined) {
        problems.push(
          `Component directory "${component}" is in two families, "${earlier}" and "${family.name}".`,
        );
      } else if (!directories.has(component)) {
        problems.push(
          `Family "${family.name}" names "${component}", which is not a component directory under ${rules.componentsDirectory}.`,
        );
      }
      context.componentOf.set(component, family.name);
    }
  }
  for (const directory of directories) {
    if (context.componentOf.has(directory)) continue;
    if (directory.startsWith('_')) {
      problems.push(
        `No rule places the private component directory "${directory}": add it to the family whose component imports it in family-rules.json.`,
      );
    } else if (familyNames.has(directory) || SHARED_PACKAGES.includes(directory as PackageKind)) {
      problems.push(
        `Component directory "${directory}" would be a single-component family whose name is already a package.`,
      );
    }
    context.componentOf.set(directory, directory);
  }
  for (const component of context.componentOf.keys()) {
    if (!directories.has(component)) context.componentOf.delete(component);
  }
}

/**
 * Each component directory's family, with the problems the family rows alone show: a private
 * directory no family names, a directory in two families, a member that is not a directory.
 */
export function assignComponentFamilies(
  files: ReadonlyMap<string, string>,
  rules: FamilyRules,
): { families: Map<string, string>; problems: string[] } {
  const context: Context = {
    files,
    rules,
    imports: new Map(),
    componentOf: new Map(),
    problems: [],
  };
  assignComponents(context);
  return { families: context.componentOf, problems: context.problems };
}

/** The graph's cycles: each strongly connected component with more than one package (Tarjan). */
export function findCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) as number, low.get(next) as number));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) as number, index.get(next) as number));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1) cycles.push(component.toSorted());
  };
  for (const node of [...graph.keys()].toSorted()) if (!index.has(node)) visit(node);
  return cycles.toSorted((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

/** Each package's transitive dependencies. The graph must be acyclic. */
function closures(graph: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const visit = (node: string): Set<string> => {
    const known = result.get(node);
    if (known !== undefined) return known;
    const reached = new Set<string>();
    result.set(node, reached);
    for (const next of graph.get(node) ?? []) {
      reached.add(next);
      for (const deeper of visit(next)) reached.add(deeper);
    }
    return reached;
  };
  for (const node of graph.keys()) visit(node);
  return result;
}

function layersOf(graph: ReadonlyMap<string, ReadonlySet<string>>): Map<string, number> {
  const layer = new Map<string, number>();
  const visit = (node: string): number => {
    const known = layer.get(node);
    if (known !== undefined) return known;
    let value = 0;
    for (const next of graph.get(node) ?? []) value = Math.max(value, visit(next) + 1);
    layer.set(node, value);
    return value;
  };
  for (const node of graph.keys()) visit(node);
  return layer;
}

/**
 * The packages a test needs: the owner of every source module reached through test files of its
 * own package (or undecided ones), and the owner of every test file of another package it imports.
 */
function packagesNeeded(
  context: Context,
  owners: ReadonlyMap<string, string>,
  start: string,
  home: string,
): Map<string, string> {
  const needed = new Map<string, string>();
  const parent = new Map<string, string>();
  const chain = (file: string): string => {
    const files = [file];
    for (let at = parent.get(file); at !== undefined; at = parent.get(at)) files.unshift(at);
    return files.join(' -> ');
  };
  const need = (owner: string | undefined, file: string) => {
    if (owner === undefined || owner === '' || owner === home || owner === 'tooling') return;
    if (!needed.has(owner)) needed.set(owner, chain(file));
  };
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const target of context.imports.get(file) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      parent.set(target, file);
      const owner = owners.get(target);
      if (isTestFile(target) && (owner === undefined || owner === home || owner === BY_IMPORTS)) {
        queue.push(target);
      } else {
        need(owner, target);
      }
    }
  }
  return needed;
}

function buildImports(
  files: ReadonlyMap<string, string>,
  split: SplitPackages,
): Map<string, string[]> {
  const imports = new Map<string, string[]>();
  for (const [path, content] of files) {
    if (!CODE_FILE.test(path)) continue;
    const targets = new Set<string>();
    for (const specifier of importSpecifiers(content)) {
      // A test that imports core's own package (`@lostgradient/cinder`) needs core's barrel; a
      // source module that names it does so in a usage comment.
      if (specifier === CORE_PACKAGE && isTestFile(path) && files.has(CORE_BARREL)) {
        targets.add(CORE_BARREL);
        continue;
      }
      for (const target of resolveSplitImport(files, split, path, specifier)) {
        if (target !== path) targets.add(target);
      }
    }
    imports.set(path, [...targets]);
  }
  return imports;
}

/** Test files that import `file` or name it by path (a test that builds it). */
function importersOf(context: Context, file: string): string[] {
  const name = posix.basename(file);
  // A test builds a fixture by naming its file in a path string; a test file is never built.
  const named = /\.test\./.test(name)
    ? undefined
    : new RegExp(`[/'"\`]${name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
  const importers: string[] = [];
  for (const [path, content] of context.files) {
    if (path === file || !isTestFile(path) || !CODE_FILE.test(path)) continue;
    if ((context.imports.get(path) ?? []).includes(file) || named?.test(content) === true) {
      importers.push(path);
    }
  }
  return importers;
}

interface Graph {
  edges: Map<string, Set<string>>;
  reach: Map<string, Set<string>>;
  /** Family modules another package imports, each with the packages that import it. */
  subpathExports: Map<string, Set<string>>;
}

function sourceGraph(
  context: Context,
  owners: ReadonlyMap<string, string>,
  placements: ReadonlyMap<string, Placement>,
  packages: ReadonlySet<string>,
): Graph | undefined {
  const edges = new Map<string, Set<string>>([...packages].map((name) => [name, new Set()]));
  const witness = new Map<string, string>();
  const subpathExports = new Map<string, Set<string>>();
  for (const [file, targets] of context.imports) {
    const from = owners.get(file);
    if (from === undefined || from === '' || from === BY_IMPORTS || isTestFile(file)) continue;
    for (const target of targets) {
      const to = owners.get(target);
      if (to === undefined || to === '' || to === from || isTestFile(target)) continue;
      edges.get(from)?.add(to);
      if (!witness.has(`${from} ${to}`)) witness.set(`${from} ${to}`, `${file} imports ${target}`);
      // A family module another package imports is one its package must export by subpath.
      if (
        typeof placements.get(target)?.rule === 'number' &&
        !SHARED_PACKAGES.includes(to as PackageKind)
      ) {
        const importers = subpathExports.get(target) ?? new Set<string>();
        importers.add(from);
        subpathExports.set(target, importers);
      }
    }
  }
  const cycles = findCycles(edges);
  for (const cycle of cycles) {
    const members = new Set(cycle);
    const steps = cycle.flatMap((from) =>
      [...(edges.get(from) ?? [])]
        .filter((to) => members.has(to))
        .toSorted()
        .map((to) => `${from} -> ${to} (${witness.get(`${from} ${to}`)})`),
    );
    context.problems.push(`The packages ${cycle.join(', ')} form a cycle: ${steps.join('; ')}.`);
  }
  if (cycles.length > 0) return undefined;
  return { edges, reach: closures(edges), subpathExports };
}

/**
 * Moves `file` to core with every test that imports or builds it, and theirs in turn, recording
 * each move. Core depends on every package, so a test there may need any of them.
 */
function moveToCore(
  context: Context,
  owners: Map<string, string>,
  testMoves: TestMove[],
  file: string,
  because: string,
): void {
  const queue: { file: string; because: string }[] = [{ file, because }];
  while (queue.length > 0) {
    const next = queue.shift() as { file: string; because: string };
    const owner = owners.get(next.file);
    if (owner === undefined || owner === '' || owner === 'core') continue;
    if (owner !== BY_IMPORTS && !movesWithItsTests(owner, next.file)) continue;
    owners.set(next.file, 'core');
    testMoves.push({ file: next.file, from: owner, to: 'core', because: next.because });
    for (const importer of importersOf(context, next.file)) {
      queue.push({ file: importer, because: `it imports or builds ${next.file}, which core owns` });
    }
  }
}

function familyOf(owner: string | undefined): owner is string {
  return (
    owner !== undefined &&
    owner !== '' &&
    owner !== BY_IMPORTS &&
    !SHARED_PACKAGES.includes(owner as PackageKind)
  );
}

/**
 * Whether a file of `owner` can move to core when a test needs it there: any file of a family,
 * and a test or fixture of foundation or tokens. A foundation test that mounts a family (every
 * family depends on foundation) would make the packages cycle through their test dependencies.
 */
function movesWithItsTests(owner: string | undefined, file: string): owner is string {
  if (familyOf(owner)) return true;
  return (owner === 'foundation' || owner === 'tokens') && isTestFile(file);
}

/**
 * Places each fixture and test the by-imports row names: the one family whose tests import it, or
 * that it mounts, when every package it needs is that family or one the family depends on.
 * Otherwise, and whenever two families' tests import it, core takes it.
 */
function decideByImports(
  context: Context,
  owners: Map<string, string>,
  graph: Graph,
  testMoves: TestMove[],
): void {
  const pending = [...owners].filter(([, owner]) => owner === BY_IMPORTS).map(([file]) => file);
  for (const file of pending.toSorted()) {
    if (owners.get(file) !== BY_IMPORTS) continue;
    const importerFamilies = new Set(
      importersOf(context, file)
        .map((importer) => owners.get(importer))
        .filter(familyOf),
    );
    const needed = [...packagesNeeded(context, owners, file, BY_IMPORTS).keys()];
    const candidates =
      importerFamilies.size > 0 ? [...importerFamilies] : needed.filter((name) => familyOf(name));
    const fits = (family: string) =>
      needed.every((name) => name === family || (graph.reach.get(family)?.has(name) ?? false));
    const family = candidates.toSorted().find(fits);
    if (importerFamilies.size > 1) {
      moveToCore(
        context,
        owners,
        testMoves,
        file,
        `tests of ${[...importerFamilies].toSorted().join(', ')} import it`,
      );
    } else if (family === undefined) {
      moveToCore(context, owners, testMoves, file, 'no one family can mount everything it needs');
    } else {
      owners.set(file, family);
    }
  }
}

/**
 * A test of a family, foundation or tokens that needs a package depending on its own goes to core;
 * repeats to a fixpoint.
 */
function moveUnmountableTests(
  context: Context,
  owners: Map<string, string>,
  graph: Graph,
  testMoves: TestMove[],
): void {
  let moved = true;
  while (moved) {
    moved = false;
    for (const [file, owner] of [...owners].toSorted(([a], [b]) => a.localeCompare(b))) {
      if (!isTestFile(file) || !CODE_FILE.test(file) || !movesWithItsTests(owner, file)) continue;
      for (const [needed, chain] of packagesNeeded(context, owners, file, owner)) {
        if (needed !== 'core' && !(graph.reach.get(needed)?.has(owner) ?? false)) continue;
        moveToCore(
          context,
          owners,
          testMoves,
          file,
          `it needs "${needed}", which depends on "${owner}" (${chain})`,
        );
        moved = true;
        break;
      }
    }
  }
}

/**
 * Two packages whose tests mount each other (button's fixture mounts card, card's mounts button)
 * cycle through their test dependencies though neither source depends on the other, and a package
 * manager or task graph refuses the cycle. In each such cycle, the tests that mount a package of
 * the same or a higher layer go to core; repeats to a fixpoint.
 */
function breakTestCycles(
  context: Context,
  owners: Map<string, string>,
  graph: Graph,
  testMoves: TestMove[],
): void {
  const layer = layersOf(graph.edges);
  for (;;) {
    const edges = new Map([...graph.edges].map(([name, targets]) => [name, new Set(targets)]));
    const witnesses = new Map<string, { files: string[]; chain: string }>();
    for (const [file, owner] of [...owners].toSorted(([a], [b]) => a.localeCompare(b))) {
      if (!isTestFile(file) || !CODE_FILE.test(file) || !movesWithItsTests(owner, file)) continue;
      for (const [needed, chain] of packagesNeeded(context, owners, file, owner)) {
        if (needed === 'core' || !edges.has(needed)) continue;
        edges.get(owner)?.add(needed);
        const key = `${owner} ${needed}`;
        const witness = witnesses.get(key) ?? { files: [], chain };
        witness.files.push(file);
        witnesses.set(key, witness);
      }
    }
    const cycles = findCycles(edges);
    if (cycles.length === 0) return;
    let moved = false;
    for (const cycle of cycles) {
      const members = new Set(cycle);
      for (const [key, { files, chain }] of witnesses) {
        const [from = '', to = ''] = key.split(' ');
        if (!members.has(from) || !members.has(to)) continue;
        if ((layer.get(to) ?? 0) < (layer.get(from) ?? 0)) continue;
        for (const file of files) {
          moveToCore(
            context,
            owners,
            testMoves,
            file,
            `it mounts "${to}", whose tests mount "${from}" in turn (${chain})`,
          );
        }
        moved = true;
      }
    }
    if (!moved) {
      context.problems.push(
        `Tests cycle through ${cycles.map((cycle) => cycle.join(', ')).join('; ')} with no test of a lower layer to move.`,
      );
      return;
    }
  }
}

function checkHelpers(context: Context, placements: ReadonlyMap<string, Placement>): void {
  for (const [file, placement] of placements) {
    if (typeof placement.rule !== 'number') continue;
    if (context.rules.moves[placement.rule]?.helper !== true) continue;
    const component = reachesComponent(context, file);
    if (component !== undefined) {
      context.problems.push(
        `The test helper ${file} imports a component (${component}); a helper the tooling owns must be component-free.`,
      );
    }
  }
}

/** Derives the family map; throws {@link FamilyDerivationError} naming every problem. */
export function deriveFamilies(
  files: ReadonlyMap<string, string>,
  rules: FamilyRules,
  split: SplitPackages = UNSPLIT,
): DerivedFamilies {
  const context: Context = {
    files,
    rules,
    imports: buildImports(files, split),
    componentOf: new Map(),
    problems: [],
  };
  assignComponents(context);
  const familyTargets = new Set(rules.families.map((family) => family.name));
  for (const [index, row] of rules.moves.entries()) {
    const valid =
      row.target === BY_IMPORTS ||
      (row.target === COMPANION && row.when === 'companion-test') ||
      SHARED_PACKAGES.includes(row.target as PackageKind) ||
      familyTargets.has(row.target) ||
      context.componentOf.has(row.target);
    if (!valid)
      context.problems.push(`Move row ${index + 1} targets "${row.target}", which is no package.`);
  }

  const placements = new Map<string, Placement>();
  const owners = new Map<string, string>();
  for (const path of [...files.keys()].toSorted()) {
    const placement = placeFile(context, path);
    placements.set(path, placement);
    owners.set(path, placement.owner);
  }
  checkHelpers(context, placements);
  for (const [path, placement] of placements) {
    if (placement.rule === 'unplaced') {
      context.problems.push(`No move row places ${path}: add it to a row in family-rules.json.`);
    }
  }

  const packages = new Set<string>(
    [...owners.values()].filter((owner) => owner !== '' && owner !== BY_IMPORTS),
  );
  for (const family of context.componentOf.values()) packages.add(family);
  const graph = sourceGraph(context, owners, placements, packages);
  const testMoves: TestMove[] = [];
  if (graph !== undefined) {
    decideByImports(context, owners, graph, testMoves);
    moveUnmountableTests(context, owners, graph, testMoves);
    breakTestCycles(context, owners, graph, testMoves);
    for (const owner of owners.values()) if (owner !== '') packages.add(owner);
  }
  if (graph === undefined) throw new FamilyDerivationError([...new Set(context.problems)]);
  const derived = assemble(context, packages, placements, owners, graph, testMoves);
  if (context.problems.length > 0) {
    throw new FamilyDerivationError([...new Set(context.problems)], derived);
  }
  return derived;
}

function assemble(
  context: Context,
  packages: ReadonlySet<string>,
  placements: ReadonlyMap<string, Placement>,
  owners: ReadonlyMap<string, string>,
  graph: Graph,
  testMoves: TestMove[],
): DerivedFamilies {
  const layer = layersOf(graph.edges);
  const derived: Record<string, DerivedPackage> = {};
  for (const name of [...packages].toSorted()) {
    derived[name] = {
      kind: SHARED_PACKAGES.includes(name as PackageKind) ? (name as PackageKind) : 'family',
      layer: layer.get(name) ?? 0,
      components: [...context.componentOf]
        .filter(([, family]) => family === name)
        .map(([component]) => component)
        .toSorted(),
      dependencies: [...(graph.edges.get(name) ?? [])].toSorted(),
      modules: [...placements]
        .filter(([path, placement]) => placement.rule !== 'component' && owners.get(path) === name)
        .map(([path]) => path)
        .toSorted(),
    };
  }
  const layerCount = Math.max(-1, ...layer.values()) + 1;
  const layers = Array.from({ length: layerCount }, (_, index) =>
    Object.keys(derived).filter((name) => derived[name]?.layer === index),
  );
  const families = Object.values(derived).filter((entry) => entry.kind === 'family');
  return {
    summary: {
      packages: Object.keys(derived).length,
      multiComponentFamilies: families.filter((entry) => entry.components.length > 1).length,
      singleComponentFamilies: families.filter((entry) => entry.components.length === 1).length,
      layerSizes: layers.map((names) => names.length),
    },
    layers,
    packages: derived,
    testMoves: testMoves.toSorted((a, b) => a.file.localeCompare(b.file)),
    subpathExports: Object.fromEntries(
      [...graph.subpathExports]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([module, importers]) => [module, [...importers].toSorted()]),
    ),
  };
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.types', '.turbo', 'coverage']);

/** Every file under `<packageRoot>/src`, keyed by its path from the package root. */
export function readPackageTree(packageRoot: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(packageRoot, relative), { withFileTypes: true })) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        files.set(path, CODE_FILE.test(path) ? readFileSync(join(packageRoot, path), 'utf8') : '');
      }
    }
  };
  if (existsSync(join(packageRoot, 'src'))) walk('src');
  return files;
}

/** A tree as the derivation reads it: its files, and what the split's packages add to them. */
export interface RepositoryTree {
  files: Map<string, string>;
  split: SplitPackages;
}

/**
 * Core's tree joined with every package already extracted from it (`split-layout.ts`): each
 * `@lostgradient/<name>` workspace core depends on under `components/<name>`. Every package keeps
 * core's layout, so the union is the tree the family map was derived from; a generated barrel or
 * stylesheet is left out of it and kept to resolve the specifiers that name it.
 */
export function readRepositoryTree(
  rules: FamilyRules = readRules(),
  root: string = REPOSITORY_ROOT,
): RepositoryTree {
  const coreRoot = join(root, rules.packageRoot);
  const packages = new Set<string>(['tooling']);
  const generated = new Map<string, string>();
  const files = new Map<string, string>();
  const add = (name: string, tree: ReadonlyMap<string, string>) => {
    for (const [path, content] of tree) {
      if (isGenerated(content)) generated.set(`${name}:${path}`, content);
      else if (files.has(path)) {
        throw new FamilyDerivationError([`${path} is in both core and components/${name}.`]);
      } else files.set(path, content);
    }
  };
  add('core', readPackageTree(coreRoot));
  const manifestPath = join(coreRoot, 'package.json');
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> })
    : {};
  for (const dependency of Object.keys(manifest.dependencies ?? {}).toSorted()) {
    if (!dependency.startsWith(PACKAGE_SCOPE)) continue;
    const name = dependency.slice(PACKAGE_SCOPE.length);
    const directory = join(root, 'components', name);
    if (directory === coreRoot || !existsSync(join(directory, 'package.json'))) continue;
    packages.add(name);
    add(name, readPackageTree(directory));
  }
  return { files, split: { packages, generated } };
}

export const TOOLING_ROOT = resolve(import.meta.dir, '..');
export const REPOSITORY_ROOT = resolve(TOOLING_ROOT, '../..');
export const RULES_PATH = join(TOOLING_ROOT, 'family-rules.json');
export const FAMILIES_PATH = join(TOOLING_ROOT, 'families.json');

export function readRules(path = RULES_PATH): FamilyRules {
  return JSON.parse(readFileSync(path, 'utf8')) as FamilyRules;
}

/** `families.json`'s text: the derivation, formatted the way Prettier formats the file. */
export async function renderFamilies(derived: DerivedFamilies): Promise<string> {
  const document = {
    $comment:
      'Generated by scripts/derive-families.ts from family-rules.json and the import graph; do not edit. Run `bun scripts/derive-families.ts` after a change and record the diff.',
    ...derived,
  };
  return format(JSON.stringify(document), {
    parser: 'json',
    printWidth: 100,
    tabWidth: 2,
    endOfLine: 'lf',
  });
}

export function deriveFromRepository(rules = readRules(), root = REPOSITORY_ROOT): DerivedFamilies {
  const { files, split } = readRepositoryTree(rules, root);
  return deriveFamilies(files, rules, split);
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');
  let derived: DerivedFamilies;
  try {
    derived = deriveFromRepository();
  } catch (error) {
    if (!(error instanceof FamilyDerivationError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const text = await renderFamilies(derived);
  if (check) {
    const committed = existsSync(FAMILIES_PATH) ? readFileSync(FAMILIES_PATH, 'utf8') : '';
    if (committed === text) return 0;
    process.stderr.write(
      `${FAMILIES_PATH} is stale: run \`bun ${join(dirname(import.meta.path), 'derive-families.ts')}\` and commit the diff.\n`,
    );
    return 1;
  }
  writeFileSync(FAMILIES_PATH, text);
  const { summary } = derived;
  process.stdout.write(
    `${summary.packages} packages in ${summary.layerSizes.length} layers (${summary.layerSizes.join(', ')}); ${summary.multiComponentFamilies} multi-component families.\n`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
