/**
 * The development entry (`bun run --filter=@lostgradient/interborough dev`): build the
 * application, start the host on it, and rebuild when the source changes.
 *
 * The host serves `build/` from disk on every request, and a rebuild swaps the whole directory in
 * at once, so a reload after a rebuild gets the new bundle. `bun --watch` restarts this process
 * when the host's own modules change, so the browser build runs in a child process
 * ({@link buildBrowserApplication}): inside the watched process the bundler cannot resolve
 * `@msgpack/msgpack`.
 *
 * The host runs with `development: true`, so every open page reloads itself after a successful
 * rebuild (`dev-reload.ts`).
 */

import { unwatchFile, watchFile, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';

import { buildBrowserApplication, stopBrowserBuilds } from './browser-build.ts';
import { startHost } from './host.ts';
import { createRebuildScheduler } from './rebuild-scheduler.ts';
import { installShutdownSignals } from './shutdown-signals.ts';
import { createSourceWatcher } from './source-watcher.ts';

const packageRoot = join(import.meta.dir, '..', '..');

const ENTRY_PAGE = join(packageRoot, 'index.html');

/**
 * Where each build records the files it read. The directories a rebuild depends on come from it
 * (`source-watcher.ts`), so a workspace the bundle starts importing is watched after the build
 * that imports it. The file is ignored by Git.
 */
const BUILD_INPUTS_FILE = join(packageRoot, '.dev-build-inputs.json');

/** Wait this long after the last change before rebuilding, so one save is one build. */
const REBUILD_DELAY_MILLISECONDS = 100;

const buildOptions = { inputsFile: BUILD_INPUTS_FILE };

await buildBrowserApplication(buildOptions);
const host = await startHost({ development: true });
console.info(`Interborough is listening on ${host.url}`);
console.info(
  `Its state lives in ${
    host.database.kind === 'sqlite'
      ? dirname(host.database.path)
      : 'the configured Postgres database'
  }`,
);

// The entry page is watched by its own poll below, so its input is not watched as a directory.
const sources = createSourceWatcher({
  inputsFile: BUILD_INPUTS_FILE,
  fallbackDirectory: join(packageRoot, 'src'),
  ignore: [ENTRY_PAGE],
  onChange: () => rebuilds.schedule(),
});

const rebuilds = createRebuildScheduler({
  // The next build may import a workspace this one did not, so the watch follows each build.
  build: async () => {
    await buildBrowserApplication(buildOptions);
    await sources.refresh();
  },
  delayMilliseconds: REBUILD_DELAY_MILLISECONDS,
  onRebuilt: () => {
    console.info('Rebuilt the browser application.');
    host.notifyRebuilt();
  },
  onFailure: (error) => console.error('The browser rebuild failed.', error),
});

await sources.refresh();

// An editor's atomic save replaces `index.html`, which a directory-less file watch can miss on
// macOS, so the entry page is polled by its modification time and inode instead.
const entryChanged = (current: Stats, previous: Stats): void => {
  if (current.mtimeMs !== previous.mtimeMs || current.ino !== previous.ino) rebuilds.schedule();
};
watchFile(ENTRY_PAGE, { interval: 100 }, entryChanged);

async function shutDown(): Promise<void> {
  rebuilds.close();
  // A build still running would write `build/` after this process has gone.
  await stopBrowserBuilds();
  unwatchFile(ENTRY_PAGE, entryChanged);
  sources.close();
  await host.close();
  process.exit(0);
}

installShutdownSignals(process, shutDown);
