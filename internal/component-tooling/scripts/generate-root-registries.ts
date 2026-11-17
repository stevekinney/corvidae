/**
 * Generate or check the two package-root registries a new component used to hand-edit.
 *
 * ```sh
 * bun scripts/generate-root-registries.ts           # rewrite the generated regions
 * bun scripts/generate-root-registries.ts --check   # exit 1 when either region is stale
 * ```
 *
 * `bun scripts/generate-component-artifacts.ts` (and its `--check`) runs this stage too.
 *
 * - `src/index.ts`: the region between the `<generated:component-exports>` markers re-exports,
 *   for every `src/components/<name>/index.ts` (except `icons/` and underscore directories), the
 *   default export as `<PascalName>` and every other name the component's barrel exports. A name
 *   the hand-authored rest of `src/index.ts` exports is left to it; a name several barrels export
 *   goes to the component it names (`TabList` to `tab-list`, not `tabs`). {@link ROOT_EXPORT_ALIASES}
 *   and {@link ROOT_EXPORT_WITHHELD} hold the few exceptions. The barrels keep the evaluation
 *   order `root-export-order.json` records, since each one imports its component's CSS (see
 *   {@link barrelDirectories}); `scripts/css-import-order.ts` prints the order a root importer
 *   evaluates the stylesheets in.
 * - `src/styles/components.css`: the region between the `<generated:component-imports>` markers
 *   imports every stylesheet directly inside a component directory that no other component
 *   stylesheet imports, in path order, with the cascade-order pins of {@link CSS_IMPORT_ORDER_PINS}.
 *
 * Adding a component therefore edits neither file by hand: run the generator and commit its output.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';

import ts from 'typescript';
import { prettier } from './lib/node-prettier.ts';

import { cinderPackages } from './discover-component-directories.ts';
import { exportNames } from './export-names.ts';
import { PACKAGE_SCOPE, specifierFor } from './split-layout.ts';

const DEFAULT_PACKAGE_ROOT = join(import.meta.dir, '../../../components/cinder');

/** The command a contributor runs to bring both regions up to date. */
export const ROOT_REGISTRIES_COMMAND =
  'cd components/cinder && bun scripts/generate-component-artifacts.ts';

const INDEX_START = '// <generated:component-exports>';
const INDEX_END = '// </generated:component-exports>';
const CSS_START = '/* <generated:component-imports>';
const CSS_END = '/* </generated:component-imports> */';

/**
 * Root names that differ from the component barrel's: `component → { barrel name → root name }`.
 * Each chart barrel re-exports the shared `ChartDataTableVisibility`, which the root offers once
 * per chart under the chart's own name.
 */
export const ROOT_EXPORT_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'area-chart': { ChartDataTableVisibility: 'AreaChartDataTableVisibility' },
  'bar-chart': { ChartDataTableVisibility: 'BarChartDataTableVisibility' },
  'line-chart': { ChartDataTableVisibility: 'LineChartDataTableVisibility' },
  'matrix-chart': { ChartDataTableVisibility: 'MatrixChartDataTableVisibility' },
  spectrogram: { ChartDataTableVisibility: 'SpectrogramDataTableVisibility' },
  'spectrum-chart': { ChartDataTableVisibility: 'SpectrumChartDataTableVisibility' },
  waveform: { ChartDataTableVisibility: 'WaveformDataTableVisibility' },
};

/** Names a component barrel exports for Cinder's own use that the package root does not. */
export const ROOT_EXPORT_WITHHELD: Readonly<Record<string, readonly string[]>> = {
  'data-grid': ['DataGridEditType'],
};

/**
 * Stylesheets whose cascade position predates path order. Each moves to just after `after`;
 * pins apply in this order, so a pin may anchor on an earlier one. An `import` that is not a
 * component stylesheet (`./components/json-highlight.css`) is inserted. Keep a pin while its
 * rules could tie with a neighbor's; the CSS fingerprint (`bun scripts/css-fingerprint.ts`)
 * changes when one is dropped.
 */
