/**
 * Moves the root browser suite (`scripts/browser-fixtures`) into the packages that own what it
 * mounts (COR-2092), by the placement `place-browser-specs.ts` computes, and deletes the suite.
 *
 * ```sh
 * bun internal/component-tooling/scripts/move-browser-specs.ts               # move and write the map
 * bun internal/component-tooling/scripts/move-browser-specs.ts --dry-run     # print the moves
 * bun internal/component-tooling/scripts/move-browser-specs.ts --no-install  # skip `bun install`
 * ```
 *
 * It runs after `extract-families.ts --all`, on the split layout. It refuses to move anything while
 * one item has no placement (see `browser-spec-rules.json`). Then, for every item, with `git mv`:
 *
 * - each spec goes to `components/<package>/browser/tests/`;
 * - each application fixture (`<slug>.svelte`, its `<slug>/` helpers and its `<slug>.*` data) to
 *   `components/<package>/browser/fixtures/`, and its declaration to the package's
 *   `browser/fixture-declarations.ts`;
 * - each baseline directory to `components/<package>/browser/snapshots/chromium/linux/`, and an
 *   image another spec captures to that spec's package; `provenance.json` to core's.
 *
 * Every relative import of a moved file is re-pointed from its new place; the root suite's
 * `environment-configuration.ts` becomes `@lostgradient/testing/environment-configuration`; a
 * fixture moved into a Cinder package other than core imports each of core's barrel names from the
 * module core takes it from (core depends on every such package, so the barrel would close a
 * cycle). Every text file that names a moved path by its repository path is rewritten.
 *
 * Each package that now holds a spec, a fixture or a fixture it sweeps gets the files of its
 * browser suite (`browser-suite-files.ts`): `harness.ts`, `playwright.config.ts`,
 * `tests/components.playwright.ts` when it owns fixtures to sweep, its `test:browser` script, its
 * development dependencies, and `browser` in its lint and TypeScript configuration. Then it
 * deletes what is left of `scripts/browser-fixtures`, failing on any file it does not expect, and
 * runs `bun install`. A second run finds nothing to move and changes nothing.
 */

import { cinderComponentRoots, packageSuite } from '@lostgradient/testing/browser/package-suite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import {
  browserImports,
  HARNESS_SOURCE,
  playwrightConfigSource,
  rootCatalog,
  SWEEP_SOURCE,
  withBrowserSuite,
  type EngineProject,
} from './browser-suite-files.ts';
import {
  computePlacement,
  CORE_PACKAGE,
  MAP_PATH,
  readRepository,
  readRules,
  renderMap,
  REPOSITORY_ROOT,
  ROOT_SUITE,
  rootDeclarations,
  type ExportSource,
  type PlacementMap,
  type Repository,
} from './place-browser-specs.ts';

/** The root suite's files the move itself consumes, and deletes once it is done. */
const CONSUMED = new Set(['src/app-fixture-declarations.ts']);
/** Slugs no component sweep covers (`UNSWEPT_SLUGS` in `@lostgradient/testing`). */
const UNSWEPT = new Set(['terminal', 'chat-stress']);

type Options = { root: string; dryRun: boolean; install: boolean };

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function tracked(root: string, ...pathspecs: string[]): string[] {
  return git(root, ['ls-files', '-z', '--', ...pathspecs])
    .split('\0')
    .filter((file) => file.length > 0);
}

