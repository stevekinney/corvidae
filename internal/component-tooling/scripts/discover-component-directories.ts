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
import { join } from 'node:path';

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
  const componentsRoot = join(packageRoot, 'src', 'components');
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
 * Discover every component core lists: core's own, then each family's. Throws when two packages
 * hold a component of the same name.
 *
 * Returns the list sorted by name, which for components all inside core is the order of their
 * absolute directory paths.
 */
export async function discoverComponentDirectories(
  coreRoot: string = CORE_ROOT,
): Promise<DiscoveredComponent[]> {
  const coreName = readManifest(join(coreRoot, 'package.json')).name;
  const packages: [string, string][] = [
    [typeof coreName === 'string' ? coreName : '@lostgradient/cinder', coreRoot],
    ...familyPackages(coreRoot),
  ];
  const owners = new Map<string, DiscoveredComponent>();
  for (const [packageName, packageRoot] of packages) {
    if (!existsSync(join(packageRoot, 'src', 'components'))) continue;
    for (const component of await packageComponentDirectories(packageName, packageRoot)) {
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