export const CSS_IMPORT_ORDER_PINS: readonly { import: string; after: string }[] = [
  {
    import: '../components/docked-action-bar/docked-action-bar.css',
    after: '../components/donut-chart/donut-chart.css',
  },
  { import: '../components/popover/popover-surface.css', after: '../components/feed/feed.css' },
  {
    import: '../components/grouped-list-item/grouped-list-item.css',
    after: '../components/grouped-list/grouped-list.css',
  },
  {
    import: '../components/grid/grid.css',
    after: '../components/grouped-list-item/grouped-list-item.css',
  },
  {
    import: '../components/inspector-row/inspector-row.css',
    after: '../components/inspector/inspector.css',
  },
  {
    import: './components/json-highlight.css',
    after: '../components/invocation-rule-builder/invocation-rule-builder.css',
  },
  {
    import: '../components/week-schedule/week-schedule.css',
    after: '../components/key-facts/key-facts.css',
  },
  {
    import: '../components/map-marker/map-marker.css',
    after: '../components/week-schedule/week-schedule.css',
  },
  {
    import: '../components/map-legend/map-legend.css',
    after: '../components/map-marker/map-marker.css',
  },
  { import: '../components/_radio/radio.css', after: '../components/qr-code/qr-code.css' },
  {
    import: '../components/section-heading/section-heading.css',
    after: '../components/section/section.css',
  },
  {
    import: '../components/theme-switch/theme-switch.css',
    after: '../components/toast-region/toast-region.css',
  },
];

/**
 * Component stylesheets the aggregate reaches only through another component's stylesheet
 * (`choice-grid.css` imports `choice-grid-item.css`; `command-menu.css` and
 * `command-palette.css` import `command-item.css`), so their rules land where that import sits.
 * `_internal/` stylesheets are always reached that way and never listed.
 */
export const CSS_REACHED_THROUGH_IMPORTS: readonly string[] = [
  '../components/choice-grid-item/choice-grid-item.css',
  '../components/command-item/command-item.css',
];

/** A component barrel's contribution to the root: runtime and type names, keyed by root name. */
type Claim = { directory: string; sourceName: string; rootName: string; type: boolean };

/** The two registry files, as the generator would write them. */
export type RootRegistries = { index: string; componentsCss: string };

/** One stale registry: the file relative to the package root and why. */
export type RootRegistryIssue = { file: string; reason: string };

