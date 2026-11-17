/**
 * Places the root browser suite's specs, application fixtures and baselines in the packages that
 * own what they mount (COR-2092), and checks a committed placement.
 *
 * ```sh
 * bun internal/component-tooling/scripts/place-browser-specs.ts           # print the placement
 * bun internal/component-tooling/scripts/place-browser-specs.ts --write   # write the map
 * bun internal/component-tooling/scripts/place-browser-specs.ts --check   # the map still holds
 * ```
 *
 * It runs on the split layout, after `extract-families.ts --all`: core's barrel re-exports each
 * name from the package that owns it, and core's manifest names each component's package.
 *
 * - A spec's owners are the packages of the fixtures it opens (a manifest slug in a fixture call,
 *   `slug:`, `=== '<slug>'`, `/page/<slug>`, or an array of slugs), the workspace packages it
 *   imports (`@lostgradient/cinder` is core), and the files it reaches by relative path. A spec that
 *   opens nothing is owned by the slug its name starts with.
 * - An application fixture's owners are the packages of the names it imports, from core's barrel
 *   or a package, and of the files it reaches. A fixture that shares its slug with a component's
 *   own fixtures (`<slug>-fixtures.ts`) goes where that component is, so one sweep covers the slug.
 * - Owners are placed in the package that covers them all with the fewest dependencies: one owner
 *   that depends on the rest, or else core, which depends on every Cinder package, or a package above
 *   core (chat, editor, terminal). Anything with no owner, or no covering package, is an error,
 *   unless `browser-spec-rules.json` places it.
 * - A baseline directory (`<slug>/`) goes with the slug's sweep owner; an image another spec
 *   captures under the same slug (`captureScreenshot({ slug, fixture })`) goes with that spec.
 *
 * `--check` recomputes each placement the map records, wherever the file now is (the root suite
 * before the move, a package after), and fails on any difference, on a root file the map misses,
 * and, after the move, on any file left under `scripts/browser-fixtures`.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const ROOT_SUITE = 'scripts/browser-fixtures';
export const MAP_PATH = 'internal/component-tooling/browser-spec-placement.json';
export const RULES_PATH = 'internal/component-tooling/browser-spec-rules.json';
export const CORE_PACKAGE = '@lostgradient/cinder';
const SCOPE = '@lostgradient/';
/** Workspace packages a spec or fixture imports that never decide its placement. */
const NEUTRAL_PACKAGES = new Set([`${SCOPE}testing`, `${SCOPE}typescript`]);

export type Rules = {
  /** Spec file name to package name, where the rule below cannot place it. */
  specs?: Record<string, string>;
  /** Application fixture slug to package name. */
  appFixtures?: Record<string, string>;
  /** Firefox and WebKit projects a spec runs in, by spec file name. */
  engines?: Record<string, { name: string; device: 'Desktop Firefox' | 'Desktop Safari' }[]>;
};

export type PlacementMap = {
  /** Spec file name (`<name>.playwright.ts`) to package directory under `components/`. */
  specs: Record<string, string>;
  /** Application fixture slug to package directory. */
  appFixtures: Record<string, string>;
  /** Baseline directory (`<slug>`) to package directory. */
  baselines: Record<string, string>;
  /** A baseline image another spec captures (`<slug>/<file>`) to that spec's package directory. */
  baselineFiles: Record<string, string>;
};

/** One workspace under `components/`. */
export type Workspace = { name: string; directory: string; dependencies: string[] };

