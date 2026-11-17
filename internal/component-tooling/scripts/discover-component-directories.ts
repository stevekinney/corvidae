/**
 * Walks `src/components/` and returns the canonical list of component
 * directories the artifact, constraint, schema, variables, examples, and
 * manifest generators all need.
 *
 * Extracted from `generate-component-artifacts.ts` so other generator scripts
 * (e.g. `check-component-constraints.ts`) can import this without forming
 * a cycle through the artifact orchestrator.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type DiscoveredComponent = {
  /** Absolute path to the component directory. */
  directory: string;
  /** Kebab-case component name (the directory basename). */
  name: string;
};

/** Cinder's package root, the default for every generator stage. */
export const CINDER_PACKAGE_ROOT = join(import.meta.dir, '../../../components/cinder');

/**
 * Where a component package keeps its component directories: `src/components/` in cinder,
 * `src/lib/components/` in chat, editor and terminal.
 */
export function componentsRootOf(packageRoot: string): string {
  const direct = join(packageRoot, 'src', 'components');
  return existsSync(direct) ? direct : join(packageRoot, 'src', 'lib', 'components');
}

/**
 * Discover every directory-shaped component of a component package (cinder by default).
 *
 * A directory qualifies when it contains both `<name>.svelte` and
 * `<name>.types.ts`. The presence of the `.types.ts` file is the marker that
 * the per-directory migration is complete; legacy flat or in-progress
 * subdirectories are skipped.
 *
 * `icons/` plus underscore-prefixed names (`_internal/`, etc.) are skipped.
 *
 * Returns the list sorted by absolute directory path.
 */
export async function discoverComponentDirectories(
  packageRoot: string = CINDER_PACKAGE_ROOT,
): Promise<DiscoveredComponent[]> {
  const results: DiscoveredComponent[] = [];
  const componentsRoot = componentsRootOf(packageRoot);

  for (const entry of await readdir(componentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;

    if (entry.name === 'icons') continue;

    const directory = join(componentsRoot, entry.name);
    if (!existsSync(join(directory, `${entry.name}.svelte`))) continue;
    if (!existsSync(join(directory, `${entry.name}.types.ts`))) continue;
    results.push({ directory, name: entry.name });
  }

  return results.toSorted((a, b) => a.directory.localeCompare(b.directory));
}
