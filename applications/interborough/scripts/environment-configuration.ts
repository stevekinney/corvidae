/**
 * The one place the application's scripts read the process environment: whether the run is on a
 * continuous-integration host, which `playwright.config.ts` uses to pick its reporter and to
 * decide whether to reuse a server that is already running, the port the end-to-end suite's host
 * listens on, and where and in which color scheme a design-review capture writes its screenshots.
 */
export function isContinuousIntegration(): boolean {
  return Boolean(process.env['CI']);
}

/**
 * The port the end-to-end host listens on, and the six after it: one for the barrier's control,
 * one for the host whose console runs on the Bureau's own engine, one for the journey's host, one
 * for the first-run host, one for the connect host that restarts, and one for the showcase host. It
 * is fixed (7399) because the config, the server, and the specs must agree on it, but a checkout
 * that runs the suite beside another can set `INTERBOROUGH_E2E_PORT` for all seven at once. A value
 * that is not a port is refused rather than replaced.
 */
export function endToEndPort(): number {
  const raw = process.env['INTERBOROUGH_E2E_PORT'];
  if (raw === undefined || raw === '') return 7399;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65530) {
    throw new Error(`INTERBOROUGH_E2E_PORT must be a port number below 65531, not "${raw}".`);
  }
  return port;
}

/** The color schemes a design-review capture can render the application in. */
export type DesignReviewColorScheme = 'light' | 'dark';

/**
 * Where a design-review capture writes its screenshots, or `undefined` when the run is an ordinary
 * test run. `scripts/design-review-capture.ts` sets `INTERBOROUGH_DESIGN_REVIEW_CAPTURE` to an
 * absolute directory, and `tests/e2e/design-review-capture.ts` writes into it only then, so the
 * gated suite never writes a screenshot.
 */
export function designReviewCaptureDirectory(): string | undefined {
  const raw = process.env['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'];
  return raw === undefined || raw === '' ? undefined : raw;
}

/**
 * The color scheme a design-review capture renders in, from
 * `INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME`, or `undefined` to leave Playwright's default (light).
 * A value that is not a scheme is refused rather than replaced.
 */
export function designReviewColorScheme(): DesignReviewColorScheme | undefined {
  const raw = process.env['INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME'];
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'light' || raw === 'dark') return raw;
  throw new Error(`INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME must be light or dark, not "${raw}".`);
}
