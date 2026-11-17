/**
 * Returns the canonical list of component directories the artifact, constraint, schema, variables,
 * examples, and manifest generators all need: the components core (`@lostgradient/cinder`) lists.
 *
 * Those are the components still in core's own `src/components/`, plus the components of every
 * family package core depends on (COR-2085). A family package is a `workspace:` dependency of core
 * whose directory holds a `src/components/` of its own; tokens, foundation, the tooling and the
 * Markdown package hold none. Until every family is extracted (COR-2091 deletes core's own walk),
 * both places are read, and a component found in two of them stops the run: each must be listed
 * exactly once.
 *
 * Extracted from `generate-component-artifacts.ts` so other generator scripts
 * (e.g. `generate-component-constraints.ts`) can import this without forming
 * a cycle through the artifact orchestrator.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type DiscoveredComponent = {
  /** Absolute path to the component directory. */
  directory: string;
  /** Kebab-case component name (the directory basename). */
  name: string;
  /** The package that owns the directory: core, or one of its family packages. */
  packageName: string;
  /** Absolute path to that package's root. */
  packageRoot: string;
};

/** Core's directory, `components/cinder`. */
export const CORE_ROOT = join(import.meta.dir, '../../../components/cinder');

/** Core's package name, the one package whose discovery takes in its families. */
export const CORE_PACKAGE = '@lostgradient/cinder';

/** Cinder's package root, the default for every generator stage (COR-2078's name for core). */
export const CINDER_PACKAGE_ROOT = CORE_ROOT;

/**
 * Where a component package keeps its component directories: `src/components/` in core and its
 * families, `src/lib/components/` in chat, editor and terminal.
 */
export function componentsRootOf(packageRoot: string): string {
  const direct = join(packageRoot, 'src', 'components');
  return existsSync(direct) ? direct : join(packageRoot, 'src', 'lib', 'components');
}

type PackageManifest = { name?: unknown; dependencies?: unknown; workspaces?: unknown };

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

/** Every workspace directory the root manifest declares, by package name. */
function workspaceDirectories(repositoryRoot: string): Map<string, string> {
  const directories = new Map<string, string>();
  const patterns = readManifest(join(repositoryRoot, 'package.json')).workspaces;
  if (!Array.isArray(patterns)) return directories;
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    const candidates = pattern.endsWith('/*')
      ? readdirSync(join(repositoryRoot, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(repositoryRoot, pattern.slice(0, -2), entry.name))
      : [join(repositoryRoot, pattern)];
    for (const directory of candidates) {
      const manifestPath = join(directory, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const { name } = readManifest(manifestPath);
      if (typeof name === 'string') directories.set(name, directory);
    }
  }
  return directories;
}

/** The family packages core depends on, in dependency order: `[name, root]`. */
export function familyPackages(coreRoot: string = CORE_ROOT): [string, string][] {
  const { dependencies } = readManifest(join(coreRoot, 'package.json'));
  if (dependencies === null || typeof dependencies !== 'object') return [];
  const workspaceDependencies = Object.entries(dependencies).filter(
    ([, specification]) =>
      typeof specification === 'string' && specification.startsWith('workspace:'),
  );
  if (workspaceDependencies.length === 0) return [];
  const directories = workspaceDirectories(join(coreRoot, '..', '..'));
  const families: [string, string][] = [];
  for (const [name] of workspaceDependencies) {
    const directory = directories.get(name);
    if (directory !== undefined && existsSync(join(directory, 'src', 'components'))) {
      families.push([name, directory]);
    }
  }
  return families;
}

/**
 * Every Cinder package core depends on, `[name, root]`: each `workspace:` dependency that sits
 * beside core under `components/` with a `src` of its own (tokens, foundation and every family).
 * Empty until the split extracts one (P-COR-101).
 */
export function cinderPackages(coreRoot: string = CORE_ROOT): [string, string][] {
  const { dependencies } = readManifest(join(coreRoot, 'package.json'));
  if (dependencies === null || typeof dependencies !== 'object') return [];
  const packages: [string, string][] = [];
  for (const [name, specification] of Object.entries(dependencies)) {
    if (typeof specification !== 'string' || !specification.startsWith('workspace:')) continue;
    if (!name.startsWith('@lostgradient/')) continue;
    const directory = join(coreRoot, '..', name.slice('@lostgradient/'.length));
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath) || !existsSync(join(directory, 'src'))) continue;
    if (readManifest(manifestPath).name !== name) continue;
    packages.push([name, directory]);
  }
  return packages.toSorted(([a], [b]) => a.localeCompare(b));
}

