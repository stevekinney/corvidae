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
 * `--plugin <path>` (repeatable) loads that folder's `plugin.ts` as a plugin marked
 * `development-source` (COR-1881). Plugin code loads once, so under `bun --watch` an edit to it
 * restarts the host and the new code is what runs.
 *
 * `--showcase` runs the showcase host (`showcase.ts`): a home of its own, the demo plugin and a stub
 * model provider, and believable content seeded over HTTP once the host listens
 * (`fixtures/showcase-seed.ts`).
 *
 * The host runs with `development: true`, so every open page reloads itself after a successful
 * rebuild (`dev-reload.ts`).
 *
 * `bun run dev` starts this entry through the supervisor (`supervisor.ts`), so a restart request
 * (`POST /host/restart`) stops the host and exits with `RESTART_EXIT_CODE`, which `bun --watch`
 * passes up and the supervisor answers by starting it again. `INTERBOROUGH_BUILD_DIRECTORY` moves
 * the build, and the file that records its inputs goes beside it.
 */

import { unwatchFile, watchFile, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';

import { describeShowcase, seedShowcase } from '../../fixtures/showcase-seed.ts';
import { buildBrowserApplication, stopBrowserBuilds } from './browser-build.ts';
import { developmentPluginPaths } from './development-plugin-flag.ts';
import { processEnvironment, resolveBuildDirectory } from './environment-configuration.ts';
import { startHost } from './host.ts';
import { createRebuildScheduler } from './rebuild-scheduler.ts';
import { RESTART_EXIT_CODE } from './restart.ts';
import {
  prepareShowcaseHome,
  showcaseEnvironment,
  showcaseProviderResolver,
  splitShowcaseFlag,
} from './showcase.ts';
import { installShutdownSignals } from './shutdown-signals.ts';
import { createSourceWatcher } from './source-watcher.ts';

const { showcase, rest: pluginArguments } = splitShowcaseFlag(process.argv.slice(2));
const pluginPaths = developmentPluginPaths(pluginArguments);
if (pluginPaths === undefined) {
  console.error('Usage: bun src/host/dev.ts [--showcase] [--plugin <path>]…');
  process.exit(2);
}

const packageRoot = join(import.meta.dir, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');

const ENTRY_PAGE = join(packageRoot, 'index.html');

/**
 * Where each build records the files it read. The directories a rebuild depends on come from it
 * (`source-watcher.ts`), so a workspace the bundle starts importing is watched after the build
 * that imports it. The file is ignored by Git.
 */
const environment = showcase
  ? showcaseEnvironment(processEnvironment(), repositoryRoot)
  : processEnvironment();
const buildDirectory = resolveBuildDirectory(environment);
const BUILD_INPUTS_FILE = join(dirname(buildDirectory), '.dev-build-inputs.json');

/** Wait this long after the last change before rebuilding, so one save is one build. */
const REBUILD_DELAY_MILLISECONDS = 100;

const buildOptions = { outdir: buildDirectory, inputsFile: BUILD_INPUTS_FILE };

await buildBrowserApplication(buildOptions);
if (showcase) await prepareShowcaseHome(environment['INTERBOROUGH_HOME']!);
const host = await startHost({
  environment,
  buildDirectory,
  development: true,
  developmentPlugins: pluginPaths,
  onRestartRequested: () => shutDown(RESTART_EXIT_CODE),
  ...(showcase ? { resolveProviderGenerate: showcaseProviderResolver() } : {}),
});
console.info(`Interborough is listening on ${host.url}`);
console.info(
  `Its state lives in ${
    host.database.kind === 'sqlite'
      ? dirname(host.database.path)
      : 'the configured Postgres database'
  }`,
);

if (showcase) {
  // The demo plugin seeds its schedule and goal in `afterStart`, which `startHost` does not wait for.
  await host.bureau.plugins.ready();
  const seed = await seedShowcase(host.url.origin);
  console.info(`Showcase content: ${describeShowcase(seed)}`);
}

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

let stopping: Promise<never> | undefined;

/**
 * Stop everything this process started, then exit with `code`. The first call decides the code: a
 * signal that arrives while a restart is stopping the host does not turn it into a plain exit. A
 * host that did not stop cleanly exits 1, which ends the supervisor rather than restarting.
 */
function shutDown(code: number): Promise<never> {
  stopping ??= (async (): Promise<never> => {
    try {
      rebuilds.close();
      // A build still running would write `build/` after this process has gone.
      await stopBrowserBuilds();
      unwatchFile(ENTRY_PAGE, entryChanged);
      sources.close();
      await host.close();
    } catch (error) {
      console.error('The host did not stop cleanly.', error);
      process.exit(1);
    }
    process.exit(code);
  })();
  return stopping;
}

installShutdownSignals(process, () => shutDown(0));
