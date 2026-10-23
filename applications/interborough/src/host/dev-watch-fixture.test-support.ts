/**
 * Run under `bun --watch` by `dev-watch.slow.test.ts`: load the host the way `dev.ts` does, build
 * the browser application the way `dev.ts` does, into the directory named by the first argument,
 * and exit. A build that fails exits nonzero with the bundler's errors on standard error.
 */
import { buildBrowserApplication } from './browser-build.ts';
// Loading the host's modules first is what makes an in-process `Bun.build` fail under `--watch`.
import * as host from './host.ts';

if (typeof host.startHost !== 'function') throw new Error('The host module did not load.');

const outdir = process.argv[2];
if (outdir === undefined) throw new Error('The fixture needs an output directory.');

try {
  await buildBrowserApplication({ outdir });
  console.info('BUILD OK');
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
