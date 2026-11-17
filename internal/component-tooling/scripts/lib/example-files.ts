/** Where a component package keeps its examples (COR-2081). */

import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

const EXAMPLE_FILE = /\.example\.svelte$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.types', '.turbo', '.metadata', 'coverage']);

/**
 * Every `*.example.svelte` file in an `examples/` directory under `sourceDirectory`, sorted by its
 * path from there.
 */
export function exampleFiles(sourceDirectory: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        entry.isFile() &&
        EXAMPLE_FILE.test(entry.name) &&
        directory.split(sep).at(-1) === 'examples'
      ) {
        found.push(path);
      }
    }
  };
  walk(sourceDirectory);
  return found.toSorted((left, right) => left.localeCompare(right));
}
