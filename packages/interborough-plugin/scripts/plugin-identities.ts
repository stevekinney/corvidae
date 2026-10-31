/**
 * Prints the identity snapshot of a plugin workspace as JSON: `bun scripts/plugin-identities.ts
 * <workspace directory>`. The repository's `scripts/check-plugin-identities.ts` runs it, because a
 * root script cannot import a workspace, and this script lives where the plugin's own
 * dependencies resolve. The workspace's entry is its `package.json` `exports["."]` (or `main`, or
 * `src/index.ts`), and the plugin is that module's default export.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { pluginIdentities } from '../src/testing/plugin-identities.ts';

interface Manifest {
  readonly exports?: unknown;
  readonly main?: unknown;
}

function entryOf(manifest: Manifest): string {
  const { exports, main } = manifest;
  if (typeof exports === 'string') return exports;
  if (typeof exports === 'object' && exports !== null) {
    const root = Object.entries(exports).find(([key]) => key === '.')?.[1];
    if (typeof root === 'string') return root;
  }
  return typeof main === 'string' ? main : 'src/index.ts';
}

const directory = process.argv[2];
if (directory === undefined) {
  process.stderr.write('Usage: bun plugin-identities.ts <plugin workspace directory>\n');
  process.exitCode = 2;
} else {
  const workspace = resolve(directory);
  const manifestPath = join(workspace, 'package.json');
  const manifest: Manifest = existsSync(manifestPath) ? await Bun.file(manifestPath).json() : {};
  const entry = join(workspace, entryOf(manifest));
  const loaded: { default?: unknown } = await import(pathToFileURL(entry).href);
  const descriptor = loaded.default;
  if (typeof descriptor !== 'object' || descriptor === null || !('name' in descriptor)) {
    process.stderr.write(`${entry} must export a plugin descriptor as its default export.\n`);
    process.exitCode = 1;
  } else {
    // The module is the plugin's own code; its shape is judged by `definePlugin`.
    const identities = await pluginIdentities(descriptor as Parameters<typeof pluginIdentities>[0]);
    process.stdout.write(`${JSON.stringify(identities)}\n`);
  }
}
