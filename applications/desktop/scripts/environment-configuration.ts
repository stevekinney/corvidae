/**
 * The one place the desktop build reads its process environment.
 *
 * `electrobun.config.ts` runs inside Cottontail, so this module stays plain
 * TypeScript with no imports: nothing else may join the graph Cottontail loads
 * for the config (COR-1389). It is registered in
 * `scripts/environment-configuration-policy.ts`.
 */

/** Whether `build` and `build:stable` pre-bundled the main process for this run. */
export function prebundledMainRequested(): boolean {
  return process.env['DESKTOP_PREBUNDLED_MAIN'] === '1';
}
