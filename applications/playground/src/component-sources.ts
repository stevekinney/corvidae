import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPOUND_COMPONENT_PARENTS } from './shell-app/compound-families.generated.ts';

/**
 * Resolve a workspace package's root directory from its package name. Each
 * component package's `exports` map is the single key `"."` pointing at
 * `./src/index.ts`, so the root is two directories above the resolved barrel.
 * Resolving by name keeps the playground independent of where the repository
 * lays its packages out.
 */
function workspacePackageRoot(name: string): string {
  return dirname(dirname(fileURLToPath(import.meta.resolve(name))));
}

export const DOCUMENTATION_CINDER_COMPONENTS = [
  'accordion',
  'alert',
  'badge',
  'button',
  'callout',
  'code-block',
  'collapsible',
  'color-picker',
  'color-swatch-picker',
  'command-item',
  'command-palette',
  'copy-button',
  'kbd',
  'input',
  'popover',
  'status-dot',
  'table',
  'toggle',
  'tooltip',
] as const;

export const LANDING_CINDER_COMPONENTS = [
  'button',
  'code-block',
  'color-picker',
  'color-swatch-picker',
  'command-item',
  'command-palette',
  'copy-button',
  'form-field',
  'input',
  'popover',
  'tooltip',
] as const;

/** Every Chat component the playground documents, in sorted order. */
export const CHAT_COMPONENT_NAMES: readonly string[] = [
  'chat',
  'chat-composer-popover',
  'chat-conversation-header',
  'chat-conversation-list',
  'chat-navigation-rail',
  'chat-sub-session',
];
const CHAT_COMPONENT_NAME_SET: ReadonlySet<string> = new Set(CHAT_COMPONENT_NAMES);

/** Every Editor component the playground documents, in sorted order. */
export const EDITOR_COMPONENT_NAMES: readonly string[] = [
  'diff-review',
  'diff-review-comments',
  'diff-viewer',
  'markdown-editor',
  'review-editor',
];
const EDITOR_COMPONENT_NAME_SET: ReadonlySet<string> = new Set(EDITOR_COMPONENT_NAMES);

/**
 * One published component package represented in the shared playground.
 *
 * Keeping package topology here prevents discovery, documentation, bundling,
 * styles, and browser-test manifests from each growing their own package-name
 * special cases as domain packages are extracted from Cinder.
 */
export type ComponentSource = {
  id: string;
  packageName: string;
  packageRoot: string;
  manifestPath: string;
  componentNames: readonly string[] | null;
  /**
   * Every component the package lists, by name, with where its source lives. Read once and kept
   * until {@link resetComponentExportNames}.
   */
  components(): ReadonlyMap<string, ComponentLocation>;
  importPath(componentName: string): string;
  componentStylesheetUrl(componentName: string): string | null;
};

/** Where one component's source lives. */
export type ComponentLocation = {
  /** The component's directory, the one holding `<name>.svelte`. */
  directory: string;
  /** The root of the package that owns the directory: Cinder's core, a family, chat, editor. */
  packageRoot: string;
  /** The package that owns the directory. */
  packageName: string;
  /** The directory's path in the public mirror (`stevekinney/cinder`), for source links. */
  repositoryDirectory: string;
};

/**
 * Where the public mirror keeps each package. The documentation links into the mirror, whose layout
 * the mirror tooling owns: core is `packages/components`, and every other package is assumed to be
 * `packages/<name without its scope>`, as chat and editor are.
 */
const MIRROR_PACKAGE_DIRECTORIES: Readonly<Record<string, string>> = {
  '@lostgradient/cinder': 'packages/components',
};