function pascalName(directory: string): string {
  return directory
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * A Cinder package core depends on, which holds part of core's tree at the paths core gave it
 * (P-COR-101): its name without the scope, its root, and its component directories.
 */
type Holder = { name: string; root: string; components: string[] };

/** The Cinder packages of the core at `packageRoot`: tokens, foundation and each family. */
function cinderHolders(packageRoot: string): Holder[] {
  return cinderPackages(packageRoot).map(([name, root]) => {
    const componentsRoot = join(root, 'src', 'components');
    const components = existsSync(componentsRoot)
      ? readdirSync(componentsRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
          .map((entry) => entry.name)
      : [];
    return { name: name.slice(PACKAGE_SCOPE.length), root, components };
  });
}

/** Every directory that holds component directories: core's own, then each Cinder package's. */
function cinderComponentsRoots(packageRoot: string, holders: readonly Holder[]): string[] {
  return [packageRoot, ...holders.map((holder) => holder.root)]
    .map((root) => join(root, 'src', 'components'))
    .filter((root) => existsSync(root));
}

/** The component barrels core's root re-exports, in evaluation order, wherever each lives. */
export function rootBarrelDirectories(
  packageRoot: string = DEFAULT_PACKAGE_ROOT,
  recorded?: readonly string[],
): string[] {
  return barrelDirectories(
    cinderComponentsRoots(packageRoot, cinderHolders(packageRoot)),
    recorded,
  );
}

/**
 * How core's file `from` (a core-relative path) names the file core gave the path `path`: by a
 * relative specifier while core holds it, by the holding package's specifier once a package does.
 */
function coreSpecifier(holders: readonly Holder[], from: string, path: string): string {
  const holder = holders.find((candidate) => existsSync(join(candidate.root, path)));
  if (holder === undefined) {
    const specifier = posix.relative(posix.dirname(from), path);
    return specifier.startsWith('.') ? specifier : `./${specifier}`;
  }
  return specifierFor(holder.name, path, holder.components).specifier;
}

/** Each component directory with a barrel, by name, with the components root that holds it. */
function barrelLocations(componentsRoots: string | readonly string[]): Map<string, string> {
  const locations = new Map<string, string>();
  const roots = typeof componentsRoots === 'string' ? [componentsRoots] : componentsRoots;
  for (const componentsRoot of roots) {
    for (const entry of readdirSync(componentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name === 'icons') continue;
      if (!existsSync(join(componentsRoot, entry.name, 'index.ts'))) continue;
      if (!locations.has(entry.name)) locations.set(entry.name, componentsRoot);
    }
  }
  return locations;
}

/**
 * The recorded evaluation order of the barrels (`scripts/root-export-order.json`, taken from the
 * hand-written `src/index.ts` before COR-2393). A barrel imports its component's CSS, so the root's
 * export order is the order of component rules inside `@layer cinder.components` for every
 * application that imports the root; the generator must not change it.
 */
export const ROOT_EXPORT_ORDER_PATH = join(import.meta.dir, 'root-export-order.json');

/**
 * The component directories whose barrels the root re-exports, in evaluation order: the recorded
 * order for every component it lists, and each component it does not list (one added since)
 * straight after its alphabetical predecessor. The list is never written back, so two branches
 * that each add a component change no shared file: the position is derived, not stored.
 */
export function barrelDirectories(
  componentsRoots: string | readonly string[],
  recorded: readonly string[] = JSON.parse(readFileSync(ROOT_EXPORT_ORDER_PATH, 'utf8')),
): string[] {
  const present = [...barrelLocations(componentsRoots).keys()];
  const alphabetical = present.toSorted((left, right) =>
    compareCodeUnits(`${left}/index.ts`, `${right}/index.ts`),
  );
  const presentSet = new Set(present);
  const order = recorded.filter((name) => presentSet.has(name));
  const placed = new Set(order);
  for (const name of alphabetical) {
    if (placed.has(name)) continue;
    const predecessor = alphabetical[alphabetical.indexOf(name) - 1];
    const at = predecessor === undefined ? 0 : order.indexOf(predecessor) + 1;
    order.splice(at, 0, name);
    placed.add(name);
  }
  return order;
}

function splitRegion(text: string, start: string, end: string, file: string) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`${file} has no ${start} … ${end} region; restore the markers.`);
  }
  const afterStartLine = text.indexOf('\n', startIndex);
  return {
    before: text.slice(0, startIndex),
    header: text.slice(startIndex, afterStartLine + 1),
    after: text.slice(endIndex),
  };
}

/** Names the hand-authored rest of `src/index.ts` exports; the generator never re-exports them. */
function handAuthoredNames(source: string, indexPath: string): Set<string> {
  const file = ts.createSourceFile(indexPath, source, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement)) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        throw new Error(
          `${indexPath}: declare exports in their own module and re-export them; the root barrel only re-exports.`,
        );
      }
      continue;
    }
    const clause = statement.exportClause;
    if (clause !== undefined && ts.isNamedExports(clause)) {
      for (const element of clause.elements) names.add(element.name.text);
      continue;
    }
    if (clause !== undefined) {
      names.add(clause.name.text);
      continue;
    }
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    // A package core depends on is read through its `exports` (P-COR-101).
    const target = specifier.text.startsWith('.')
      ? resolve(dirname(indexPath), specifier.text)
      : resolvePackage(specifier.text, indexPath);
    if (target === undefined || !existsSync(target)) continue;
    const { runtime, types } = exportNames(target);
    for (const name of [...runtime, ...types]) if (name !== 'default') names.add(name);
  }
  return names;
}

function componentClaims(componentsRoot: string, directory: string): Claim[] {
  const { runtime, types } = exportNames(join(componentsRoot, directory, 'index.ts'));
  const pascal = pascalName(directory);
  const aliases = ROOT_EXPORT_ALIASES[directory] ?? {};
  const withheld = new Set(ROOT_EXPORT_WITHHELD[directory] ?? []);
  const claims: Claim[] = [];
  for (const [names, type] of [
    [runtime, false],
    [types, true],
  ] as const) {
    for (const sourceName of names) {
      if (sourceName === pascal || withheld.has(sourceName)) continue;
      const rootName = sourceName === 'default' ? pascal : (aliases[sourceName] ?? sourceName);
      claims.push({ directory, sourceName, rootName, type });
    }
  }
  return claims;
}

