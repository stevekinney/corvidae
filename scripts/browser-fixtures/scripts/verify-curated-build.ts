import { buildBrowser } from '@lostgradient/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TEST_TIMEOUT_ARGUMENT } from '../../test-deadlines.ts';
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
    const verification = Bun.spawn(
      ['bun', 'test', TEST_TIMEOUT_ARGUMENT, resolve(fixtureDirectory, 'artifacts.test.ts')],
      {
        env: { ...process.env, CURATED_HIGHLIGHTER_OUTPUT_DIRECTORY: outputDirectory },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    if ((await verification.exited) !== 0)
      throw new Error(`Curated fixture verification failed (development: ${development}).`);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}
