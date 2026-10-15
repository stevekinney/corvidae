/**
 * Turns SIGINT and SIGTERM into one orderly shutdown of a long-lived process.
 *
 * The first signal starts `shutdown`, which closes admission, settles in-flight
 * work under the host's policy, and resolves `true` only once every owner has
 * acknowledged its cleanup. The process then exits 0, or 1 when cleanup is not
 * acknowledged. A second signal during that wait exits at once with 130 (SIGINT)
 * or 143 (SIGTERM); durable work stays in the store for the next process.
 */
export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface ShutdownSignalOptions {
  readonly shutdown: (signal: ShutdownSignal) => Promise<boolean>;
}

export const EXIT_CODES = { settled: 0, unresolved: 1, SIGINT: 130, SIGTERM: 143 } as const;

export function handleShutdownSignals(options: ShutdownSignalOptions): void {
  let shuttingDown = false;
  const onSignal = (signal: ShutdownSignal): void => {
    if (shuttingDown) process.exit(EXIT_CODES[signal]);
    shuttingDown = true;
    options.shutdown(signal).then(
      (settled) => process.exit(settled ? EXIT_CODES.settled : EXIT_CODES.unresolved),
      () => process.exit(EXIT_CODES.unresolved),
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
