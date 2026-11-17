/**
 * Shared component discovery for the cinder code generation pipeline.
 *
 * Returns every component core lists: the directories that hold both a `<name>.svelte` and a
 * `<name>.types.ts` file in core's `src/components/` and, once the split extracts them, in each
 * family package core depends on (`discoverComponentDirectories`). Skips underscore-prefixed
 * directories (private/internal) and `icons`.
 *
 * Consumed by:
 *   - component metadata and example generators
 *   - source-level component checks
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { discoverComponentDirectories } from '../discover-component-directories.ts';

export type ComponentDiscovery = {
  /** Kebab-case directory name (e.g. `accordion-item`). */
  name: string;
  /** Absolute path to the component directory, in whichever package holds it. */
  directory: string;
  /**
   * True when the component directory contains a source CSS sidecar
   * (`<name>.css`). Retained source tooling uses this to identify components
   * that own a sidecar stylesheet.
   */
  hasCss: boolean;
};

/**
 * Discover every directory-shaped component core lists.
 *
 * Results are sorted alphabetically by name.
 */
export async function discoverComponents(): Promise<ComponentDiscovery[]> {
  const components = await discoverComponentDirectories();
  return components.map(({ name, directory }) => ({
    name,
    directory,
    hasCss: existsSync(join(directory, `${name}.css`)),
  }));
}
