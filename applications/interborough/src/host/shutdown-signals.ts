/** A process-like target that accepts the two host shutdown signals. */
export type ShutdownSignalTarget = {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

/** Install one-shot SIGINT/SIGTERM forwarding for a host shutdown callback. */
export function installShutdownSignals(
  target: ShutdownSignalTarget,
  shutDown: () => void | Promise<void>,
): void {
  let shuttingDown = false;
  const onSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutDown();
  };
  target.on('SIGINT', onSignal);
  target.on('SIGTERM', onSignal);
}
