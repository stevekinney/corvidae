import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPOUND_COMPONENT_PARENTS } from './shell-app/compound-families.ts';

const PLAYGROUND_ROOT = dirname(import.meta.dirname);

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
  componentsRoot: string;
  manifestPath: string;
  repositoryComponentsRoot: string;
  componentNames: readonly string[] | null;
  importPath(componentName: string): string;
  componentStylesheetUrl(componentName: string): string | null;
};

const cinderPackageRoot = workspacePackageRoot('@lostgradient/cinder');
const chatPackageRoot = workspacePackageRoot('@lostgradient/chat');
const editorPackageRoot = workspacePackageRoot('@lostgradient/editor');

export const CINDER_COMPONENT_SOURCE: ComponentSource = {
  id: 'cinder',
  packageName: '@lostgradient/cinder',
  packageRoot: cinderPackageRoot,
  componentsRoot: join(cinderPackageRoot, 'src', 'components'),
  manifestPath: join(cinderPackageRoot, 'components.json'),
  repositoryComponentsRoot: 'packages/components/src/components',
  // The Cinder set is discovered from its large, evolving source tree.
  componentNames: null,
  // Every component imports from the package root, the one entry point the
  // package's `exports` map declares.
  importPath: () => '@lostgradient/cinder',
  // Cinder's full component cascade is already loaded from /styles/all.css.
  componentStylesheetUrl: () => null,
};