/** Every Cinder `src` directory: core's, then each Cinder package's. */
export function cinderSourceRoots(coreRoot: string = CORE_ROOT): string[] {
  return [coreRoot, ...cinderPackages(coreRoot).map(([, root]) => root)]
    .map((root) => join(root, 'src'))
    .filter((root) => existsSync(root));
}

/**
 * Every directory that holds Cinder component directories: core's `src/components` and each
 * Cinder package's (foundation's holds the shared internals; each family's, its components).
 */
export function cinderComponentRoots(coreRoot: string = CORE_ROOT): string[] {
  return [coreRoot, ...cinderPackages(coreRoot).map(([, root]) => root)]
    .map((root) => join(root, 'src', 'components'))
    .filter((root) => existsSync(root));
}

/**
 * A file under one of Cinder's components roots, wherever it lives now (`button/button.css` is in
 * core's `src/components` until the split moves it into `components/button`). The path in core
 * when no root holds it.
 */
export function cinderComponentFile(relativePath: string, coreRoot: string = CORE_ROOT): string {
  return (
    cinderComponentRoots(coreRoot)
      .map((root) => join(root, relativePath))
      .find((path) => existsSync(path)) ?? join(coreRoot, 'src', 'components', relativePath)
  );
}

/**
 * A file under one of Cinder's package roots (`src/styles/tokens-base.css` is core's until the
 * split moves it into `components/tokens`), wherever it lives now: core's first, then each Cinder
 * package's. The path in core when no package holds it.
 */
export function cinderPackageFile(relativePath: string, coreRoot: string = CORE_ROOT): string {
  return (
    [coreRoot, ...cinderPackages(coreRoot).map(([, root]) => root)]
      .map((root) => join(root, relativePath))
      .find((path) => existsSync(path)) ?? join(coreRoot, relativePath)
  );
}

/** A file under one of Cinder's `src` directories (`styles/tokens-base.css`), wherever it lives now. */
export function cinderSourceFile(relativePath: string, coreRoot: string = CORE_ROOT): string {
  return cinderPackageFile(join('src', relativePath), coreRoot);
}

/**
 * A file's path the way core's checks and their baselines name it: relative to core, so `src/…`
 * while core holds it and `../<package>/src/…` once a package does.
 */
export function corePath(path: string, coreRoot: string = CORE_ROOT): string {
  return relative(coreRoot, path).split(sep).join('/');
}

/**
 * Every directory-shaped component under one package's `src/components/`. A directory qualifies
 * when it contains both `<name>.svelte` and `<name>.types.ts`. The presence of the `.types.ts`
 * file is the marker that the per-directory migration is complete; legacy flat or in-progress
 * subdirectories are skipped. `icons/` plus underscore-prefixed names (`_internal/`, etc.) are
 * skipped.
 */
async function packageComponentDirectories(
  packageName: string,
  packageRoot: string,
): Promise<DiscoveredComponent[]> {
  const componentsRoot = componentsRootOf(packageRoot);
  const results: DiscoveredComponent[] = [];
  for (const entry of await readdir(componentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    if (entry.name === 'icons') continue;

    const directory = join(componentsRoot, entry.name);
    if (!existsSync(join(directory, `${entry.name}.svelte`))) continue;
    if (!existsSync(join(directory, `${entry.name}.types.ts`))) continue;
    results.push({ directory, name: entry.name, packageName, packageRoot });
  }
  return results;
}

/**
 * Discover every component a package lists (core by default). Core lists its own and each
 * family's; any other package (chat, editor, terminal, or a family run on its own) lists its own.
 * Throws when two packages hold a component of the same name.
 *
 * Returns the list sorted by name, which for components all inside one package is the order of
 * their absolute directory paths.
 */
export async function discoverComponentDirectories(
  packageRoot: string = CORE_ROOT,
): Promise<DiscoveredComponent[]> {
  const name = readManifest(join(packageRoot, 'package.json')).name;
  const packageName = typeof name === 'string' ? name : '@lostgradient/cinder';
  const packages: [string, string][] = [
    [packageName, packageRoot],
    ...(packageName === CORE_PACKAGE ? familyPackages(packageRoot) : []),
  ];
  const owners = new Map<string, DiscoveredComponent>();
  for (const [ownerName, ownerRoot] of packages) {
    if (!existsSync(componentsRootOf(ownerRoot))) continue;
    for (const component of await packageComponentDirectories(ownerName, ownerRoot)) {
      const existing = owners.get(component.name);
      if (existing !== undefined) {
        throw new Error(
          `Component "${component.name}" is in both ${existing.packageName} (${existing.directory}) and ${component.packageName} (${component.directory}); list each component exactly once.`,
        );
      }
      owners.set(component.name, component);
    }
  }
  return [...owners.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}
