/**
 * The one place the application's scripts read the process environment: whether the run is on a
 * continuous-integration host, which `playwright.config.ts` uses to pick its reporter and to
 * decide whether to reuse a server that is already running.
 */
export function isContinuousIntegration(): boolean {
  return Boolean(process.env['CI']);
}
