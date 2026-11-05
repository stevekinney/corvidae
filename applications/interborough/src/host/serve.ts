/**
 * The production entry (`bun run --filter=@lostgradient/interborough start`, through
 * `supervisor.ts`): start the host on the existing `build/` and serve it. It builds nothing and
 * watches nothing; `bun run build` makes `build/`, and a restart (`POST /host/restart`) starts this
 * process again under the supervisor.
 *
 * The host runs with `development: false`, so it serves neither the reload stream nor the client
 * that listens to it.
 */

import type { BungalowEnvironment } from '@lostgradient/bungalow';
import { dirname } from 'node:path';

import { processEnvironment, resolveBuildDirectory } from './environment-configuration.ts';
import { startHost } from './host.ts';
import { RESTART_EXIT_CODE } from './restart.ts';
import { installShutdownSignals } from './shutdown-signals.ts';

/** Run the foreground production host with the caller's resolved build directory. */
export async function serveHost(
  environment: BungalowEnvironment,
  buildDirectory: string,
): Promise<void> {
  /** Stop the host, then exit with `code`. A host that did not stop cleanly exits 1, which ends the supervisor. */
  async function stop(code: number): Promise<never> {
    try {
      const host = await starting;
      await host.close();
    } catch (error) {
      console.error('The host did not stop cleanly.', error);
      process.exit(1);
    }
    process.exit(code);
  }

  // The restart route can receive a request before startHost returns.
  const starting = startHost({
    environment,
    buildDirectory,
    development: false,
    onRestartRequested: () => stop(RESTART_EXIT_CODE),
  });
  const host = await starting;
  // URL normalizes away HTTP’s default port, but the startup line always names the bound port.
  console.info(
    `Interborough is listening on ${host.url.protocol}//${host.url.hostname}:${host.url.port || 80}`,
  );
  console.info(
    `Its state lives in ${
      host.database.kind === 'sqlite'
        ? dirname(host.database.path)
        : 'the configured Postgres database'
    }`,
  );

  installShutdownSignals(process, () => stop(0));
}

if (import.meta.main) {
  const environment = processEnvironment();
  await serveHost(environment, resolveBuildDirectory(environment));
}