function mirrorPackageDirectory(packageName: string): string {
  return Object.hasOwn(MIRROR_PACKAGE_DIRECTORIES, packageName)
    ? MIRROR_PACKAGE_DIRECTORIES[packageName]!
    : `packages/${packageName.replace(/^@[^/]+\//u, '')}`;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

type ManifestSource = { package?: unknown; packageRoot?: unknown; directory?: unknown };

/**
 * Every component a package manifest lists, with where its source lives (COR-2085): core's
 * `components.json` names, for each component, the package that owns it, that package's directory
 * relative to core, and the component's directory relative to that package. A component in a
 * family package is listed exactly as one still in core, so discovery needs no other edit when a
 * family is extracted.
 */
export function manifestComponentLocations(
  manifestPath: string,
): ReadonlyMap<string, ComponentLocation> {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    components?: { id?: unknown; source?: ManifestSource }[];
  };
  // Source paths are relative to the package's directory: the manifest's own, or the parent of the
  // `.metadata/` the `metadata` task writes it into (COR-2078).
  const manifestDirectory = dirname(manifestPath);
  const manifestRoot =
    basename(manifestDirectory) === '.metadata' ? dirname(manifestDirectory) : manifestDirectory;
  const locations = new Map<string, ComponentLocation>();
  for (const component of manifest.components ?? []) {
    const source = component.source;
    if (
      typeof component.id !== 'string' ||
      typeof source?.package !== 'string' ||
      typeof source.packageRoot !== 'string' ||
      typeof source.directory !== 'string'
    ) {
      throw new Error(
        `[playground] ${manifestPath} lists ${String(component.id)} without its source directory`,
      );
    }
    if (locations.has(component.id)) {
      throw new Error(`[playground] ${manifestPath} lists ${component.id} twice`);
    }
    const packageRoot = resolve(manifestRoot, source.packageRoot);
    locations.set(component.id, {
      directory: resolve(packageRoot, source.directory),
      packageRoot,
      packageName: source.package,
      repositoryDirectory: `${mirrorPackageDirectory(source.package)}/${source.directory}`,
    });
  }
  return locations;
}

/**
 * Every component directory under one package's components root: `<name>/<name>.svelte`, skipping
 * underscore-prefixed names (internal-only) and `icons/`. For the packages with no manifest that
 * records where their components live.
 */
export function scannedComponentLocations(
  componentsRoot: string,
  packageName: string,
  packageRoot: string,
): ReadonlyMap<string, ComponentLocation> {
  const locations = new Map<string, ComponentLocation>();
  for (const entry of readdirSync(componentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name === 'icons') continue;
    const directory = join(componentsRoot, entry.name);
    if (!existsSync(join(directory, `${entry.name}.svelte`))) continue;
    locations.set(entry.name, {
      directory,
      packageRoot,
      packageName,
      repositoryDirectory: `${mirrorPackageDirectory(packageName)}/${toPosix(relative(packageRoot, directory))}`,
    });
  }
  return new Map([...locations].toSorted(([left], [right]) => left.localeCompare(right)));
}

const componentLocationsBySourceId = new Map<string, ReadonlyMap<string, ComponentLocation>>();

/** Memoize `read` per source id until {@link resetComponentExportNames}. */
function cachedLocations(
  sourceId: string,
  read: () => ReadonlyMap<string, ComponentLocation>,
): () => ReadonlyMap<string, ComponentLocation> {
  return () => {
    let locations = componentLocationsBySourceId.get(sourceId);
    if (locations === undefined) {
      locations = read();
      componentLocationsBySourceId.set(sourceId, locations);
    }
    return locations;
  };
}

/**
 * Cinder's component source, rooted at core's directory. Its components come from core's
 * manifest, so the ones in family packages are found exactly as the ones still in core are.
 * Exported for the tests that build a fixture core.
 */
export function createCinderComponentSource(packageRoot: string, id = 'cinder'): ComponentSource {
  // The `metadata` task writes core's manifest into `.metadata/` (COR-2078).
  const manifestPath = join(packageRoot, '.metadata', 'components.json');
  return {
    id,
    packageName: '@lostgradient/cinder',
    packageRoot,
    manifestPath,
    // The Cinder set is discovered from its large, evolving manifest.
    componentNames: null,
    components: cachedLocations(id, () => manifestComponentLocations(manifestPath)),
    // Every component imports from the package root, the one entry point the
    // package's `exports` map declares.
    importPath: () => '@lostgradient/cinder',
    // Cinder's full component cascade is already loaded from /styles/all.css.
    componentStylesheetUrl: () => null,
  };
}