/** Of several barrels exporting one name, the one whose component the name names. */
function owner(claims: Claim[]): Claim {
  const byDefault = claims.find((claim) => claim.sourceName === 'default');
  if (byDefault !== undefined) return byDefault;
  let best = claims[0] as Claim;
  let bestLength = -1;
  for (const claim of claims) {
    const pascal = pascalName(claim.directory);
    if (claim.rootName.startsWith(pascal) && pascal.length > bestLength) {
      best = claim;
      bestLength = pascal.length;
    }
  }
  return best;
}

function specifierElement(claim: Claim): string {
  return claim.sourceName === claim.rootName
    ? claim.rootName
    : `${claim.sourceName} as ${claim.rootName}`;
}

function sortKey(claim: Claim): string {
  return claim.sourceName === 'default' ? 'default' : claim.sourceName;
}

function renderIndexRegion(packageRoot: string, handAuthored: Set<string>): string {
  const holders = cinderHolders(packageRoot);
  const roots = cinderComponentsRoots(packageRoot, holders);
  const locations = barrelLocations(roots);
  const directories = barrelDirectories(roots);
  const claimsByName = new Map<string, Claim[]>();
  for (const directory of directories) {
    for (const claim of componentClaims(locations.get(directory) as string, directory)) {
      if (handAuthored.has(claim.rootName)) continue;
      const existing = claimsByName.get(claim.rootName) ?? [];
      existing.push(claim);
      claimsByName.set(claim.rootName, existing);
    }
  }
  const owned = new Map<string, Claim[]>();
  for (const claims of claimsByName.values()) {
    const winner = owner(claims);
    owned.set(winner.directory, [...(owned.get(winner.directory) ?? []), winner]);
  }
  const blocks: string[] = [];
  for (const directory of directories) {
    const claims = (owned.get(directory) ?? []).toSorted((left, right) =>
      compareCodeUnits(sortKey(left), sortKey(right)),
    );
    const specifier = `'${coreSpecifier(holders, 'src/index.ts', `src/components/${directory}/index.ts`)}'`;
    const runtime = claims.filter((claim) => !claim.type).map(specifierElement);
    const types = claims.filter((claim) => claim.type).map(specifierElement);
    const lines: string[] = [];
    if (runtime.length > 0) lines.push(`export { ${runtime.join(', ')} } from ${specifier};`);
    if (types.length > 0) lines.push(`export type { ${types.join(', ')} } from ${specifier};`);
    if (lines.length > 0) blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n') + '\n';
}

function renderCssRegion(packageRoot: string): string {
  const holders = cinderHolders(packageRoot);
  const skipped = new Set(CSS_REACHED_THROUGH_IMPORTS);
  // Ordered and pinned by the path core gave each stylesheet, wherever it lives now (P-COR-101).
  const order = cinderComponentsRoots(packageRoot, holders)
    .flatMap((componentsRoot) =>
      readdirSync(componentsRoot, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && entry.name !== 'icons' && entry.name !== '_internal',
        )
        .flatMap((entry) =>
          readdirSync(join(componentsRoot, entry.name))
            .filter((name) => name.endsWith('.css'))
            .map((name) => `../components/${entry.name}/${name}`),
        ),
    )
    .filter((specifier) => !skipped.has(specifier))
    .toSorted(compareCodeUnits);
  for (const pin of CSS_IMPORT_ORDER_PINS) {
    const current = order.indexOf(pin.import);
    const isComponentStylesheet = pin.import.startsWith('../components/');
    if (current === -1 && isComponentStylesheet) {
      throw new Error(
        `CSS_IMPORT_ORDER_PINS names ${pin.import}, which no longer exists; remove its pin.`,
      );
    }
    if (current !== -1) order.splice(current, 1);
    const anchor = order.indexOf(pin.after);
    if (anchor === -1) {
      throw new Error(
        `CSS_IMPORT_ORDER_PINS anchors ${pin.import} after ${pin.after}, which is not imported.`,
      );
    }
    order.splice(anchor + 1, 0, pin.import);
  }
  return (
    order
      .map(
        (specifier) =>
          `@import '${coreSpecifier(holders, STYLESHEET, posix.join(posix.dirname(STYLESHEET), specifier))}';`,
      )
      .join('\n') + '\n'
  );
}

/** Core's component stylesheet aggregate, core-relative. */
const STYLESHEET = 'src/styles/components.css';

/** A package specifier, resolved from `from` through the package's `exports`, if it resolves. */
function resolvePackage(specifier: string, from: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, dirname(from));
  } catch {
    return undefined;
  }
}

