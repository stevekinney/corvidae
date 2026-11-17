#!/usr/bin/env bun
/**
 * Type-checks the files `check-operation-layer-boundary.ts --list` prints under the repository's
 * browser TypeScript configuration (`internal/typescript/browser.json`): no Bun types, no Node
 * types, and the DOM library. It catches a Bun or Node global (`Buffer`, `process`, a Node timer
 * type) that an import walk cannot see, and so keeps the operation layer's files able to move to a
 * runtime-free package unchanged.
 *
 * The configuration lists exactly the reachable files, so it never drifts from the boundary check.
 * It is written under `node_modules/.cache` and removed after the check.
 */

import { write } from 'bun';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { analyzeBoundary, ENTRY_FILES } from './check-operation-layer-boundary.ts';

const packageRoot = resolve(import.meta.dir, '..');
const cacheDirectory = join(packageRoot, 'node_modules', '.cache', 'operation-layer');
const configurationPath = join(cacheDirectory, 'tsconfig.json');

const report = await analyzeBoundary({ root: packageRoot, entries: ENTRY_FILES });
await mkdir(cacheDirectory, { recursive: true });
await write(
  configurationPath,
  JSON.stringify({
    extends: '@lostgradient/typescript/browser.json',
    compilerOptions: { noEmit: true, composite: false, incremental: false, rootDir: packageRoot },
    files: report.reachable.map((path) => join(packageRoot, path)),
    exclude: [],
  }),
);

const child = Bun.spawn([process.execPath, 'x', 'tsc', '-p', configurationPath], {
  cwd: packageRoot,
  stdout: 'inherit',
  stderr: 'inherit',
});
const exitCode = await child.exited;
await rm(cacheDirectory, { recursive: true, force: true });
if (exitCode !== 0) {
  console.error(
    `typecheck-operation-layer: ${report.reachable.length} files do not type-check under internal/typescript/browser.json`,
  );
}
process.exit(exitCode);
