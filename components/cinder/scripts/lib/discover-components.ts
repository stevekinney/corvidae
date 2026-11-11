/**
 * Shared component discovery for the cinder code generation pipeline.
 *
 * Walks `components/cinder/src/components/` and returns every component
 * directory that has both a `<name>.svelte` and a `<name>.types.ts` file.
 * Skips underscore-prefixed directories (private/internal) and `icons`.
 *
 * Consumed by:
 *   - component metadata and example generators
 *   - source-level component checks
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_ROOT = join(scriptDirectory, '..', '..', 'src', 'components');

export type ComponentDiscovery = {
  /** Kebab-case directory name (e.g. `accordion-item`). */
  name: string;
  /**
   * True when the component directory contains a source CSS sidecar
   * (`<name>.css`). Retained source tooling uses this to identify components
   * that own a sidecar stylesheet.
   */
  hasCss: boolean;
};

/**
 * Discover every directory-shaped component under `src/components/`.
 *
 * Results are sorted alphabetically by name.
 */
export async function discoverComponents(): Promise<ComponentDiscovery[]> {
  const result: ComponentDiscovery[] = [];
  for (const entry of await readdir(COMPONENTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    if (entry.name === 'icons') continue;

    const directory = join(COMPONENTS_ROOT, entry.name);
    if (!existsSync(join(directory, `${entry.name}.svelte`))) continue;
    if (!existsSync(join(directory, `${entry.name}.types.ts`))) continue;
    const hasCss = existsSync(join(directory, `${entry.name}.css`));
    result.push({ name: entry.name, hasCss });
  }
  return result.toSorted((a, b) => a.name.localeCompare(b.name));
}
