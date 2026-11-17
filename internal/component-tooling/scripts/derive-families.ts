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
 * move row that matches it. Package dependencies come from source imports only: a test or a
 * fixture never adds one. The derivation fails, naming every problem, when the rules and the tree
 * disagree: a private directory no family names, a package cycle, a module listed for one family
 * but imported by another, a test helper that imports a component, or a family test that would
 * need a package depending on its own family.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';

import { format } from 'prettier';

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
  unplaced: string[];
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
const COMPONENT_STYLESHEET_PATH =
  /src\/components\/|components\.css|\.\.\/components\/|['"]components['"]\s*[,)]/;

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
function reachesComponent(context: Context, start: string): string | undefined {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const target of context.imports.get(file) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      if (componentDirectoryOf(context, target) !== undefined) return target;
      if (isTestFile(target)) queue.push(target);
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
    if (row.when === 'component-free' && reachesComponent(context, path) !== undefined) continue;
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

function buildImports(files: ReadonlyMap<string, string>): Map<string, string[]> {
  const imports = new Map<string, string[]>();
  for (const [path, content] of files) {
    if (!CODE_FILE.test(path)) continue;
    const targets = new Set<string>();
    for (const specifier of importSpecifiers(content)) {
      const target = resolveImport(files, path, specifier);
      if (target !== undefined && target !== path) targets.add(target);
    }
    imports.set(path, [...targets]);
  }
  return imports;
}

/** Test files that import `file` or name it by path (a test that builds it). */
function importersOf(context: Context, file: string): string[] {
  const name = posix.basename(file);
  const importers: string[] = [];
  for (const [path, content] of context.files) {
    if (path === file || !isTestFile(path) || !CODE_FILE.test(path)) continue;
    if ((context.imports.get(path) ?? []).includes(file) || content.includes(name)) {
      importers.push(path);
    }
  }
  return importers;
}

interface Graph {
  edges: Map<string, Set<string>>;
  reach: Map<string, Set<string>>;
}

function sourceGraph(
  context: Context,
  owners: ReadonlyMap<string, string>,
  placements: ReadonlyMap<string, Placement>,
  packages: ReadonlySet<string>,
): Graph | undefined {
  const edges = new Map<string, Set<string>>([...packages].map((name) => [name, new Set()]));
  const familyMoves = new Set(
    context.rules.moves
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !SHARED_PACKAGES.includes(row.target as PackageKind))
      .map(({ index }) => index),
  );
  const witness = new Map<string, string>();
  for (const [file, targets] of context.imports) {
    const from = owners.get(file);
    if (from === undefined || from === '' || from === BY_IMPORTS || isTestFile(file)) continue;
    for (const target of targets) {
      const to = owners.get(target);
      if (to === undefined || to === '' || to === from || isTestFile(target)) continue;
      edges.get(from)?.add(to);
      if (!witness.has(`${from} ${to}`)) witness.set(`${from} ${to}`, `${file} imports ${target}`);
      const placement = placements.get(target);
      if (
        placement !== undefined &&
        typeof placement.rule === 'number' &&
        familyMoves.has(placement.rule) &&
        !SHARED_PACKAGES.includes(from as PackageKind)
      ) {
        context.problems.push(
          `${target} is listed for family "${to}" but imported by family "${from}" (${file}).`,
        );
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
  return { edges, reach: closures(edges) };
}

function decideByImports(
  context: Context,
  owners: Map<string, string>,
  graph: Graph,
  testMoves: TestMove[],
): void {
  const pending = [...owners].filter(([, owner]) => owner === BY_IMPORTS).map(([file]) => file);
  const decidedHere = new Set(pending);
  // A file core takes brings every test that imports or builds it, and theirs in turn.
  const moveToCore = (file: string) => {
    const queue = [file];
    owners.set(file, 'core');
    while (queue.length > 0) {
      const moved = queue.shift() as string;
      for (const importer of importersOf(context, moved)) {
        const owner = owners.get(importer);
        if (owner === undefined || owner === '' || owner === 'core') continue;
        if (owner !== BY_IMPORTS && SHARED_PACKAGES.includes(owner as PackageKind)) continue;
        owners.set(importer, 'core');
        queue.push(importer);
        if (!decidedHere.has(importer)) {
          testMoves.push({
            file: importer,
            from: owner,
            to: 'core',
            because: `it imports or builds ${moved}, which core owns`,
          });
        }
      }
    }
  };
  for (const file of pending.toSorted()) {
    if (owners.get(file) !== BY_IMPORTS) continue;
    const importers = importersOf(context, file);
    const importerFamilies = new Set(
      importers
        .map((importer) => owners.get(importer))
        .filter((owner): owner is string => owner !== undefined && owner !== BY_IMPORTS)
        .filter((owner) => owner !== '' && !SHARED_PACKAGES.includes(owner as PackageKind)),
    );
    const needed = [...packagesNeeded(context, owners, file, BY_IMPORTS).keys()];
    const fits = (family: string) =>
      [...needed, ...importerFamilies].every(
        (name) => name === family || (graph.reach.get(family)?.has(name) ?? false),
      );
    const candidates =
      importerFamilies.size > 0
        ? [...importerFamilies]
        : needed.filter((name) => !SHARED_PACKAGES.includes(name as PackageKind));
    const family = candidates.toSorted().find(fits);
    if (family === undefined) moveToCore(file);
    else owners.set(file, family);
  }
}

function checkFamilyTests(context: Context, owners: ReadonlyMap<string, string>, graph: Graph) {
  for (const [file, owner] of owners) {
    if (!isTestFile(file) || !CODE_FILE.test(file)) continue;
    if (owner === '' || SHARED_PACKAGES.includes(owner as PackageKind)) continue;
    for (const [needed, chain] of packagesNeeded(context, owners, file, owner)) {
      if (graph.reach.get(needed)?.has(owner) ?? needed === 'core') {
        context.problems.push(
          `The ${owner} test ${file} needs "${needed}", which depends on "${owner}" (${chain}).`,
        );
      }
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
): DerivedFamilies {
  const context: Context = {
    files,
    rules,
    imports: buildImports(files),
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

  const packages = new Set<string>(
    [...owners.values()].filter((owner) => owner !== '' && owner !== BY_IMPORTS),
  );
  for (const family of context.componentOf.values()) packages.add(family);
  const graph = sourceGraph(context, owners, placements, packages);
  const testMoves: TestMove[] = [];
  if (graph !== undefined) {
    decideByImports(context, owners, graph, testMoves);
    for (const owner of owners.values()) if (owner !== '') packages.add(owner);
    checkFamilyTests(context, owners, graph);
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
    unplaced: [...placements]
      .filter(([, placement]) => placement.rule === 'unplaced')
      .map(([path]) => path),
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

export function deriveFromRepository(rules = readRules()): DerivedFamilies {
  return deriveFamilies(readPackageTree(join(REPOSITORY_ROOT, rules.packageRoot)), rules);
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
