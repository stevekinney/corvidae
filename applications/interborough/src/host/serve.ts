/**
 * The production entry (`bun run --filter=@lostgradient/interborough start`, through
 * `supervisor.ts`): start the host on the existing `build/` and serve it. It builds nothing and
 * watches nothing; `bun run build` makes `build/`, and a restart (`POST /host/restart`) starts this
 * process again under the supervisor.
 *
 * The host runs with `development: false`, so it serves neither the reload stream nor the client
 * that listens to it.
 */

import { dirname } from 'node:path';

import { processEnvironment, resolveBuildDirectory } from './environment-configuration.ts';
import { startHost } from './host.ts';
import { RESTART_EXIT_CODE } from './restart.ts';
import { installShutdownSignals } from './shutdown-signals.ts';

const environment = processEnvironment();

/** Stop the host, then exit with `code`. A host that did not stop cleanly exits 1, which ends the supervisor. */
async function stop(code: number): Promise<never> {
  try {
    await host.close();
  } catch (error) {
    console.error('The host did not stop cleanly.', error);
    process.exit(1);
  }
  process.exit(code);
}

const host = await startHost({
  environment,
  buildDirectory: resolveBuildDirectory(environment),
  development: false,
  onRestartRequested: () => stop(RESTART_EXIT_CODE),
});
console.info(`Interborough is listening on ${host.url}`);
console.info(
  `Its state lives in ${
    host.database.kind === 'sqlite'
      ? dirname(host.database.path)
      : 'the configured Postgres database'
  }`,
);

installShutdownSignals(process, () => stop(0));
