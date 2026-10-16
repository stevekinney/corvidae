import { join } from 'node:path';

import { createBunProcessFactory, type SocketData } from '@lostgradient/ventriloquist/websocket';

import { createApplication } from './application.ts';
import { ConfigurationError, parseConfiguration } from './configuration.ts';

/** `bun run build` writes here; the server serves it. */
const BUILD_DIRECTORY = join(import.meta.dirname, '..', '..', 'build');

/**
 * Start the example. A refusal the person can act on (a non-loopback hostname, a missing build)
 * prints its message and sets a nonzero exit code; `process.exitCode` rather than `process.exit`
 * lets the message flush before the process ends.
 */
async function main(): Promise<void> {
  const configuration = parseConfiguration(process.argv.slice(2));
  const application = await createApplication({
    configuration,
    buildDirectory: BUILD_DIRECTORY,
    createProcess: createBunProcessFactory(),
  });
  const server = Bun.serve<SocketData>({
    port: configuration.port,
    hostname: configuration.hostname,
    fetch: (request, listener) => application.fetch(request, listener),
    websocket: application.websocket,
  });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      // Stop taking new sockets, then end every session and wait for its process to be cleaned up.
      // A graceful stop resolves only once every socket has closed, so it is not awaited until the
      // sessions that hold those sockets have been ended.
      const listening = server.stop();
      await application.close();
      await server.stop(true);
      await listening;
    })();
    return stopping;
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      void stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  process.stdout.write(
    `Terminal example listening on ${application.origin}\nIt starts shells on this machine and accepts connections from this machine only. Press Ctrl+C to stop.\n`,
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
