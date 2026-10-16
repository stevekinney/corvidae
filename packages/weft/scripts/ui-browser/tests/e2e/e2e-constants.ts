/**
 * Shared constants for the Playwright/axe E2E harness (plan §11.4). Kept in
 * one file so `e2e-server.ts` (the bootstrap `playwright.config.ts`'s
 * `webServer` spawns) and the Playwright config itself never drift on the
 * port or credential a test run depends on.
 *
 * **Why a dedicated server, not `scripts/dev-server.ts`.** The interactive
 * dev harness deliberately boots with no `auth` configured
 * (`unauthenticatedAccess: 'warn'`) so a human operator sees the real
 * anonymous-degrade UX. `weft.reviews.list`, `weft.schedules.list`,
 * `weft.workers.list`, and every `weft.workflows.bulk.*` operation declare
 * `access: { kind: 'scoped' | 'authenticated' }` (verified against
 * `weft/src/server/operations/{list-reviews,list-schedules,list-workers,
 * bulk-filter-helpers}.ts`), and `serve()`'s authenticator only runs at all
 * when `auth` is configured (`weft/src/server/runtime/request-gate.ts`) — so
 * an unauthenticated request against those operations always 401s
 * regardless of `unauthenticatedAccess`. Three of this suite's five persona
 * flows (approve-a-review, bulk-retry, drain-a-deployment) need those
 * surfaces, so E2E needs its own server with `auth` configured and a
 * full-scope key — a separate process from the shared dev harness, not a
 * shared-file edit to it.
 */

/** Fixed port for the E2E-only weft server (`e2e-server.ts`). Distinct from the interactive dev harness's 7233. */
export const E2E_SERVER_PORT = 7399;

/** Fixed port the Bun browser host serves for E2E runs. */
export const E2E_CONSOLE_PORT = 5183;

export const E2E_BASE_URL = `http://localhost:${E2E_CONSOLE_PORT}`;

/**
 * Static API key admitted by the E2E server's `auth.apiKeys`, granted every
 * scope via `auth.defaultApiKeyScopes` (`e2e-server.ts`). Injected into the
 * console's runtime config on every document response by
 * `tests/e2e/auth-fixtures.ts` — never typed through the `<ApiKeyEntry>` UI,
 * never persisted (matches `src/lib/config.ts`'s `token`: "held in memory
 * only").
 */
export const E2E_API_KEY = 'weft-ui-e2e-fixture-key';

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
