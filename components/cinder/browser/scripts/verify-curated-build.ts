/**
 * `bun browser/scripts/verify-curated-build.ts` (in Cinder's core): builds the curated
 * highlighter fixture, in development and production, and runs its browser check against each
 * build. It was the last step of the root suite's `test:browser-fixtures` until COR-2092.
 */
import { buildBrowser } from '@lostgradient/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixtureDirectory = resolve(import.meta.dirname, '..', 'curated-highlighter');
const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..', '..');

for (const development of [true, false]) {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'corvidae-curated-highlighter-'));
  try {
    await buildBrowser({
      entrypoints: [resolve(fixtureDirectory, 'index.html')],
      outdir: outputDirectory,
      development,
    });
    // Through the repository's test runner, which passes the hang guard and takes a test slot.
    const verification = Bun.spawn(
      [
        process.execPath,
        resolve(repositoryRoot, 'scripts', 'bun-test.ts'),
        resolve(fixtureDirectory, 'artifacts.test.ts'),
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, CURATED_HIGHLIGHTER_OUTPUT_DIRECTORY: outputDirectory },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    if ((await verification.exited) !== 0) {
      throw new Error(`Curated fixture verification failed (development: ${development}).`);
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}