/** What placement reads from the repository. */
export type Repository = {
  root: string;
  /** By package name. */
  workspaces: Map<string, Workspace>;
  /** Core's directory name under `components/`. */
  core: string;
  /** Export name in core's barrel to the package that defines it. */
  exportOwners: Map<string, string>;
  /** Export name in core's barrel to its source module. */
  exportSources: Map<string, ExportSource>;
  /** Component slug with source fixtures (`<slug>/<slug>-fixtures.ts`) to its package name. */
  sourceSlugs: Map<string, string>;
  /** Every manifest slug: source fixtures and declared application fixtures. */
  slugs: Set<string>;
};

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** The workspaces under `components/`, with the workspace packages each depends on. */
export function readWorkspaces(root: string): Map<string, Workspace> {
  const workspaces = new Map<string, Workspace>();
  for (const directory of readdirSync(join(root, 'components')).toSorted()) {
    const path = join(root, 'components', directory, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(read(path)) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    workspaces.set(manifest.name, {
      name: manifest.name,
      directory,
      dependencies: Object.keys(manifest.dependencies ?? {}).filter((name) =>
        name.startsWith(SCOPE),
      ),
    });
  }
  return workspaces;
}

const RE_EXPORT = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g;
const STAR_EXPORT = /export\s+\*\s+from\s+'(\.[^']+)'/g;

/** Each name core's barrel exports, with the package of the module it comes from. */
/** Where core's barrel takes an export from: the module, and the name it has there. */
export type ExportSource = { package: string; specifier: string; imported: string; type: boolean };

/** Each name core's barrel exports, with the module (and package) it comes from. */
export function readExportSources(
  coreSource: string,
  files: (path: string) => string,
): Map<string, ExportSource> {
  const sources = new Map<string, ExportSource>();
  const visit = (path: string, text: string) => {
    for (const match of text.matchAll(RE_EXPORT)) {
      const specifier = match[2]!;
      const owner = specifier.startsWith(SCOPE)
        ? specifier.split('/').slice(0, 2).join('/')
        : CORE_PACKAGE;
      const typeStatement = /^export\s+type\b/.test(match[0]);
      for (const part of match[1]!.split(',')) {
        const trimmed = part.trim();
        if (trimmed.length === 0) continue;
        const type = typeStatement || /^type\s+/.test(trimmed);
        const [imported, exported] = trimmed.replace(/^type\s+/, '').split(/\s+as\s+/);
        const name = (exported ?? imported)!.trim();
        if (sources.has(name)) continue;
        sources.set(name, { package: owner, specifier, imported: imported!.trim(), type });
      }
    }
    for (const match of text.matchAll(STAR_EXPORT)) {
      const next = posix.join(posix.dirname(path), match[1]!);
      visit(next, files(next));
    }
  };
  visit('src/index.ts', coreSource);
  return sources;
}

/** Component slugs with their own fixtures, by package: `<root>/<slug>/<slug>-fixtures.ts`. */
function readSourceSlugs(root: string, workspaces: Map<string, Workspace>): Map<string, string> {
  const slugs = new Map<string, string>();
  for (const workspace of workspaces.values()) {
    const base = join(root, 'components', workspace.directory);
    for (const sourceRoot of ['src/components', 'src/component-tests', 'src/lib/components']) {
      const directory = join(base, sourceRoot);
      if (!existsSync(directory)) continue;
      for (const file of new Bun.Glob('*/*-fixtures.ts').scanSync({ cwd: directory })) {
        const [slug, name] = file.split('/');
        if (name !== `${slug}-fixtures.ts`) continue;
        const existing = slugs.get(slug!);
        if (existing !== undefined && existing !== workspace.name) {
          throw new Error(`Fixtures for '${slug}' are in both ${existing} and ${workspace.name}.`);
        }
        slugs.set(slug!, workspace.name);
      }
    }
  }
  return slugs;
}