const DOCUMENTATION_CINDER_COMPONENT_SET = new Set<string>(DOCUMENTATION_CINDER_COMPONENTS);
const CINDER_ROOT_BARREL_IMPORT = /import\s*\{([^}]+)\}\s*from\s*['"]@lostgradient\/cinder['"]/gu;
const RELATIVE_IMPLEMENTATION_IMPORT = /from\s+['"](\.{1,2}\/[^'"]+\.(?:svelte|ts))['"]/gu;
/** A relative stylesheet imported for its side effect: `import './prosemirror.css';`. */
const SIDE_EFFECT_STYLESHEET_IMPORT = /^[ \t]*import\s+['"](\.{1,2}\/[^'"]+\.css)['"]/gmu;

type ManifestComponent = { id?: unknown; exportName?: unknown };
type ComponentManifestFile = { components?: unknown };

/** Read a package manifest's `id` to `exportName` table, skipping malformed entries. */
function readManifestExportNamesById(manifestPath: string): ReadonlyMap<string, string> {
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
  cinderComponentNameByExport = undefined;
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

function cinderComponentStylesheetUrl(componentName: string): string | null {
  const owner = stylesheetOwner(componentName);
  if (DOCUMENTATION_CINDER_COMPONENT_SET.has(owner)) return null;
  const stylesheet = join(cinderPackageRoot, 'src', 'components', owner, `${owner}.css`);
  return existsSync(stylesheet) ? `/components/${owner}/${owner}.css` : null;
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

function implementationDependencies(
  componentsRoot: string,
  implementationPath: string,
  dependencies: Set<string>,
  visitedPaths = new Set<string>(),
): void {
  const resolvedPath = resolve(implementationPath);
  const resolvedComponentsRoot = resolve(componentsRoot);
  const pathWithinComponentsRoot = relative(resolvedComponentsRoot, resolvedPath);
  const isOutsideComponentsRoot =
    pathWithinComponentsRoot === '..' ||
    pathWithinComponentsRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathWithinComponentsRoot);
  if (isOutsideComponentsRoot || visitedPaths.has(resolvedPath)) return;
  visitedPaths.add(resolvedPath);
  if (resolvedComponentsRoot === resolve(cinderPackageRoot, 'src', 'components')) {
    const componentName = pathWithinComponentsRoot.split(sep)[0];
    if (componentName !== undefined && componentName !== '') dependencies.add(componentName);
  }
  if (!existsSync(resolvedPath)) return;

  const source = readFileSync(resolvedPath, 'utf8');
  cinderComponentDependenciesFromSource(source, dependencies);
  for (const match of source.matchAll(RELATIVE_IMPLEMENTATION_IMPORT)) {
    implementationDependencies(
      resolvedComponentsRoot,
      resolve(dirname(resolvedPath), match[1]!),
      dependencies,
      visitedPaths,
    );
  }
}

/**
 * Collect the stylesheets a component's implementation imports for their side effect
 * that are not its `<name>/<name>.css` sidecar, following the same relative imports
 * `implementationDependencies` follows. The sidecar lookup finds a component's own
 * stylesheet by that name, and the page bundle drops CSS that JavaScript imports
 * rather than linking it, so a differently named stylesheet (the ProseMirror baseline
 * `markdown-editor.svelte` imports, which every editor embedding it also needs) would
 * otherwise never reach the page. Sidecars are skipped here because the lookup owns them.
 */
function implementationStylesheetImports(
  componentSource: ComponentSource,
  implementationPath: string,
  stylesheetUrls: Set<string>,
  visitedPaths = new Set<string>(),
): void {
  const resolvedComponentsRoot = resolve(componentSource.componentsRoot);
  const resolvedPath = resolve(implementationPath);
  const isWithinComponentsRoot = (path: string): boolean => {
    const pathWithinRoot = relative(resolvedComponentsRoot, path);
    return (
      pathWithinRoot !== '..' &&
      !pathWithinRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathWithinRoot)
    );
  };
  if (!isWithinComponentsRoot(resolvedPath) || visitedPaths.has(resolvedPath)) return;
  visitedPaths.add(resolvedPath);
  if (!existsSync(resolvedPath)) return;

  const source = readFileSync(resolvedPath, 'utf8');
  for (const match of source.matchAll(SIDE_EFFECT_STYLESHEET_IMPORT)) {
    const stylesheetPath = resolve(dirname(resolvedPath), match[1]!);
    if (!isWithinComponentsRoot(stylesheetPath) || !existsSync(stylesheetPath)) continue;
    const segments = relative(resolvedComponentsRoot, stylesheetPath).split(sep);
    const fileName = segments.at(-1);
    const directoryName = segments.at(-2);
    if (fileName === `${directoryName}.css`) continue;
    stylesheetUrls.add(`/package-components/${componentSource.id}/${segments.join('/')}`);
  }
  for (const match of source.matchAll(RELATIVE_IMPLEMENTATION_IMPORT)) {
    implementationStylesheetImports(
      componentSource,
      resolve(dirname(resolvedPath), match[1]!),
      stylesheetUrls,
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
    const examplePath = join(
      PLAYGROUND_ROOT,
      'src',
      'examples',
      componentName,
      `${scenario}.example.svelte`,
    );
    const source = readFileSync(examplePath, 'utf8');
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
  implementationDependencies(
    componentSource.componentsRoot,
    join(componentSource.componentsRoot, componentName, `${componentName}.svelte`),
    cinderDependencyNames,
  );

  // Examples can import a Cinder component whose implementation composes more
  // primitives. Iterating the growing Set follows that complete graph instead
  // of stopping at the example's direct import (for example, ConfirmDialog →
  // Modal on Card's danger-zone examples).
  const visitedImplementationPaths = new Set<string>();
  for (const dependencyName of cinderDependencyNames) {
    implementationDependencies(
      CINDER_COMPONENT_SOURCE.componentsRoot,
      join(CINDER_COMPONENT_SOURCE.componentsRoot, dependencyName, `${dependencyName}.svelte`),
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

  const implementationStylesheetUrls = new Set<string>();
  if (componentSource.id !== CINDER_COMPONENT_SOURCE.id) {
    implementationStylesheetImports(
      componentSource,
      join(componentSource.componentsRoot, componentName, `${componentName}.svelte`),
      implementationStylesheetUrls,
    );
  }

  return [
    ...cinderStylesheetUrls,
    ...packageStylesheetUrls,
    ...implementationStylesheetUrls,
  ].filter((stylesheetUrl, index, urls) => urls.indexOf(stylesheetUrl) === index);
}

export const CHAT_COMPONENT_SOURCE: ComponentSource = {
  id: 'chat',
  packageName: '@lostgradient/chat',
  packageRoot: chatPackageRoot,
  componentsRoot: join(chatPackageRoot, 'src', 'lib', 'components'),
  manifestPath: join(chatPackageRoot, 'components.json'),
  repositoryComponentsRoot: 'packages/chat/src/lib/components',
  componentNames: CHAT_COMPONENT_NAMES,
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
  componentsRoot: editorComponentsRoot,
  manifestPath: join(editorPackageRoot, 'components.json'),
  repositoryComponentsRoot: 'packages/editor/src/lib/components',
  componentNames: EDITOR_COMPONENT_NAMES,
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
