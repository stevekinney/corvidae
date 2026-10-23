/**
 * The development entry (`bun run --filter=@lostgradient/interborough dev`): build the
 * application, start the host on it, and rebuild when the source changes.
 *
 * The host serves `build/` from disk on every request, and a rebuild swaps the whole directory in
 * at once, so a reload after a rebuild gets the new bundle. `bun --watch` restarts this process
 * when the host's own modules change, so the browser build runs in a child process
 * ({@link buildBrowserApplication}): inside the watched process the bundler cannot resolve
 * `@msgpack/msgpack`.
 */

import { unwatchFile, watch, watchFile, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';

import { buildBrowserApplication } from './browser-build.ts';
import { startHost } from './host.ts';
import { createRebuildScheduler } from './rebuild-scheduler.ts';

const packageRoot = join(import.meta.dir, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');

const ENTRY_PAGE = join(packageRoot, 'index.html');

/** The sources a browser rebuild depends on: this application's, Cinder's, and Markdown's. */
const WATCHED_DIRECTORIES = [
  join(packageRoot, 'src'),
  join(repositoryRoot, 'components', 'cinder', 'src'),
  join(repositoryRoot, 'packages', 'markdown', 'src'),
];

/** Wait this long after the last change before rebuilding, so one save is one build. */
const REBUILD_DELAY_MILLISECONDS = 100;

await buildBrowserApplication();
const host = await startHost();
console.info(`Interborough is listening on ${host.url}`);
console.info(`Its state lives in ${dirname(host.databasePath)}`);

const rebuilds = createRebuildScheduler({
  build: () => buildBrowserApplication(),
  delayMilliseconds: REBUILD_DELAY_MILLISECONDS,
  onRebuilt: () => console.info('Rebuilt the browser application.'),
  onFailure: (error) => console.error('The browser rebuild failed.', error),
});

const watchers = WATCHED_DIRECTORIES.map((path) =>
  watch(path, { recursive: true }, () => rebuilds.schedule()),
);

// An editor's atomic save replaces `index.html`, which a directory-less file watch can miss on
// macOS, so the entry page is polled by its modification time and inode instead.
const entryChanged = (current: Stats, previous: Stats): void => {
  if (current.mtimeMs !== previous.mtimeMs || current.ino !== previous.ino) rebuilds.schedule();
};
watchFile(ENTRY_PAGE, { interval: 100 }, entryChanged);

async function shutDown(): Promise<void> {
  rebuilds.close();
  unwatchFile(ENTRY_PAGE, entryChanged);
  for (const watcher of watchers) watcher.close();
  await host.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutDown());
process.on('SIGTERM', () => void shutDown());
