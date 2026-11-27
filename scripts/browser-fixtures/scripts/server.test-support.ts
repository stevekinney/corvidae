import { createFixtureServer } from '@lostgradient/testing/browser/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A development fixture host over one static asset, whose rebuild the test controls. */
export async function developmentHost(waitForBuild: () => Promise<void>) {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'corvidae-rebuild-fixtures-'));
  await Bun.write(join(outputDirectory, 'fixture.css'), '.fixture { color: red; }');
  // The asset route never reads the manifest.
  const server = createFixtureServer({
    outputDirectory,
    manifestPath: join(outputDirectory, 'manifest.json'),
    port: 0,
    development: true,
    waitForBuild,
  });
  return {
    request: () => fetch(new URL('/fixture.css', server.url)),
    async close() {
      await server.stop(true);
      await rm(outputDirectory, { recursive: true, force: true });
    },
  };
}

/** A build the test settles by hand. */
export function controlledBuild() {
  let release = () => {};
  let fail = (_error: Error) => {};
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}
