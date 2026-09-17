import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = resolve(import.meta.dirname, '../fixtures/curated-highlighter');
const viteExecutable = fileURLToPath(
  new URL('./bin/vite.js', import.meta.resolve('vite/package.json')),
);
const outputDirectory = await mkdtemp(join(tmpdir(), 'corvidae-curated-highlighter-'));

try {
  const build = Bun.spawn(
    [
      process.execPath,
      viteExecutable,
      'build',
      fixtureDirectory,
      '--config',
      resolve(fixtureDirectory, 'vite.config.ts'),
      '--outDir',
      outputDirectory,
      '--emptyOutDir',
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  const buildExitCode = await build.exited;
  if (buildExitCode !== 0) throw new Error(`Curated fixture build failed (${buildExitCode}).`);

  const verification = Bun.spawn(
    [process.execPath, 'test', resolve(fixtureDirectory, 'artifacts.test.ts')],
    {
      env: { ...process.env, CURATED_HIGHLIGHTER_OUTPUT_DIRECTORY: outputDirectory },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const verificationExitCode = await verification.exited;
  if (verificationExitCode !== 0) {
    throw new Error(`Curated fixture artifact verification failed (${verificationExitCode}).`);
  }
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
