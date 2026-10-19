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

/**
 * COR-281: a task that crossed a build boundary and then a retry storm. Three
 * workers on the previous build (`E2E_PREVIOUS_BUILD_ID`) claim it and
 * disappear, and a fourth on the current ledger build holds attempt 4. It runs
 * on its own queue so the three ledger tasks above keep their two-attempt
 * histories, and the retry storm (three requeues) makes it a Diagnostics item
 * that names its current worker.
 */
export const E2E_CROSS_BUILD_TASK_OPERATION_ID = 'e2e-ledger-cross-build-storm';
export const E2E_CROSS_BUILD_QUEUE = 'provenance-evidence';
export const E2E_CROSS_BUILD_WORKER_ID = 'provenance-evidence-worker-1';
export const E2E_PREVIOUS_BUILD_ID = 'e2e-ledger-build-0';
export const E2E_CURRENT_BUILD_ID = 'e2e-ledger-build-1';

/** Reconnect grace period the E2E host uses, short so the seeded requeues take a fraction of a second. */
export const E2E_RECONNECT_GRACE_PERIOD_MS = 250;

/**
 * COR-160: a real HTTP long-poll worker registered on its own deployment and
 * queue. It advertises no workflow, so it never claims work and never joins a
 * workflow's contract verification; it exists to give the Workers surfaces a
 * long-poll session to read.
 */
export const E2E_LONG_POLL_DEPLOYMENT_NAME = 'long-poll-fleet';
export const E2E_LONG_POLL_QUEUE = 'long-poll-evidence';
export const E2E_LONG_POLL_BUILD_ID = 'e2e-long-poll-build-1';

export const E2E_CANCELLATION_REASON = 'operator stopped the e2e ledger run';

/** Weft's maximum cancellation grace period (`serve-internals.ts`). */
export const E2E_CANCELLATION_GRACE_PERIOD_MS = 300_000;

/**
 * COR-164: worker versioning. Two real builds of one deployment register through the worker
 * protocol, routing is set on the first, and two workflow types start and finish against it: one
 * pinned, one auto-upgrade. The auto-upgrade policy names the first build's exact digests, which
 * `versioned-run-seed.ts` reads back from the server's catalog after the workers register.
 */
export const E2E_VERSIONED_DEPLOYMENT_NAME = 'versioned-order-fleet';
export const E2E_VERSIONED_FIRST_BUILD_ID = 'e2e-versioned-build-1';
export const E2E_VERSIONED_SECOND_BUILD_ID = 'e2e-versioned-build-2';
export const E2E_PINNED_WORKFLOW_TYPE = 'e2e-pinned-order';
export const E2E_AUTO_UPGRADE_WORKFLOW_TYPE = 'e2e-auto-upgrade-order';
export const E2E_PINNED_RUN_ID = 'e2e-versioned-pinned-run';
export const E2E_AUTO_UPGRADE_RUN_ID = 'e2e-versioned-auto-upgrade-run';
