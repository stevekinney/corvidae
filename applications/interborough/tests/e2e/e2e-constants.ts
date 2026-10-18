/**
 * Shared constants for the Playwright/axe E2E harness (plan §11.4). Kept in one file so
 * `e2e-server.ts` (the process `playwright.config.ts`'s `webServer` runs) and the config itself
 * never drift on the port a test run depends on.
 *
 * The suite runs against the real host (`src/host/host.ts`) with the console's fixtures registered
 * on its engine: one process serves the built application, the engine API, and a Bureau, on one
 * loopback origin, and every request acts as `anonymous:local`, so the suite needs no credential.
 */

/** Fixed port the E2E host listens on. Distinct from the interactive host's default of 7234. */
export const E2E_PORT = 7399;

export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/** `deploymentName` the E2E `RemoteWorker` registers under (flow (e), drain-a-deployment). */
export const E2E_DEPLOYMENT_NAME = 'checkout-worker-fleet';

/** Durable operation seeded through the real remote-worker protocol for the WFC-18 ledger flow. */
export const E2E_TASK_OPERATION_ID = 'e2e-ledger-delayed-charge';

/**
 * COR-124 attempt, lease, and cancellation evidence. A second real
 * `RemoteWorker` registers under its own deployment and queue so the hanging
 * activities it runs never touch `E2E_DEPLOYMENT_NAME`
 * (`04-drain-deployment.spec.ts` drains that deployment and relies on it
 * having no in-flight work).
 */
export const E2E_LEDGER_DEPLOYMENT_NAME = 'ledger-evidence-fleet';
export const E2E_LEDGER_QUEUE = 'ledger-evidence';
export const E2E_LEDGER_WORKER_ID = 'ledger-evidence-worker-1';

/** Leased task on its second attempt: attempt 1 failed and was retried; attempt 2 holds the lease and has heartbeated. */
export const E2E_LEASED_TASK_OPERATION_ID = 'e2e-ledger-leased-retry';

/**
 * Leased task whose cancellation is durably requested but never acknowledged:
 * its activity ignores the abort signal. The E2E server raises
 * `cancellationGracePeriodMs` to Weft's documented maximum (five minutes) so
 * this stays `cancelling` for the suite instead of being force-settled after
 * the 30-second default.
 */
export const E2E_CANCELLING_TASK_OPERATION_ID = 'e2e-ledger-cancel-requested';

/** Task whose cancellation the owning attempt acknowledged with a cancelled result. */
export const E2E_CANCELLED_TASK_OPERATION_ID = 'e2e-ledger-cancel-acknowledged';

export const E2E_CANCELLATION_REASON = 'operator stopped the e2e ledger run';

/** Weft's maximum cancellation grace period (`serve-internals.ts`). */
export const E2E_CANCELLATION_GRACE_PERIOD_MS = 300_000;
