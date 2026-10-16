import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildBrowser } from '@lostgradient/testing';

const root = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(root, 'build');

/**
 * Bundle the Svelte client with Bun (no Vite) through the shared `buildBrowser` helper, which owns
 * the Svelte plugin and the WebAssembly handling. The HTML entry names the script and Bun rewrites
 * it to the hashed files it writes beside it.
 */
export async function buildClient(development: boolean): Promise<void> {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await buildBrowser({
    entrypoints: [resolve(root, 'src', 'client', 'index.html')],
    outdir: outputDirectory,
    development,
  });
}

if (import.meta.main) {
  const development = process.argv.includes('--development');
  await buildClient(development);
  process.stdout.write(`Built the terminal example at ${outputDirectory}\n`);
}