/** Reads the repository; `appFixtureSlugs` are the declared application fixtures. */
export function readRepository(root: string, appFixtureSlugs: Iterable<string>): Repository {
  const workspaces = readWorkspaces(root);
  const core = workspaces.get(CORE_PACKAGE)?.directory;
  if (core === undefined) throw new Error(`No workspace under components/ is ${CORE_PACKAGE}.`);
  const coreRoot = join(root, 'components', core);
  const exportSources = readExportSources(read(join(coreRoot, 'src', 'index.ts')), (path) =>
    read(join(coreRoot, path)),
  );
  const exportOwners = new Map([...exportSources].map(([name, source]) => [name, source.package]));
  const sourceSlugs = readSourceSlugs(root, workspaces);
  return {
    root,
    workspaces,
    core,
    exportOwners,
    exportSources,
    sourceSlugs,
    slugs: new Set([...sourceSlugs.keys(), ...appFixtureSlugs]),
  };
}

/** Every workspace package a package depends on, directly or not. */
export function dependencyClosure(
  workspaces: Map<string, Workspace>,
  name: string,
  seen = new Set<string>(),
): Set<string> {
  for (const dependency of workspaces.get(name)?.dependencies ?? []) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    dependencyClosure(workspaces, dependency, seen);
  }
  return seen;
}

/**
 * The package that covers every owner with the fewest dependencies: a workspace that is or depends
 * on each owner. Undefined when none does, or when two cover them equally.
 */
export function coveringPackage(
  workspaces: Map<string, Workspace>,
  owners: ReadonlySet<string>,
): string | undefined {
  if (owners.size === 0) return undefined;
  let best: { name: string; size: number } | undefined;
  let tied = false;
  // A spec of several packages goes to one of them, to core, or above core: never to an unrelated
  // package that happens to depend on them all.
  const candidates = [...workspaces.keys()].filter(
    (name) =>
      owners.has(name) ||
      name === CORE_PACKAGE ||
      dependencyClosure(workspaces, name).has(CORE_PACKAGE),
  );
  for (const name of candidates) {
    const closure = dependencyClosure(workspaces, name);
    if (![...owners].every((owner) => owner === name || closure.has(owner))) continue;
    if (best === undefined || closure.size < best.size) {
      best = { name, size: closure.size };
      tied = false;
    } else if (closure.size === best.size) {
      tied = true;
    }
  }
  return tied ? undefined : best?.name;
}