/** Every file move, repository-relative, from the root suite to the packages. */
export function planMoves(
  root: string,
  map: PlacementMap,
  core: string,
): { moves: Map<string, string>; problems: string[] } {
  const moves = new Map<string, string>();
  const problems: string[] = [];
  const browser = (directory: string, ...parts: string[]) =>
    posix.join('components', directory, 'browser', ...parts);
  for (const [file, directory] of Object.entries(map.specs)) {
    moves.set(`${ROOT_SUITE}/tests/${file}`, browser(directory, 'tests', file));
  }
  const fixtures = `${ROOT_SUITE}/src/fixtures`;
  const fixtureFiles = tracked(root, fixtures).map((file) => file.slice(fixtures.length + 1));
  for (const file of fixtureFiles) {
    const head = file.split('/')[0]!;
    const slug = file.includes('/') ? head : head.replace(/\.[^.]*(?:\.[^.]*)?$/, '');
    const owner = map.appFixtures[slug] ?? map.appFixtures[head.split('.')[0]!];
    if (owner === undefined) {
      problems.push(`${fixtures}/${file} belongs to no placed application fixture.`);
      continue;
    }
    moves.set(`${fixtures}/${file}`, browser(owner, 'fixtures', file));
  }
  const snapshots = `${ROOT_SUITE}/snapshots/chromium/linux`;
  for (const file of tracked(root, `${ROOT_SUITE}/snapshots`)) {
    if (!file.startsWith(`${snapshots}/`)) {
      problems.push(`${file} is not a Chromium Linux baseline.`);
      continue;
    }
    const rest = file.slice(snapshots.length + 1);
    const slug = rest.split('/')[0]!;
    if (!rest.includes('/')) {
      // The baselines' provenance record stays with core's.
      moves.set(file, browser(core, 'snapshots', 'chromium', 'linux', rest));
      continue;
    }
    const owner = map.baselineFiles[rest] ?? map.baselines[slug];
    if (owner === undefined) {
      problems.push(`${file} belongs to no placed baseline directory.`);
      continue;
    }
    moves.set(file, browser(owner, 'snapshots', 'chromium', 'linux', rest));
  }
  return { moves, problems };
}

const SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;
const CINDER_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])@lostgradient\/cinder\3;?/g;

/** A module specifier from `from` to the repository path `to`. */
function relativeSpecifier(from: string, to: string): string {
  const path = posix.relative(posix.dirname(from), to);
  return path.startsWith('.') ? path : `./${path}`;
}

/**
 * Re-points a moved (or unmoved) file's relative imports, from its old place `before` to `after`,
 * through the moves; the root suite's environment configuration becomes the testing package's.
 */
export function rewriteRelativeImports(
  source: string,
  before: string,
  after: string,
  moves: ReadonlyMap<string, string>,
): string {
  return source.replace(SPECIFIER, (whole, lead: string, quote: string, specifier: string) => {
    if (!specifier.startsWith('.')) return whole;
    const target = posix.normalize(posix.join(posix.dirname(before), specifier));
    if (target === `${ROOT_SUITE}/environment-configuration.ts`) {
      return `${lead}${quote}@lostgradient/testing/environment-configuration${quote}`;
    }
    const moved = moves.get(target) ?? target;
    if (moved === target && before === after) return whole;
    const next = relativeSpecifier(after, moved);
    return next === specifier ? whole : `${lead}${quote}${next}${quote}`;
  });
}

/**
 * Where a repository path a moved file named from its old place is now: the file a move took
 * there, the moved file's own suite's equivalent of a root-suite directory (`snapshots/`,
 * `tests/`, `src/fixtures/` as `fixtures/`), or the path itself.
 */
function movedTarget(target: string, after: string, moves: ReadonlyMap<string, string>): string {
  const moved = moves.get(target);
  if (moved !== undefined) return moved;
  const suite = /^(components\/[^/]+\/browser)\//.exec(after)?.[1];
  if (suite !== undefined && (target === ROOT_SUITE || target.startsWith(`${ROOT_SUITE}/`))) {
    const rest = target.slice(ROOT_SUITE.length + 1).replace(/^src\/fixtures(?=\/|$)/, 'fixtures');
    return rest.length === 0 ? suite : `${suite}/${rest}`;
  }
  return target;
}