const cinderPackageRoot = workspacePackageRoot('@lostgradient/cinder');
const chatPackageRoot = workspacePackageRoot('@lostgradient/chat');
const editorPackageRoot = workspacePackageRoot('@lostgradient/editor');

export const CINDER_COMPONENT_SOURCE: ComponentSource =
  createCinderComponentSource(cinderPackageRoot);

/** Where one of `source`'s components lives. Throws for a name the package does not list. */
export function componentLocation(
  source: ComponentSource,
  componentName: string,
): ComponentLocation {
  const location = source.components().get(componentName);
  if (location === undefined) {
    throw new Error(`[playground] ${source.packageName} lists no component named ${componentName}`);
  }
  return location;
}

/** The directory of one of `source`'s components: the one holding `<name>.svelte`. */
export function componentDirectory(source: ComponentSource, componentName: string): string {
  return componentLocation(source, componentName).directory;
}

/**
 * The directories that hold `source`'s component directories: one per package that owns a
 * component (core's own components root and each family's for Cinder), sorted.
 */
export function componentRoots(source: ComponentSource): readonly string[] {
  return [
    ...new Set([...source.components().values()].map((location) => dirname(location.directory))),
  ].toSorted();
}

/** The component root of `source` that holds `path`, or undefined outside every one. */
function componentRootHolding(source: ComponentSource, path: string): string | undefined {
  return componentRoots(source).find((root) => isWithin(root, path));
}

function isWithin(root: string, path: string): boolean {
  const pathWithinRoot = relative(resolve(root), resolve(path));
  return (
    pathWithinRoot !== '..' && !pathWithinRoot.startsWith(`..${sep}`) && !isAbsolute(pathWithinRoot)
  );
}

/** Where a component keeps its `*.example.svelte` files: `examples/` in its own directory. */
export function examplesDirectoryIn(source: ComponentSource, componentName: string): string {
  return join(componentDirectory(source, componentName), 'examples');
}

/** The file of one example scenario of one of `source`'s components. */
export function exampleFilePathIn(
  source: ComponentSource,
  componentName: string,
  scenario: string,
): string {
  return join(examplesDirectoryIn(source, componentName), `${scenario}.example.svelte`);
}

