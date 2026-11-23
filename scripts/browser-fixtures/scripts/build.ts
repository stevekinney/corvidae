import { resolve } from 'node:path';

import {
  buildFixtures as buildSuiteFixtures,
  type FixtureBuild,
} from '@lostgradient/testing/browser/build';
import { ensureCinderGenerated } from '../../ensure-cinder-generated.ts';
import { defaultManifestLayout } from './prepare-manifest.ts';

const root = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(root, 'build');

/** The root suite's build: its page, its manifest layout, and `build/`. */
const rootFixtureBuild: FixtureBuild = {
  layout: defaultManifestLayout,
  indexHtml: resolve(root, 'index.html'),
  outputDirectory,
};

export async function buildFixtures(development = false): Promise<void> {
  ensureCinderGenerated();
  await buildSuiteFixtures(rootFixtureBuild, development);
}

if (import.meta.main) {
  await buildFixtures(false);
  console.log(`built browser fixtures at ${outputDirectory}`);
}