const LOCATION_URL = /new URL\(\s*(['"`])(\.{1,2}\/[^'"`\n]*)\1(\s*,\s*import\.meta\.url\s*\))/g;
const LOCATION_CALL =
  /\b(resolve|join)\(\s*import\.meta\.dir(?:name)?((?:\s*,\s*'[^'\n]*')+)(?=\s*[,)])/g;

/**
 * Re-points the paths a moved file builds from its own location (`new URL('../x', import.meta.url)`,
 * `resolve(import.meta.dirname, '../x')`, `join(import.meta.dirname, '..', 'x')`), from its old
 * place `before` to `after`, through the moves.
 */
export function rewriteLocationPaths(
  source: string,
  before: string,
  after: string,
  moves: ReadonlyMap<string, string>,
): string {
  const repoint = (relativePath: string): string | undefined => {
    const target = posix.normalize(posix.join(posix.dirname(before), relativePath));
    if (target.startsWith('..')) return undefined;
    const next = posix.relative(posix.dirname(after), movedTarget(target, after, moves));
    return next.length === 0 ? '.' : next;
  };
  let next = source.replace(LOCATION_URL, (whole, quote: string, path: string, tail: string) => {
    const repointed = repoint(path);
    if (repointed === undefined) return whole;
    const prefixed = repointed.startsWith('.') ? repointed : `./${repointed}`;
    const trailing = path.endsWith('/') && !prefixed.endsWith('/') ? '/' : '';
    return `new URL(${quote}${prefixed}${trailing}${quote}${tail}`;
  });
  next = next.replace(LOCATION_CALL, (whole, call: string, list: string) => {
    const segments = [...list.matchAll(/'([^'\n]*)'/g)].map((match) => match[1]!);
    const repointed = repoint(segments.join('/'));
    if (repointed === undefined) return whole;
    const parts = repointed.split('/').map((part) => `'${part}'`);
    return `${call}(import.meta.dirname, ${parts.join(', ')}`;
  });
  return next;
}

/**
 * Splits imports of core's barrel into imports from the modules core re-exports each name from,
 * for a file in a Cinder package core depends on.
 */
export function rewriteBarrelImports(
  source: string,
  sources: ReadonlyMap<string, ExportSource>,
): string {
  return source.replace(CINDER_IMPORT, (whole, typeOnly: string | undefined, list: string) => {
    const bySpecifier = new Map<string, { defaults: string[]; named: string[] }>();
    for (const part of list.split(',')) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      const isType = typeOnly !== undefined || /^type\s+/.test(trimmed);
      const [name, alias] = trimmed
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .map((value) => value.trim());
      const origin = sources.get(name!);
      if (origin === undefined || !origin.specifier.startsWith('@lostgradient/')) {
        throw new Error(`Core's barrel does not take '${name}' from a package: ${whole}`);
      }
      const local = alias ?? name!;
      const entry = bySpecifier.get(origin.specifier) ?? { defaults: [], named: [] };
      if (origin.imported === 'default') entry.defaults.push(local);
      else {
        const imported = origin.imported === local ? local : `${origin.imported} as ${local}`;
        entry.named.push(isType ? `type ${imported}` : imported);
      }
      bySpecifier.set(origin.specifier, entry);
    }
    const statements: string[] = [];
    for (const [specifier, { defaults, named }] of [...bySpecifier].toSorted()) {
      for (const local of defaults) statements.push(`import ${local} from '${specifier}';`);
      if (named.length > 0) statements.push(`import { ${named.join(', ')} } from '${specifier}';`);
    }
    return statements.join('\n  ');
  });
}

type Declarations = Record<string, readonly string[]>;

/** Adds declarations to a package's `browser/fixture-declarations.ts`, creating it if needed. */
export function declarationsSource(existing: string | undefined, additions: Declarations): string {
  const lines = Object.entries(additions)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([slug, names]) => `  ${JSON.stringify(slug)}: ${JSON.stringify(names)},`);
  if (existing === undefined) {
    return [
      '/**',
      " * The application fixtures in `fixtures/`, by component, that every package's browser suite",
      ' * serves and this one owns (COR-2092).',
      ' */',
      'export const appFixtureDeclarations = {',
      ...lines,
      '} as const satisfies Record<string, readonly string[]>;',
      '',
    ].join('\n');
  }
  const close = existing.lastIndexOf('} as const');
  if (close === -1)
    throw new Error('A fixture-declarations.ts without `} as const` cannot be merged.');
  return `${existing.slice(0, close)}${lines.join('\n')}\n${existing.slice(close)}`;
}

/** The slugs each package owns after the move: its source fixtures and its application fixtures. */
function ownedSlugs(
  repository: Repository,
  declarations: Map<string, Declarations>,
): Map<string, Set<string>> {
  const owned = new Map<string, Set<string>>();
  const declaredElsewhere = new Map<string, string>();
  for (const [name, declared] of declarations) {
    for (const slug of Object.keys(declared)) declaredElsewhere.set(slug, name);
  }
  const add = (name: string, slug: string) => {
    const set = owned.get(name) ?? new Set<string>();
    set.add(slug);
    owned.set(name, set);
  };
  for (const [slug, name] of repository.sourceSlugs) {
    // An application fixture of the same slug decides where the slug is swept.
    const declaredBy = declaredElsewhere.get(slug);
    if (declaredBy === undefined || declaredBy === name) add(name, slug);
  }
  for (const [slug, name] of declaredElsewhere) add(name, slug);
  return owned;
}

/**
 * The root page's stylesheets, in its order, as a module of side-effect imports for core's host: the
 * page is built from the root suite's layout (every fixture root, the root suite's and the packages'
 * application fixtures, core's host) before anything moves. Stylesheets a dependency installs are
 * left out; they come after Cinder's either way.
 */
export async function stylesheetOrderSource(
  root: string,
  repository: Repository,
  declarations: Record<string, readonly string[]>,
): Promise<string> {
  const coreRoot = join(root, 'components', repository.core);
  const browserRoot = join(coreRoot, 'browser');
  const fixtureRoots = cinderComponentRoots(coreRoot);
  const chat = join(root, 'components', 'chat', 'src', 'lib', 'components');
  if (existsSync(chat)) fixtureRoots.push(chat);
  const appFixtureRoots = [
    join(root, ROOT_SUITE, 'src', 'fixtures'),
    ...[...repository.workspaces.values()]
      .map((workspace) => join(root, 'components', workspace.directory, 'browser', 'fixtures'))
      .filter((directory) => existsSync(directory)),
  ];
  const suite = packageSuite({
    root: browserRoot,
    fixtureRoots,
    appFixtureRoots,
    appFixtureDeclarations: declarations,
    host: join(browserRoot, 'host.ts'),
    ownFixtureRoots: [],
    ownAppFixtures: [],
  });
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-stylesheet-order-'));
  try {
    await suite.bundleInto(directory, true);
    const html = readFileSync(join(directory, 'index.html'), 'utf8');
    const stylesheet = /href="\/([^"]+\.css)"/.exec(html)?.[1];
    if (stylesheet === undefined) throw new Error('The root page has no stylesheet.');
    const css = readFileSync(join(directory, stylesheet), 'utf8');
    const imports: string[] = [];
    for (const match of css.matchAll(/^\/\* (.+?\.css) \*\/$/gm)) {
      const path = resolve(browserRoot, match[1]!);
      if (path.includes('/node_modules/') || !existsSync(path)) continue;
      const specifier = posix.relative(browserRoot.split(sep).join('/'), path.split(sep).join('/'));
      imports.push(`import '${specifier.startsWith('.') ? specifier : `./${specifier}`}';`);
    }
    if (imports.length === 0)
      throw new Error('The root page loads no stylesheet this move can name.');
    return [
      "// Generated by move-browser-specs.ts (COR-2092): the root browser suite's stylesheets, in the",
      "// order its page loaded them. Core's host imports this first, so every package's page keeps it.",
      ...imports,
      '',
    ].join('\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function moveBrowserSpecs(options: Options): Promise<number> {
  const { root } = options;
  const started = performance.now();
  const { map, problems, moved } = await computePlacement(root);
  if (problems.length > 0) {
    process.stderr.write(`Cannot place:\n- ${problems.join('\n- ')}\n`);
    return 1;
  }
  const declarations = await rootDeclarations(root);
  const repository = readRepository(root, Object.keys(declarations));
  const { moves, problems: moveProblems } = planMoves(root, map, repository.core);
  if (moveProblems.length > 0) {
    process.stderr.write(`Cannot move:\n- ${moveProblems.join('\n- ')}\n`);
    return 1;
  }
  const leftovers = tracked(root, ROOT_SUITE)
    .filter((file) => !moves.has(file))
    .map((file) => file.slice(ROOT_SUITE.length + 1))
    .filter((file) => !CONSUMED.has(file));
  if (leftovers.length > 0) {
    process.stderr.write(
      `${ROOT_SUITE} holds files this move does not place:\n- ${leftovers.join('\n- ')}\n`,
    );
    return 1;
  }
  if (moved || moves.size === 0) {
    process.stdout.write('Nothing to move.\n');
    return 0;
  }
  process.stdout.write(
    `${Object.keys(map.specs).length} specs, ${Object.keys(map.appFixtures).length} application fixtures, ${moves.size} files to move.\n`,
  );
  if (options.dryRun) {
    for (const [from, to] of moves) process.stdout.write(`${from} -> ${to}\n`);
    return 0;
  }

  // The root page's stylesheet order, before anything moves (see core's `browser/host.ts`).
  const orderPath = join(root, 'components', repository.core, 'browser', 'stylesheet-order.ts');
  writeFileSync(orderPath, await stylesheetOrderSource(root, repository, declarations));

  // Move.
  for (const [from, to] of moves) {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    git(root, ['mv', from, to]);
  }

  // Re-point imports, in the moved files and in every file that reached one by a relative path.
  const reverse = new Map([...moves].map(([from, to]) => [to, from]));
  const familyDirectories = new Set(
    [...repository.workspaces.values()]
      .filter(
        (workspace) =>
          workspace.name !== CORE_PACKAGE && dependsOnCore(repository, workspace.name) === false,
      )
      .map((workspace) => workspace.directory),
  );
  const coreDependencies = new Set(repository.workspaces.get(CORE_PACKAGE)?.dependencies ?? []);
  for (const file of tracked(root, '*.ts', '*.svelte')) {
    const before = reverse.get(file) ?? file;
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    let next = rewriteRelativeImports(source, before, file, moves);
    if (reverse.has(file)) next = rewriteLocationPaths(next, before, file, moves);
    const directory = file.split('/')[1];
    const owner = [...repository.workspaces.values()].find(
      (workspace) => workspace.directory === directory,
    );
    if (
      reverse.has(file) &&
      owner !== undefined &&
      familyDirectories.has(owner.directory) &&
      coreDependencies.has(owner.name)
    ) {
      next = rewriteBarrelImports(next, repository.exportSources);
    }
    if (next !== source) writeFileSync(path, next);
  }

  // Re-point repository paths in every text file.
  const pathMoves = [...moves].toSorted(([left], [right]) => right.length - left.length);
  for (const file of tracked(root, '*.ts', '*.md', '*.json', '*.yml', '*.svelte')) {
    const path = join(root, file);
    if (!existsSync(path) || file === MAP_PATH) continue;
    const source = readFileSync(path, 'utf8');
    if (!source.includes(`${ROOT_SUITE}/`)) continue;
    let next = source;
    for (const [from, to] of pathMoves) next = next.split(from).join(to);
    if (next !== source) writeFileSync(path, next);
  }

  // Declarations, by destination package.
  const additions = new Map<string, Declarations>();
  for (const [slug, directory] of Object.entries(map.appFixtures)) {
    const declared = declarations[slug];
    if (declared === undefined) continue;
    const entry = additions.get(directory) ?? {};
    entry[slug] = declared;
    additions.set(directory, entry);
  }
  for (const [directory, declared] of additions) {
    const path = join(root, 'components', directory, 'browser', 'fixture-declarations.ts');
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, declarationsSource(existing, declared));
  }

  // The browser suite of every package that now has one.
  const byName = new Map(
    [...repository.workspaces.values()].map((workspace) => [workspace.name, workspace.directory]),
  );
  const allDeclarations = new Map<string, Declarations>();
  for (const workspace of repository.workspaces.values()) {
    const path = join(
      root,
      'components',
      workspace.directory,
      'browser',
      'fixture-declarations.ts',
    );
    if (!existsSync(path)) continue;
    const module = (await import(path)) as Record<string, unknown>;
    const merged: Declarations = {};
    for (const value of Object.values(module)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      Object.assign(merged, value);
    }
    allDeclarations.set(workspace.name, merged);
  }
  const owned = ownedSlugs(repository, allDeclarations);
  const rules = readRules(root);
  const engines = new Map<string, EngineProject[]>();
  for (const [file, projects] of Object.entries(rules.engines ?? {})) {
    const directory = map.specs[file];
    if (directory === undefined) continue;
    const list = engines.get(directory) ?? [];
    for (const project of projects) {
      list.push({ name: project.name, device: project.device, testMatch: `**/${file}` });
    }
    engines.set(directory, list);
  }
  const suites = new Set<string>([
    ...Object.values(map.specs),
    ...Object.values(map.appFixtures),
    ...Object.values(map.baselines),
  ]);
  for (const [name, slugs] of owned) {
    if ([...slugs].some((slug) => !UNSWEPT.has(slug))) suites.add(byName.get(name)!);
  }
  const catalog = rootCatalog(root);
  for (const directory of [...suites].toSorted()) {
    const base = join(root, 'components', directory);
    const name = [...byName].find(([, value]) => value === directory)![0];
    const write = (relativePath: string, text: string) => {
      const path = join(base, relativePath);
      if (existsSync(path)) return;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    write('browser/harness.ts', HARNESS_SOURCE);
    const configPath = join(base, 'browser', 'playwright.config.ts');
    const projects = engines.get(directory) ?? [];
    // A package that already had a suite with no other engine (core's, from the cut) takes the
    // engines of the specs it receives.
    if (
      projects.length > 0 &&
      existsSync(configPath) &&
      readFileSync(configPath, 'utf8') === playwrightConfigSource()
    ) {
      writeFileSync(configPath, playwrightConfigSource(projects));
    }
    write('browser/playwright.config.ts', playwrightConfigSource(projects));
    const sweeps = [...(owned.get(name) ?? [])].some((slug) => !UNSWEPT.has(slug));
    if (sweeps) write('browser/tests/components.playwright.ts', SWEEP_SOURCE);
    const manifestPath = join(base, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const next = withBrowserSuite(manifest, {
      packageName: name,
      imports: browserImports(base),
      catalog,
      engines: engines.has(directory),
    });
    writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
    const tsconfigPath = join(base, 'tsconfig.json');
    if (existsSync(tsconfigPath)) {
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as {
        include?: string[];
        exclude?: string[];
      };
      const include = tsconfig.include ?? ['src'];
      if (!include.includes('browser')) include.splice(Math.min(1, include.length), 0, 'browser');
      const exclude = tsconfig.exclude ?? [];
      if (!exclude.includes('browser/.playwright')) exclude.push('browser/.playwright');
      writeFileSync(
        tsconfigPath,
        `${JSON.stringify({ ...tsconfig, include, exclude }, null, 2)}\n`,
      );
    }
  }

  // The map, and what is left of the root suite.
  writeFileSync(join(root, MAP_PATH), renderMap(map));
  for (const file of CONSUMED) {
    if (existsSync(join(root, ROOT_SUITE, file))) git(root, ['rm', '-q', `${ROOT_SUITE}/${file}`]);
  }
  rmSync(join(root, ROOT_SUITE), { recursive: true, force: true });
  // Oxlint and the root TypeScript project left the suite out while it waited for this move.
  const oxlint = join(root, '.oxlintrc.json');
  const oxlintText = readFileSync(oxlint, 'utf8');
  const ignored = `    "${ROOT_SUITE}/**",\n`;
  if (oxlintText.includes(ignored)) writeFileSync(oxlint, oxlintText.replace(ignored, ''));
  const rootTsconfig = join(root, 'tsconfig.json');
  const tsconfig = JSON.parse(readFileSync(rootTsconfig, 'utf8')) as { exclude?: string[] };
  if (tsconfig.exclude?.includes(ROOT_SUITE)) {
    tsconfig.exclude = tsconfig.exclude.filter((entry) => entry !== ROOT_SUITE);
    writeFileSync(rootTsconfig, `${JSON.stringify(tsconfig, null, 2)}\n`);
  }
  // The new files, and every change and deletion besides.
  git(root, ['add', '-A', '--', 'components', 'internal/component-tooling']);
  git(root, ['add', '-u']);
  // Rewritten imports and written files take the repository's formatting.
  const formatted = git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter((file) => /\.(?:ts|svelte|json)$/.test(file));
  for (let start = 0; start < formatted.length; start += 200) {
    const prettier = Bun.spawnSync(
      ['bunx', 'prettier', '--write', '--log-level=warn', ...formatted.slice(start, start + 200)],
      { cwd: root, stdout: 'ignore', stderr: 'inherit' },
    );
    if (prettier.exitCode !== 0) throw new Error('prettier could not format the moved files.');
  }
  git(root, ['add', '-u']);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stdout.write(`Moved ${moves.size} files into ${suites.size} packages in ${seconds}s.\n`);
  if (options.install) {
    const install = Bun.spawnSync(['bun', 'install'], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (install.exitCode !== 0) return install.exitCode ?? 1;
    git(root, ['add', 'bun.lock']);
  }
  return 0;
}

/** Whether a package depends on core (chat, editor, terminal), directly or not. */
function dependsOnCore(repository: Repository, name: string): boolean {
  const seen = new Set<string>();
  const stack = [name];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const dependency of repository.workspaces.get(current)?.dependencies ?? []) {
      if (dependency === CORE_PACKAGE) return true;
      if (!seen.has(dependency)) {
        seen.add(dependency);
        stack.push(dependency);
      }
    }
  }
  return false;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      'dry-run': { type: 'boolean' },
      'no-install': { type: 'boolean' },
      root: { type: 'string' },
    },
    strict: true,
  });
  process.exit(
    await moveBrowserSpecs({
      root: values.root === undefined ? REPOSITORY_ROOT : resolve(values.root),
      dryRun: values['dry-run'] ?? false,
      install: !(values['no-install'] ?? false),
    }),
  );
}