const DOCUMENTATION_CINDER_COMPONENT_SET = new Set<string>(DOCUMENTATION_CINDER_COMPONENTS);
const CINDER_ROOT_BARREL_IMPORT = /import\s*\{([^}]+)\}\s*from\s*['"]@lostgradient\/cinder['"]/gu;
const RELATIVE_IMPLEMENTATION_IMPORT = /from\s+['"](\.{1,2}\/[^'"]+\.(?:svelte|ts))['"]/gu;
/** A relative stylesheet imported for its side effect: `import './prosemirror.css';`. */
const SIDE_EFFECT_STYLESHEET_IMPORT = /^[ \t]*import\s+['"](\.{1,2}\/[^'"]+\.css)['"]/gmu;

type ManifestComponent = { id?: unknown; exportName?: unknown };
type ComponentManifestFile = { components?: unknown };

/** Read a package manifest's `id` to `exportName` table, skipping malformed entries. */
function readManifestExportNamesById(manifestPath: string): ReadonlyMap<string, string> {
  if (!existsSync(manifestPath)) {
    // The package's `metadata` task writes its manifest; a task that runs the playground through
    // Turborepo depends on it, and a direct `bun` run has to make it first.
    throw new Error(
      `${manifestPath} does not exist: run \`bunx turbo run metadata\` from the repository root first.`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ComponentManifestFile;
  const exportNames = new Map<string, string>();
  if (!Array.isArray(manifest.components)) return exportNames;
  for (const component of manifest.components as ManifestComponent[]) {
    if (typeof component.id !== 'string' || typeof component.exportName !== 'string') continue;
    exportNames.set(component.id, component.exportName);
  }
  return exportNames;
}

const exportNamesBySourceId = new Map<string, ReadonlyMap<string, string>>();
let cinderComponentNameByExport: ReadonlyMap<string, string> | undefined;

function exportNamesByComponentId(source: ComponentSource): ReadonlyMap<string, string> {
  let exportNames = exportNamesBySourceId.get(source.id);
  if (exportNames === undefined) {
    exportNames = readManifestExportNamesById(source.manifestPath);
    exportNamesBySourceId.set(source.id, exportNames);
  }
  return exportNames;
}

/**
 * Forget every package manifest read so far, so the next lookup reads the
 * current `components.json`. The dev server calls this when a watched file
 * changes: a component added or an export renamed after startup must reach the
 * next page bundle without a restart.
 */
export function resetComponentExportNames(): void {
  exportNamesBySourceId.clear();
  resetComponentLocations();
  cinderComponentNameByExport = undefined;
}

/**
 * Forget every package's component list, so the next lookup reads core's manifest and the other
 * packages' components roots again: a component added, removed, or extracted into a family.
 */
export function resetComponentLocations(): void {
  componentLocationsBySourceId.clear();
}

/** Cinder's component ids keyed by the name its package root exports them under. */
function cinderComponentNamesByExport(): ReadonlyMap<string, string> {
  cinderComponentNameByExport ??= new Map(
    [...exportNamesByComponentId(CINDER_COMPONENT_SOURCE)].map(([componentName, exportName]) => [
      exportName,
      componentName,
    ]),
  );
  return cinderComponentNameByExport;
}

/**
 * The export name a component's package root exposes it under, read from the
 * package's own manifest rather than derived from the component id.
 */
export function componentExportNameFor(source: ComponentSource, componentName: string): string {
  const exportName = exportNamesByComponentId(source).get(componentName);
  if (exportName === undefined) {
    throw new Error(`[playground] ${componentName} has no exportName in ${source.manifestPath}`);
  }
  return exportName;
}

function stylesheetOwner(componentName: string): string {
  return COMPOUND_COMPONENT_PARENTS[componentName] ?? componentName;
}

/**
 * The URL the playground serves one of Cinder's component stylesheets at: `/components/<path>`
 * for a stylesheet in core's own components root, where the aggregator's relative imports land,
 * and `/package-styles/<package>/<path>` for one in a family package, `<package>` being its name
 * without the scope and `<path>` the file's path in that package.
 */
export function cinderComponentStylesheetUrlFor(location: ComponentLocation, file: string): string {
  if (location.packageRoot === CINDER_COMPONENT_SOURCE.packageRoot) {
    return `/components/${toPosix(relative(dirname(location.directory), file))}`;
  }
  const packageDirectory = location.packageName.replace(/^@[^/]+\//u, '');
  return `/package-styles/${packageDirectory}/${toPosix(relative(location.packageRoot, file))}`;
}

function cinderComponentStylesheetUrl(componentName: string): string | null {
  const owner = stylesheetOwner(componentName);
  if (DOCUMENTATION_CINDER_COMPONENT_SET.has(owner)) return null;
  const location = CINDER_COMPONENT_SOURCE.components().get(owner);
  if (location === undefined) return null;
  const stylesheet = join(location.directory, `${owner}.css`);
  return existsSync(stylesheet) ? cinderComponentStylesheetUrlFor(location, stylesheet) : null;
}

function cinderComponentDependenciesFromSource(source: string, dependencies: Set<string>): void {
  for (const match of source.matchAll(CINDER_ROOT_BARREL_IMPORT)) {
    for (const importedName of match[1]!.split(',')) {
      const exportName = importedName
        .trim()
        .replace(/^type\s+/u, '')
        .split(/\s+as\s+/u)[0];
      if (exportName === undefined) continue;
      const componentName = cinderComponentNamesByExport().get(exportName);
      if (componentName !== undefined) dependencies.add(componentName);
    }
  }
}

function componentExportName(componentName: string): string {
  return componentName
    .split('-')
    .map((segment) => `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`)
    .join('');
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractedPackageComponentDependenciesFromSource(
  componentSource: ComponentSource,
  source: string,
  dependencies: Set<string>,
): void {
  if (componentSource.componentNames === null) return;

  for (const componentName of componentSource.componentNames) {
    const importPath = componentSource.importPath(componentName);
    const escapedImportPath = escapeRegularExpression(importPath);
    const namedImportPattern = new RegExp(
      `import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${escapedImportPath}['"]`,
      'gu',
    );

    for (const match of source.matchAll(namedImportPattern)) {
      const importedNames = match[1]!.split(',').map(
        (importedName) =>
          importedName
            .trim()
            .replace(/^type\s+/u, '')
            .split(/\s+as\s+/u)[0],
      );
      if (importedNames.includes(componentExportName(componentName))) {
        dependencies.add(componentName);
      }
    }
  }
}

/**
 * Walk `implementationPath` and its relative imports inside `componentSource`'s component roots,
 * collecting the Cinder components the files import from the package root. For Cinder itself,
 * every component directory the walk enters counts as a dependency too (its first segment below
 * the component root that holds it).
 */
function implementationDependencies(
  componentSource: ComponentSource,
  implementationPath: string,
  dependencies: Set<string>,
  visitedPaths = new Set<string>(),
): void {
  const resolvedPath = resolve(implementationPath);
  const componentRoot = componentRootHolding(componentSource, resolvedPath);
  if (componentRoot === undefined || visitedPaths.has(resolvedPath)) return;
  visitedPaths.add(resolvedPath);
  if (componentSource.id === CINDER_COMPONENT_SOURCE.id) {
    const componentName = relative(resolve(componentRoot), resolvedPath).split(sep)[0];
    if (componentName !== undefined && componentName !== '') dependencies.add(componentName);
  }
  if (!existsSync(resolvedPath)) return;

  const source = readFileSync(resolvedPath, 'utf8');
  cinderComponentDependenciesFromSource(source, dependencies);
  for (const match of source.matchAll(RELATIVE_IMPLEMENTATION_IMPORT)) {
    implementationDependencies(
      componentSource,
      resolve(dirname(resolvedPath), match[1]!),
      dependencies,
      visitedPaths,
    );
  }
}

/** A listed component's implementation file, `<directory>/<name>.svelte`, or undefined. */
function implementationFile(source: ComponentSource, componentName: string): string | undefined {
  const location = source.components().get(componentName);
  return location === undefined ? undefined : join(location.directory, `${componentName}.svelte`);
}

/** What a package component's implementation graph brings onto its documentation page. */
type ImplementationGraphStyles = {
  /** Side-effect stylesheets that are not a component's own `<name>/<name>.css` sidecar. */
  stylesheetUrls: Set<string>;
  /** Every component whose own implementation file the graph reaches, for the sidecars they ship. */
  componentNames: Set<string>;
};

/**
 * Walk a package component's relative imports, as `implementationDependencies` does for
 * Cinder, and collect the styles the page needs beyond what its examples name:
 *
 * - the components whose implementation file the graph reaches (`diff-review.svelte`
 *   renders `DiffReviewComments`, so that component's sidecar belongs on the page even
 *   though no example imports it), and
 * - side-effect stylesheets that are not a component's own sidecar. The sidecar lookup
 *   finds a component's stylesheet by its `<name>/<name>.css` name, and the page bundle
 *   drops CSS that JavaScript imports instead of linking it, so a differently named one
 *   (the ProseMirror baseline `markdown-editor.svelte` imports, which every editor
 *   embedding it also needs) would otherwise never reach the page.
 */
function walkImplementationGraphStyles(
  componentSource: ComponentSource,
  implementationPath: string,
  graph: ImplementationGraphStyles,
  visitedPaths = new Set<string>(),
): void {
  const resolvedPath = resolve(implementationPath);
  const componentRoot = componentRootHolding(componentSource, resolvedPath);
  if (componentRoot === undefined || visitedPaths.has(resolvedPath)) return;
  visitedPaths.add(resolvedPath);
  if (!existsSync(resolvedPath)) return;

  // A component counts as reached when its own implementation file is, not when a helper
  // module in its directory is: an example that imports only Chat's helpers does not render
  // Chat, so it must not pick up `chat.css`.
  const [componentName, implementationFileName, ...deeperSegments] = relative(
    resolve(componentRoot),
    resolvedPath,
  ).split(sep);
  if (
    componentName !== undefined &&
    deeperSegments.length === 0 &&
    implementationFileName === `${componentName}.svelte`
  ) {
    graph.componentNames.add(componentName);
  }

  const source = readFileSync(resolvedPath, 'utf8');
  for (const match of source.matchAll(SIDE_EFFECT_STYLESHEET_IMPORT)) {
    const stylesheetPath = resolve(dirname(resolvedPath), match[1]!);
    const stylesheetRoot = componentRootHolding(componentSource, stylesheetPath);
    if (stylesheetRoot === undefined || !existsSync(stylesheetPath)) continue;
    const segments = relative(resolve(stylesheetRoot), stylesheetPath).split(sep);
    const fileName = segments.at(-1);
    const directoryName = segments.at(-2);
    if (fileName === `${directoryName}.css`) continue;
    graph.stylesheetUrls.add(`/package-components/${componentSource.id}/${segments.join('/')}`);
  }
  for (const match of source.matchAll(RELATIVE_IMPLEMENTATION_IMPORT)) {
    walkImplementationGraphStyles(
      componentSource,
      resolve(dirname(resolvedPath), match[1]!),
      graph,
      visitedPaths,
    );
  }
}

/**
 * Return the stylesheet a documentation page needs in addition to the shared
 * documentation CSS. Cinder primitives rendered by the page itself are
 * already bundled into that shared asset; every other component retains its
 * own sidecar and compound-family imports.
 */
export function documentationComponentStylesheetUrl(
  componentSource: ComponentSource,
  componentName: string,
): string | null {
  if (componentSource.id === CINDER_COMPONENT_SOURCE.id) {
    return cinderComponentStylesheetUrl(componentName);
  }
  return componentSource.componentStylesheetUrl(componentName);
}

/**
 * Resolve styles for every component imported by a documented component's
 * examples. A page can compose an otherwise unrelated primitive (CheckboxGroup's
 * examples render Checkbox, for example), so its own sidecar alone is not
 * enough after removing the global stylesheet.
 */
export function documentationExampleStylesheetUrls(
  componentSource: ComponentSource,
  componentName: string,
  scenarios: readonly string[],
): string[] {
  const cinderDependencyNames = new Set<string>();
  const packageDependencyNames = new Set<string>([componentName]);
  for (const scenario of scenarios) {
    const source = readFileSync(
      exampleFilePathIn(componentSource, componentName, scenario),
      'utf8',
    );
    cinderComponentDependenciesFromSource(source, cinderDependencyNames);
    extractedPackageComponentDependenciesFromSource(
      componentSource,
      source,
      packageDependencyNames,
    );
  }

  if (componentSource.id === CINDER_COMPONENT_SOURCE.id) {
    cinderDependencyNames.add(componentName);
  }
  const documentedImplementation = implementationFile(componentSource, componentName);
  if (documentedImplementation !== undefined) {
    implementationDependencies(componentSource, documentedImplementation, cinderDependencyNames);
  }

  // Examples can import a Cinder component whose implementation composes more
  // primitives. Iterating the growing Set follows that complete graph instead
  // of stopping at the example's direct import (for example, ConfirmDialog →
  // Modal on Card's danger-zone examples).
  const visitedImplementationPaths = new Set<string>();
  for (const dependencyName of cinderDependencyNames) {
    const dependencyImplementation = implementationFile(CINDER_COMPONENT_SOURCE, dependencyName);
    if (dependencyImplementation === undefined) continue;
    implementationDependencies(
      CINDER_COMPONENT_SOURCE,
      dependencyImplementation,
      cinderDependencyNames,
      visitedImplementationPaths,
    );
  }

  const cinderStylesheetUrls = [...cinderDependencyNames]
    .toSorted()
    .map(cinderComponentStylesheetUrl)
    .filter((stylesheetUrl): stylesheetUrl is string => stylesheetUrl !== null);
  const packageStylesheetUrls =
    componentSource.id === CINDER_COMPONENT_SOURCE.id
      ? []
      : [...packageDependencyNames]
          .toSorted()
          .map((name) => componentSource.componentStylesheetUrl(name))
          .filter((stylesheetUrl): stylesheetUrl is string => stylesheetUrl !== null);

  const implementationGraph: ImplementationGraphStyles = {
    stylesheetUrls: new Set<string>(),
    componentNames: new Set<string>(),
  };
  if (componentSource.id !== CINDER_COMPONENT_SOURCE.id && documentedImplementation !== undefined) {
    walkImplementationGraphStyles(componentSource, documentedImplementation, implementationGraph);
  }
  const composedSidecarUrls = [...implementationGraph.componentNames]
    .toSorted()
    .map((name) => componentSource.componentStylesheetUrl(name))
    .filter((stylesheetUrl): stylesheetUrl is string => stylesheetUrl !== null);

  return [
    ...cinderStylesheetUrls,
    ...packageStylesheetUrls,
    ...composedSidecarUrls,
    ...implementationGraph.stylesheetUrls,
  ].filter((stylesheetUrl, index, urls) => urls.indexOf(stylesheetUrl) === index);
}

const chatComponentsRoot = join(chatPackageRoot, 'src', 'lib', 'components');

export const CHAT_COMPONENT_SOURCE: ComponentSource = {
  id: 'chat',
  packageName: '@lostgradient/chat',
  packageRoot: chatPackageRoot,
  manifestPath: join(chatPackageRoot, '.metadata', 'components.json'),
  componentNames: CHAT_COMPONENT_NAMES,
  components: cachedLocations('chat', () =>
    scannedComponentLocations(chatComponentsRoot, '@lostgradient/chat', chatPackageRoot),
  ),
  importPath(componentName) {
    if (!CHAT_COMPONENT_NAME_SET.has(componentName)) {
      throw new Error(
        `[playground] ${componentName} was discovered in @lostgradient/chat but has no public import path`,
      );
    }
    return '@lostgradient/chat';
  },
  componentStylesheetUrl: (componentName) =>
    `/package-components/chat/${componentName}/${componentName}.css`,
};

const editorComponentsRoot = join(editorPackageRoot, 'src', 'lib', 'components');

/**
 * Resolve a component's CSS-sidecar route from the component directory on
 * disk: a component ships a sidecar exactly when `<name>/<name>.css` exists.
 * `componentsRoot` is injected so this generalizes beyond the real tree; see
 * `component-sources.test.ts`.
 */
export function resolveEditorStylesheetUrl(
  componentsRoot: string,
  componentName: string,
): string | null {
  return existsSync(join(componentsRoot, componentName, `${componentName}.css`))
    ? `/package-components/editor/${componentName}/${componentName}.css`
    : null;
}

export const EDITOR_COMPONENT_SOURCE: ComponentSource = {
  id: 'editor',
  packageName: '@lostgradient/editor',
  packageRoot: editorPackageRoot,
  manifestPath: join(editorPackageRoot, '.metadata', 'components.json'),
  componentNames: EDITOR_COMPONENT_NAMES,
  components: cachedLocations('editor', () =>
    scannedComponentLocations(editorComponentsRoot, '@lostgradient/editor', editorPackageRoot),
  ),
  importPath(componentName) {
    if (!EDITOR_COMPONENT_NAME_SET.has(componentName)) {
      throw new Error(
        `[playground] ${componentName} was discovered in @lostgradient/editor but has no public import path`,
      );
    }
    return '@lostgradient/editor';
  },
  // Unlike Chat, Editor's components don't uniformly ship a standalone CSS
  // sidecar: `markdown-editor` and `diff-viewer` style entirely through
  // scoped `<style>` blocks compiled inline by Svelte. Check the component
  // directory on disk rather than hardcoding which components have a sidecar,
  // so this stays correct as Editor gains or drops sidecars.
  componentStylesheetUrl: (componentName) =>
    resolveEditorStylesheetUrl(editorComponentsRoot, componentName),
};

/** Ordered, canonical list of packages represented in the playground. */
export const COMPONENT_SOURCES: readonly ComponentSource[] = [
  CINDER_COMPONENT_SOURCE,
  CHAT_COMPONENT_SOURCE,
  EDITOR_COMPONENT_SOURCE,
];

/** Resolve a configured package source by its stable route identifier. */
export function componentSourceById(sourceId: string): ComponentSource | undefined {
  return COMPONENT_SOURCES.find((source) => source.id === sourceId);
}
