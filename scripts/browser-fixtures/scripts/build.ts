import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildBrowser } from '@lostgradient/testing';
import { prepareManifest } from './prepare-manifest.ts';

const root = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(root, 'build');
const manifestPath = resolve(root, '.playwright', 'manifest.json');

export async function buildFixtures(development = false): Promise<void> {
  await prepareManifest();
  // Retain hashed assets while developing so a page loaded before a rebuild can finish loading.
  if (!development) await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await buildBrowser({
    entrypoints: [resolve(root, 'index.html')],
    outdir: outputDirectory,
    development,
  });
  await mkdir(resolve(outputDirectory, '.playwright'), { recursive: true });
  await Bun.write(resolve(outputDirectory, '.playwright', 'manifest.json'), Bun.file(manifestPath));
}

if (import.meta.main) {
  await buildFixtures(false);
  console.log(`built browser fixtures at ${outputDirectory}`);
}