async function format(text: string, filepath: string): Promise<string> {
  // Resolve options from this package's own path, so a copy outside the repository (the drift
  // test's temporary trees) formats exactly as the checked-in files do.
  const options = await prettier.resolveConfig(join(DEFAULT_PACKAGE_ROOT, 'src', 'index.ts'));
  return prettier.format(text, { ...options, filepath });
}

/** Both registry files as the generator writes them for the package at `packageRoot`. */
export async function buildRootRegistries(
  packageRoot: string = DEFAULT_PACKAGE_ROOT,
): Promise<RootRegistries> {
  const indexPath = join(packageRoot, 'src', 'index.ts');
  const cssPath = join(packageRoot, 'src', 'styles', 'components.css');
  const indexText = readFileSync(indexPath, 'utf8');
  const indexParts = splitRegion(indexText, INDEX_START, INDEX_END, 'src/index.ts');
  const handAuthored = handAuthoredNames(indexParts.before + indexParts.after, indexPath);
  const index =
    indexParts.before +
    indexParts.header +
    renderIndexRegion(packageRoot, handAuthored) +
    indexParts.after;
  const cssText = readFileSync(cssPath, 'utf8');
  const cssParts = splitRegion(cssText, CSS_START, CSS_END, 'src/styles/components.css');
  const commentEnd = cssText.indexOf('*/', cssText.indexOf(CSS_START)) + 2;
  const cssHeader = cssText.slice(cssText.indexOf(CSS_START), commentEnd) + '\n';
  const componentsCss = cssParts.before + cssHeader + renderCssRegion(packageRoot) + cssParts.after;
  return {
    index: await format(index, indexPath),
    componentsCss: await format(componentsCss, cssPath),
  };
}

function registryPaths(packageRoot: string) {
  return {
    index: join(packageRoot, 'src', 'index.ts'),
    componentsCss: join(packageRoot, 'src', 'styles', 'components.css'),
  } as const;
}

/** The stale registries of the package at `packageRoot`; empty when both are current. */
export async function checkRootRegistries(
  packageRoot: string = DEFAULT_PACKAGE_ROOT,
): Promise<RootRegistryIssue[]> {
  const generated = await buildRootRegistries(packageRoot);
  const paths = registryPaths(packageRoot);
  const issues: RootRegistryIssue[] = [];
  for (const key of ['index', 'componentsCss'] as const) {
    if (readFileSync(paths[key], 'utf8') !== generated[key]) {
      issues.push({
        file: relative(packageRoot, paths[key]),
        reason: `stale: regenerate with \`${ROOT_REGISTRIES_COMMAND}\``,
      });
    }
  }
  return issues;
}

/** Rewrite both registries of the package at `packageRoot`; returns the files that changed. */
export async function writeRootRegistries(
  packageRoot: string = DEFAULT_PACKAGE_ROOT,
): Promise<string[]> {
  const generated = await buildRootRegistries(packageRoot);
  const paths = registryPaths(packageRoot);
  const changed: string[] = [];
  for (const key of ['index', 'componentsCss'] as const) {
    if (readFileSync(paths[key], 'utf8') === generated[key]) continue;
    writeFileSync(paths[key], generated[key]);
    changed.push(relative(packageRoot, paths[key]));
  }
  return changed;
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const issues = await checkRootRegistries();
    for (const issue of issues) process.stderr.write(`${issue.file}: ${issue.reason}\n`);
    process.exitCode = issues.length > 0 ? 1 : 0;
  } else {
    for (const file of await writeRootRegistries()) process.stdout.write(`generated ${file}\n`);
  }
}
