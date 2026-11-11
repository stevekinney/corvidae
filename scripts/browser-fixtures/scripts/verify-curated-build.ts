import { buildBrowser } from '@lostgradient/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runPooledBunTest } from '../../bun-test-pool.ts';
import { environmentConfiguration } from '../environment-configuration.ts';

const fixtureDirectory = resolve(import.meta.dirname, '../fixtures/curated-highlighter');
for (const development of [true, false]) {
  const outputDirectory = await mkdtemp(
    join(environmentConfiguration().tmpdir ?? '/tmp', 'corvidae-curated-highlighter-'),
  );
  try {
    await buildBrowser({
      entrypoints: [resolve(fixtureDirectory, 'index.html')],
      outdir: outputDirectory,
      development,
    });
    const verification = await runPooledBunTest({
      bunTestArguments: [resolve(fixtureDirectory, 'artifacts.test.ts')],
      environment: { ...process.env, CURATED_HIGHLIGHTER_OUTPUT_DIRECTORY: outputDirectory },
    });
    if (verification !== 0)
      throw new Error(`Curated fixture verification failed (development: ${development}).`);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}
