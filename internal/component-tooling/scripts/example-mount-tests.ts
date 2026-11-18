/**
 * Gives every component workspace that holds examples the one test that mounts them (COR-2081).
 *
 * ```sh
 * bun internal/component-tooling/scripts/example-mount-tests.ts            # write what is missing
 * bun internal/component-tooling/scripts/example-mount-tests.ts --dry-run  # print the plan
 * ```
 *
 * For each `components/<name>` workspace with a `*.example.svelte` file in an `examples/`
 * directory under its `src`, it writes {@link EXAMPLE_MOUNT_TEST_FILE} (which calls
 * `mountEveryExample` from `@lostgradient/component-tooling/test/example-mounts.ts`) when the file
 * is missing, and adds the component tooling to the workspace's development dependencies when it
 * is not a dependency already. A workspace without examples is left alone, and a second run
 * changes nothing. `create-package.ts` writes the same file into every package it scaffolds, and
 * `extract-families.ts` and the playground's examples move call {@link ensureExampleMountTests}, so
 * no package needs a hand-written copy.
 *
 * The file carries the extraction's generated marker, so the family map does not count the copies
 * in core and in each family as one file in two places.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { exampleFiles } from './lib/example-files.ts';
import { GENERATED_MARKER } from './split-layout.ts';

/** The test file, relative to a package directory. */
export const EXAMPLE_MOUNT_TEST_FILE = 'src/examples.test.ts';

/** The text of {@link EXAMPLE_MOUNT_TEST_FILE}. */
export const EXAMPLE_MOUNT_TEST_SOURCE = `// ${GENERATED_MARKER} (and create-package.ts): every example in this package mounts (COR-2081).
import { mountEveryExample } from '@lostgradient/component-tooling/test/example-mounts.ts';

mountEveryExample(import.meta.dir);
`;

const TOOLING_PACKAGE = '@lostgradient/component-tooling';

type Manifest = Record<string, unknown> & {
  name?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * Add the component tooling to `manifest`'s development dependencies unless it is a dependency
 * already; the existing keys keep their order and the name goes before the first that sorts after
 * it. Returns whether it changed anything.
 */
export function addToolingDependency(manifest: Manifest): boolean {
  if (manifest.dependencies?.[TOOLING_PACKAGE] !== undefined) return false;
  if (manifest.devDependencies?.[TOOLING_PACKAGE] !== undefined) return false;
  const entries = Object.entries(manifest.devDependencies ?? {});
  const index = entries.findIndex(([name]) => name.localeCompare(TOOLING_PACKAGE) > 0);
  entries.splice(index === -1 ? entries.length : index, 0, [TOOLING_PACKAGE, 'workspace:*']);
  manifest.devDependencies = Object.fromEntries(entries);
  return true;
}

/** Write each missing example-mount test under `root`; return what it wrote or would write. */
export function ensureExampleMountTests(root: string, dryRun = false): string[] {
  const log: string[] = [];
  const componentsDirectory = join(root, 'components');
  if (!existsSync(componentsDirectory)) return log;
  const entries = readdirSync(componentsDirectory, { withFileTypes: true }).toSorted(
    (left, right) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(componentsDirectory, entry.name);
    const manifestPath = join(directory, 'package.json');
    const source = join(directory, 'src');
    if (!existsSync(manifestPath) || !existsSync(source)) continue;
    if (exampleFiles(source).length === 0) continue;
    const test = join(directory, EXAMPLE_MOUNT_TEST_FILE);
    if (!existsSync(test)) {
      log.push(`write components/${entry.name}/${EXAMPLE_MOUNT_TEST_FILE}`);
      if (!dryRun) {
        mkdirSync(dirname(test), { recursive: true });
        writeFileSync(test, EXAMPLE_MOUNT_TEST_SOURCE);
      }
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    if (addToolingDependency(manifest)) {
      log.push(`depend components/${entry.name} -> ${TOOLING_PACKAGE}`);
      if (!dryRun) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
  return log;
}

/** The repository paths {@link ensureExampleMountTests}'s log says it wrote. */
export function writtenPaths(log: readonly string[]): string[] {
  return log.map((line) =>
    line.startsWith('write ')
      ? line.slice('write '.length)
      : `${line.slice('depend '.length).split(' -> ')[0]}/package.json`,
  );
}

if (import.meta.main) {
  const log = ensureExampleMountTests(
    resolve(import.meta.dir, '../../..'),
    process.argv.includes('--dry-run'),
  );
  process.stdout.write(log.length === 0 ? 'Nothing to write.\n' : `${log.join('\n')}\n`);
  if (log.some((line) => line.startsWith('depend '))) {
    process.stdout.write(
      'A manifest gained a dependency: run `bun install` and commit bun.lock.\n',
    );
  }
}
