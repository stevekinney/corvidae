/**
 * The development entry (`bun run --filter=@lostgradient/interborough dev`): build the
 * application, start the host on it, and rebuild when the source changes.
 *
 * The host serves `build/` from disk on every request, and a rebuild swaps the whole directory in
 * at once, so a reload after a rebuild gets the new bundle. `bun --watch` restarts this process
 * when the host's own modules change.
 */

import { watch } from 'node:fs';
import { dirname, join } from 'node:path';

import { buildApplication } from '../../scripts/build.ts';
import { startHost } from './host.ts';

const packageRoot = join(import.meta.dir, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');

/** The sources a browser rebuild depends on: this application's, Cinder's, and Markdown's. */
const WATCHED_PATHS = [
  join(packageRoot, 'src'),
  join(packageRoot, 'index.html'),
  join(repositoryRoot, 'components', 'cinder', 'src'),
  join(repositoryRoot, 'packages', 'markdown', 'src'),
];

/** Wait this long after the last change before rebuilding, so one save is one build. */
const REBUILD_DELAY_MILLISECONDS = 100;

await buildApplication({ development: true });
const host = await startHost();
console.info(`Interborough is listening on ${host.url}`);
console.info(`Its state lives in ${dirname(host.databasePath)}`);

let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRebuild(): void {
  if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = undefined;
    buildApplication({ development: true }).then(
      () => console.info('Rebuilt the browser application.'),
      (error: unknown) => console.error('The browser rebuild failed.', error),
    );
  }, REBUILD_DELAY_MILLISECONDS);
}

const watchers = WATCHED_PATHS.map((path) => watch(path, { recursive: true }, scheduleRebuild));

async function shutDown(): Promise<void> {
  if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
  for (const watcher of watchers) watcher.close();
  await host.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutDown());
process.on('SIGTERM', () => void shutDown());