const SLUG_CALL =
  /\b(?:fixtureRoute|namedFixtureRoute|fixtureEntry|getEntry|requiredEntry|entryFor|route|open\w*Fixture|open\w*Page|openFixture|open)\s*\(\s*(?:[\w.]+\s*,\s*)?(['"`])([a-z0-9-]+)\1/g;
const SLUG_KEY =
  /\bslug\s*(?::|===|!==)\s*(['"`])([a-z0-9-]+)\1|(['"`])([a-z0-9-]+)\3\s*===\s*[\w.]*slug\b/g;
const PAGE_PATH = /\/page\/([a-z0-9-]+)/g;
const STRING_ARRAY = /\[\s*((?:(['"`])[a-z0-9-]+\2\s*,\s*)+(['"`])[a-z0-9-]+\3\s*,?\s*)\]/g;

/** The manifest slugs a spec opens. */
export function referencedSlugs(source: string, slugs: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  const add = (slug: string | undefined) => {
    if (slug !== undefined && slugs.has(slug)) found.add(slug);
  };
  for (const match of source.matchAll(SLUG_CALL)) add(match[2]);
  for (const match of source.matchAll(SLUG_KEY)) add(match[2] ?? match[4]);
  for (const match of source.matchAll(PAGE_PATH)) add(match[1]);
  // A list of slugs, every member a slug: the sweeps name what they cover this way.
  for (const match of source.matchAll(STRING_ARRAY)) {
    const members = [...match[1]!.matchAll(/(['"`])([a-z0-9-]+)\1/g)].map((member) => member[2]!);
    if (members.length >= 2 && members.every((member) => slugs.has(member))) {
      for (const member of members) found.add(member);
    }
  }
  return found;
}

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;
const NAMED_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\2/g;

/** The module specifiers a file imports. */
export function importSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[2]!);
}

/** The package a repository path lies in, by name, or undefined outside `components/`. */
function packageAt(repository: Repository, path: string): string | undefined {
  const parts = relative(repository.root, path).split(sep);
  if (parts[0] !== 'components' || parts.length < 2) return undefined;
  for (const workspace of repository.workspaces.values()) {
    if (workspace.directory === parts[1]) return workspace.name;
  }
  return undefined;
}

export type Owners = { owners: Set<string>; appFixtures: Set<string> };

/**
 * The packages a file's imports own: workspace packages (core's barrel names by their packages
 * for a fixture, core itself for a spec), and files in a package reached by a relative path. A
 * relative path into the root suite's fixtures names an application fixture, listed apart.
 */
export function importOwners(
  repository: Repository,
  file: string,
  source: string,
  options: { barrelNamesByPackage: boolean },
): Owners {
  const owners = new Set<string>();
  const appFixtures = new Set<string>();
  const barrelImports = new Set<string>();
  if (options.barrelNamesByPackage) {
    for (const match of source.matchAll(NAMED_IMPORT)) {
      if (match[3] !== CORE_PACKAGE) continue;
      barrelImports.add(match[0]);
      for (const part of match[1]!.split(',')) {
        const name = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name === undefined || name.length === 0) continue;
        owners.add(repository.exportOwners.get(name) ?? CORE_PACKAGE);
      }
    }
  }
  for (const specifier of importSpecifiers(source)) {
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier);
      const fixtures = join(repository.root, ROOT_SUITE, 'src', 'fixtures');
      if (target.startsWith(`${fixtures}${sep}`)) {
        appFixtures.add(
          relative(fixtures, target)
            .split(sep)[0]!
            .replace(/\.[^.]+$/, ''),
        );
        continue;
      }
      const owner = packageAt(repository, target);
      if (owner !== undefined) owners.add(owner);
      continue;
    }
    if (!specifier.startsWith(SCOPE)) continue;
    const name = specifier.split('/').slice(0, 2).join('/');
    if (NEUTRAL_PACKAGES.has(name)) continue;
    if (name === CORE_PACKAGE && options.barrelNamesByPackage) {
      const named = [...barrelImports].some((statement) => statement.includes(`'${specifier}'`));
      if (named && specifier === CORE_PACKAGE) continue;
    }
    if (repository.workspaces.has(name)) owners.add(name);
  }
  return { owners, appFixtures };
}

/**
 * The shared Playwright helpers a spec imports (`@lostgradient/testing/playwright/*`, or a helper
 * beside it before they moved): a helper that opens one fixture (`themeFixtureRoute`) names it.
 */
export function helperSources(root: string, file: string, source: string): string[] {
  const texts: string[] = [];
  for (const specifier of importSpecifiers(source)) {
    let path: string | undefined;
    const shared = /^@lostgradient\/testing\/playwright\/([\w-]+)$/.exec(specifier);
    if (shared !== null)
      path = join(root, 'testing', 'testing', 'src', 'playwright', `${shared[1]}.ts`);
    else if (/^\.\/[\w-]+\.ts$/.test(specifier) && !SPEC_FILE.test(specifier)) {
      path = resolve(dirname(file), specifier);
    }
    if (path !== undefined && existsSync(path)) texts.push(read(path));
  }
  return texts;
}

/** The slug a spec's file name starts with, the longest that matches. */
export function nameSlug(fileName: string, slugs: ReadonlySet<string>): string | undefined {
  const stem = fileName.replace(/\.(?:playwright|spec)\.ts$/, '');
  return [...slugs]
    .filter((slug) => stem === slug || stem.startsWith(`${slug}-`))
    .toSorted((left, right) => right.length - left.length)[0];
}

export type Inventory = {
  /** Spec file name to its current path. */
  specs: Map<string, string>;
  /** Application fixture slug to its `.svelte` file's current path. */
  appFixtures: Map<string, string>;
  /** Baseline slug directory to its current path. */
  baselines: Map<string, string>;
  /** Application fixture declarations, by slug. */
  declarations: Record<string, readonly string[]>;
};

/** The package directory names, by package name. */
function directoryOf(repository: Repository, name: string): string {
  const workspace = repository.workspaces.get(name);
  if (workspace === undefined) throw new Error(`${name} is not a workspace under components/.`);
  return workspace.directory;
}

/** Owners of an application fixture, following the sibling fixtures it imports. */
function appFixtureOwners(
  repository: Repository,
  inventory: Inventory,
  slug: string,
  seen = new Set<string>(),
): Set<string> {
  const owners = new Set<string>();
  if (seen.has(slug)) return owners;
  seen.add(slug);
  const path = inventory.appFixtures.get(slug) ?? appFixturePath(repository, slug);
  if (path === undefined) return owners;
  const files = [path];
  const helpers = join(dirname(path), slug);
  if (existsSync(helpers) && statSync(helpers).isDirectory()) {
    for (const file of new Bun.Glob('**/*.{ts,svelte}').scanSync({ cwd: helpers })) {
      files.push(join(helpers, file));
    }
  }
  for (const file of files) {
    const found = importOwners(repository, file, read(file), { barrelNamesByPackage: true });
    for (const owner of found.owners) owners.add(owner);
    for (const sibling of found.appFixtures) {
      for (const owner of appFixtureOwners(repository, inventory, sibling, seen)) owners.add(owner);
    }
    // A sibling in the same directory (`./with-comments.svelte`).
    for (const specifier of importSpecifiers(read(file))) {
      const match = /^\.\/([\w-]+)\.svelte$/.exec(specifier);
      if (match !== null && dirname(file) === dirname(path)) {
        for (const owner of appFixtureOwners(repository, inventory, match[1]!, seen)) {
          owners.add(owner);
        }
      }
    }
  }
  return owners;
}

/** Where an undeclared fixture file (a helper another fixture imports) is, before or after. */
function appFixturePath(repository: Repository, slug: string): string | undefined {
  const candidates = [
    join(repository.root, ROOT_SUITE, 'src', 'fixtures', `${slug}.svelte`),
    ...[...repository.workspaces.values()].map((workspace) =>
      join(
        repository.root,
        'components',
        workspace.directory,
        'browser',
        'fixtures',
        `${slug}.svelte`,
      ),
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export type Problem = string;

/** Places every item of the inventory; problems name what no rule places. */
export function place(
  repository: Repository,
  inventory: Inventory,
  rules: Rules,
): { map: PlacementMap; problems: Problem[] } {
  const problems: Problem[] = [];
  const map: PlacementMap = { specs: {}, appFixtures: {}, baselines: {}, baselineFiles: {} };

  const appFixtureOwner = new Map<string, string>();
  for (const slug of [...inventory.appFixtures.keys()].toSorted()) {
    const ruled = rules.appFixtures?.[slug];
    if (ruled !== undefined) {
      map.appFixtures[slug] = directoryOf(repository, ruled);
      continue;
    }
    const owners = appFixtureOwners(repository, inventory, slug);
    const source = repository.sourceSlugs.get(slug);
    const covering = coveringPackage(repository.workspaces, owners);
    if (source !== undefined) {
      // One slug, one sweep: the application fixture joins the component's own fixtures.
      // The package can take the other packages as development dependencies unless one of them
      // depends on it; then the fixture goes where the rule below puts it, and owns the slug there.
      const cycle = [...owners].some(
        (owner) => owner !== source && dependencyClosure(repository.workspaces, owner).has(source),
      );
      if (!cycle) {
        map.appFixtures[slug] = directoryOf(repository, source);
        continue;
      }
    }
    if (covering === undefined) {
      problems.push(
        owners.size === 0
          ? `Application fixture '${slug}' imports no package.`
          : `No package covers application fixture '${slug}' (${[...owners].join(', ')}).`,
      );
      continue;
    }
    map.appFixtures[slug] = directoryOf(repository, covering);
  }
  for (const [slug, directory] of Object.entries(map.appFixtures)) {
    const workspace = [...repository.workspaces.values()].find(
      (candidate) => candidate.directory === directory,
    );
    if (workspace !== undefined) appFixtureOwner.set(slug, workspace.name);
  }

  const slugOwner = (slug: string): string | undefined =>
    repository.sourceSlugs.get(slug) ??
    appFixtureOwner.get(slug) ??
    declaredOwner(repository, slug);

  for (const [fileName, path] of [...inventory.specs].toSorted()) {
    const ruled = rules.specs?.[fileName];
    if (ruled !== undefined) {
      map.specs[fileName] = directoryOf(repository, ruled);
      continue;
    }
    const source = read(path);
    const found = importOwners(repository, path, source, { barrelNamesByPackage: false });
    const owners = new Set(found.owners);
    for (const slug of found.appFixtures) {
      const owner = slugOwner(slug);
      if (owner !== undefined) owners.add(owner);
    }
    for (const text of [source, ...helperSources(repository.root, path, source)]) {
      for (const slug of referencedSlugs(text, repository.slugs)) {
        const owner = slugOwner(slug);
        if (owner !== undefined) owners.add(owner);
      }
    }
    if (owners.size === 0) {
      const slug = nameSlug(fileName, repository.slugs);
      const owner = slug === undefined ? undefined : slugOwner(slug);
      if (owner !== undefined) owners.add(owner);
    }
    const covering = coveringPackage(repository.workspaces, owners);
    if (covering === undefined) {
      problems.push(
        owners.size === 0
          ? `Spec ${fileName} opens no fixture this placement can read.`
          : `No package covers spec ${fileName} (${[...owners].join(', ')}).`,
      );
      continue;
    }
    map.specs[fileName] = directoryOf(repository, covering);
  }

  // Baselines: the slug's sweep owner, but for an image another spec captures under the slug.
  const writers = new Map<string, { spec: string; fixtures: Set<string> }[]>();
  for (const [fileName, path] of inventory.specs) {
    const source = read(path);
    for (const call of source.matchAll(/captureScreenshot\(\s*\w+\s*,\s*\{([^}]*)\}/g)) {
      const slug = /slug:\s*(['"`])([a-z0-9-]+)\1/.exec(call[1]!)?.[2];
      const fixture = /fixture:\s*(['"`])([\w-]+)\1/.exec(call[1]!)?.[2];
      if (slug === undefined || fixture === undefined) continue;
      const list = writers.get(slug) ?? [];
      const existing = list.find((writer) => writer.spec === fileName);
      if (existing === undefined) list.push({ spec: fileName, fixtures: new Set([fixture]) });
      else existing.fixtures.add(fixture);
      writers.set(slug, list);
    }
  }
  for (const [slug, path] of [...inventory.baselines].toSorted()) {
    const owner = slugOwner(slug);
    if (owner === undefined) {
      problems.push(`Baseline directory '${slug}' is no fixture's slug.`);
      continue;
    }
    map.baselines[slug] = directoryOf(repository, owner);
    for (const writer of writers.get(slug) ?? []) {
      const destination = map.specs[writer.spec];
      if (destination === undefined || destination === map.baselines[slug]) continue;
      for (const file of readdirSync(path)) {
        const fixture = /^(?:light|dark)-(?:mobile|tablet|desktop)-(.+)\.png$/.exec(file)?.[1];
        if (fixture !== undefined && writer.fixtures.has(fixture)) {
          map.baselineFiles[`${slug}/${file}`] = destination;
        }
      }
    }
  }
  return { map: sortMap(map), problems };
}

/** The owner of a slug some package already declares (chat's, editor's and terminal's). */
function declaredOwner(repository: Repository, slug: string): string | undefined {
  for (const workspace of repository.workspaces.values()) {
    const path = join(
      repository.root,
      'components',
      workspace.directory,
      'browser',
      'fixtures',
      `${slug}.svelte`,
    );
    if (existsSync(path)) return workspace.name;
  }
  return undefined;
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function sortMap(map: PlacementMap): PlacementMap {
  return {
    specs: sortRecord(map.specs),
    appFixtures: sortRecord(map.appFixtures),
    baselines: sortRecord(map.baselines),
    baselineFiles: sortRecord(map.baselineFiles),
  };
}

const SPEC_FILE = /\.(?:playwright|spec)\.ts$/;

/** The root suite's declarations, read from its `src/app-fixture-declarations.ts`. */
export async function rootDeclarations(root: string): Promise<Record<string, readonly string[]>> {
  const path = join(root, ROOT_SUITE, 'src', 'app-fixture-declarations.ts');
  if (!existsSync(path)) return {};
  const module = (await import(path)) as {
    appFixtureDeclarations?: Record<string, readonly string[]>;
  };
  return module.appFixtureDeclarations ?? {};
}

/** Every package's application fixture declarations (`browser/fixture-declarations.ts`), merged. */
export async function packageDeclarations(
  root: string,
): Promise<Record<string, readonly string[]>> {
  const merged: Record<string, readonly string[]> = {};
  for (const workspace of readWorkspaces(root).values()) {
    const path = join(
      root,
      'components',
      workspace.directory,
      'browser',
      'fixture-declarations.ts',
    );
    if (!existsSync(path)) continue;
    const module = (await import(path)) as Record<string, unknown>;
    for (const value of Object.values(module)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const [slug, names] of Object.entries(value)) {
        if (Array.isArray(names)) merged[slug] = names as readonly string[];
      }
    }
  }
  return merged;
}

/** The root suite's items, before the move. */
export async function rootInventory(root: string): Promise<Inventory> {
  const suite = join(root, ROOT_SUITE);
  const specs = new Map<string, string>();
  const tests = join(suite, 'tests');
  if (existsSync(tests)) {
    for (const file of readdirSync(tests).toSorted()) {
      if (SPEC_FILE.test(file)) specs.set(file, join(tests, file));
    }
  }
  const declarations = await rootDeclarations(root);
  const fixtures = join(suite, 'src', 'fixtures');
  const appFixtures = new Map<string, string>();
  for (const slug of Object.keys(declarations)) {
    const path = join(fixtures, `${slug}.svelte`);
    if (existsSync(path)) appFixtures.set(slug, path);
  }
  // Undeclared `.svelte` files are helpers another fixture imports; they travel with it.
  const baselines = new Map<string, string>();
  const snapshots = join(suite, 'snapshots', 'chromium', 'linux');
  if (existsSync(snapshots)) {
    for (const entry of readdirSync(snapshots).toSorted()) {
      const path = join(snapshots, entry);
      if (statSync(path).isDirectory()) baselines.set(entry, path);
    }
  }
  return { specs, appFixtures, baselines, declarations };
}

/** The same items where a map put them, after the move. */
export function movedInventory(root: string, map: PlacementMap): Inventory {
  const at = (directory: string, ...parts: string[]) =>
    join(root, 'components', directory, 'browser', ...parts);
  const specs = new Map<string, string>();
  for (const [file, directory] of Object.entries(map.specs))
    specs.set(file, at(directory, 'tests', file));
  const appFixtures = new Map<string, string>();
  for (const [slug, directory] of Object.entries(map.appFixtures)) {
    appFixtures.set(slug, at(directory, 'fixtures', `${slug}.svelte`));
  }
  const baselines = new Map<string, string>();
  for (const [slug, directory] of Object.entries(map.baselines)) {
    baselines.set(slug, at(directory, 'snapshots', 'chromium', 'linux', slug));
  }
  return { specs, appFixtures, baselines, declarations: {} };
}

export function readRules(root: string): Rules {
  const path = join(root, RULES_PATH);
  return existsSync(path) ? (JSON.parse(read(path)) as Rules) : {};
}

export function readMap(root: string): PlacementMap | undefined {
  const path = join(root, MAP_PATH);
  return existsSync(path) ? (JSON.parse(read(path)) as PlacementMap) : undefined;
}

export function renderMap(map: PlacementMap): string {
  return `${JSON.stringify(
    {
      $comment:
        'Generated by internal/component-tooling/scripts/place-browser-specs.ts (COR-2092): where each root browser spec, application fixture and baseline directory went. `--check` recomputes it.',
      ...map,
    },
    null,
    2,
  )}\n`;
}

/** Differences between a recorded map and a recomputed one, one line each. */
export function differences(recorded: PlacementMap, computed: PlacementMap): string[] {
  const lines: string[] = [];
  for (const key of ['specs', 'appFixtures', 'baselines', 'baselineFiles'] as const) {
    const names = new Set([...Object.keys(recorded[key] ?? {}), ...Object.keys(computed[key])]);
    for (const name of [...names].toSorted()) {
      const left = recorded[key]?.[name];
      const right = computed[key][name];
      if (left !== right)
        lines.push(`${key}.${name}: recorded ${left ?? '(none)'}, computed ${right ?? '(none)'}`);
    }
  }
  return lines;
}

/** Files left under the root suite. */
export function rootSuiteFiles(root: string): string[] {
  const suite = join(root, ROOT_SUITE);
  if (!existsSync(suite)) return [];
  return [...new Bun.Glob('**/*').scanSync({ cwd: suite, dot: false })]
    .filter((file) => !file.split('/').some((part) => ['node_modules', 'build'].includes(part)))
    .toSorted();
}

/** Computes the placement from wherever the files are: before the move or after it. */
export async function computePlacement(root: string): Promise<{
  map: PlacementMap;
  problems: Problem[];
  moved: boolean;
}> {
  const recorded = readMap(root);
  const before = await rootInventory(root);
  const moved = before.specs.size === 0 && recorded !== undefined;
  const inventory = moved ? movedInventory(root, recorded) : before;
  const declarations = moved ? await packageDeclarations(root) : before.declarations;
  const repository = readRepository(root, Object.keys(declarations));
  const result = place(repository, { ...inventory, declarations }, readRules(root));
  return { ...result, moved };
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { write: { type: 'boolean' }, check: { type: 'boolean' }, root: { type: 'string' } },
    strict: true,
  });
  const root = values.root === undefined ? REPOSITORY_ROOT : resolve(values.root);
  const { map, problems, moved } = await computePlacement(root);
  if (problems.length > 0) {
    process.stderr.write(`Cannot place:\n- ${problems.join('\n- ')}\n`);
    return 1;
  }
  if (values.check) {
    const recorded = readMap(root);
    if (recorded === undefined) {
      process.stderr.write(`${MAP_PATH} is missing: run with --write first.\n`);
      return 1;
    }
    const lines = differences(recorded, map);
    if (moved) {
      for (const file of rootSuiteFiles(root))
        lines.push(`${ROOT_SUITE}/${file} is still in the root suite`);
    }
    if (lines.length > 0) {
      process.stderr.write(`${MAP_PATH} does not hold:\n- ${lines.join('\n- ')}\n`);
      return 1;
    }
    process.stdout.write(
      `${MAP_PATH} holds: ${Object.keys(map.specs).length} specs, ${Object.keys(map.appFixtures).length} application fixtures, ${Object.keys(map.baselines).length} baseline directories.\n`,
    );
    return 0;
  }
  const text = renderMap(map);
  if (values.write) writeFileSync(join(root, MAP_PATH), text);
  else process.stdout.write(text);
  return 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
