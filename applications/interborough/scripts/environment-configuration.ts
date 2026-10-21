/**
 * The one place the application's scripts read the process environment: whether the run is on a
 * continuous-integration host, which `playwright.config.ts` uses to pick its reporter and to
 * decide whether to reuse a server that is already running, and the port the end-to-end suite's
 * host listens on.
 */
export function isContinuousIntegration(): boolean {
  return Boolean(process.env['CI']);
}

/**
 * The port the end-to-end host listens on, and the three after it: one for the barrier's control,
 * one for the host whose console runs on the Bureau's own engine, and one for the journey's host. It
 * is fixed (7399) because the config, the server, and the specs must agree on it, but a checkout that
 * runs the suite beside another can set `INTERBOROUGH_E2E_PORT` for all four at once. A value
 * that is not a port is refused rather than replaced.
 */
export function endToEndPort(): number {
  const raw = process.env['INTERBOROUGH_E2E_PORT'];
  if (raw === undefined || raw === '') return 7399;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65532) {
    throw new Error(`INTERBOROUGH_E2E_PORT must be a port number below 65533, not "${raw}".`);
  }
  return port;
}
