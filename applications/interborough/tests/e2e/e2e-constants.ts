/**
 * Shared constants for the Playwright/axe E2E harness (plan §11.4). Kept in one file so
 * `e2e-server.ts` (the process `playwright.config.ts`'s `webServer` runs) and the config itself
 * never drift on the port a test run depends on.
 *
 * The suite runs against the real host (`src/host/host.ts`) with the console's fixtures registered
 * on its engine: one process serves the built application, the engine API, and a Bureau, on one
 * loopback origin, and every request acts as `anonymous:local`, so the suite needs no credential.
 */
import { endToEndPort } from '../../scripts/environment-configuration.ts';

/**
 * Port the E2E host listens on: 7399 unless `INTERBOROUGH_E2E_PORT` says another. Distinct from the
 * interactive host's default of 7234. The suite holds four consecutive ports (this one, the
 * barrier's, the second host's, and the journey's), so two runs on one machine set
 * `INTERBOROUGH_E2E_PORT` at least four apart.
 */
export const E2E_PORT = endToEndPort();

export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * The agent a new chat starts with on the main host when `?agent=` names none: the first agent the
 * Bureau lists that can run. A host's extra agents are listed before a plugin's, so this is the
 * barrier agent (`barrier-agent.ts`), not the demo plugin's `demo:assistant`; a spec that needs the
 * assistant's reply names it with `?agent=demo:assistant`.
 */
export const E2E_DEFAULT_AGENT = 'barrier';

/**
 * Where the test-only barrier control listens, on the port after the host's. The chat specs hold a run on a barrier so no case
 * depends on timing (`barrier-agent.ts`); the host itself serves no such route.
 */
export const E2E_BARRIER_PORT = E2E_PORT + 1;
export const E2E_BARRIER_URL = `http://127.0.0.1:${E2E_BARRIER_PORT}`;

/**
 * The second host the suite runs, on the port after the barrier's. Its console runs on the Bureau's
 * own engine, which is how every real host runs, so the schedules the Bureau holds (an agent run, and
 * the trigger of a workflow file) are listed beside the engine's. The main host gives its console an
 * engine of its own for the fixtures, which cannot see them. The schedules specs open this one.
 */
export const E2E_BUREAU_PORT = E2E_PORT + 2;
export const E2E_BUREAU_URL = `http://127.0.0.1:${E2E_BUREAU_PORT}`;

/**
 * The third host, on the port after the second's, which only the journey (`90-journey.spec.ts`)
 * opens. Its console is also the Bureau's own engine, because the journey follows an agent-authored
 * workflow's schedule fire into the Workflows area, and it has agents and a barrier of its own, so
 * nothing another specification leaves behind can change what the journey counts.
 */
export const E2E_JOURNEY_PORT = E2E_PORT + 3;
export const E2E_JOURNEY_URL = `http://127.0.0.1:${E2E_JOURNEY_PORT}`;

/** The `workerId` of the E2E `RemoteWorker`, the worker the Workers pages open in the specifications. */
export const E2E_FLEET_WORKER_ID = 'e2e-fleet-worker-1';

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

/**
 * COR-1582: a pinned run that is still running on the first build, so that build has durable work
 * bound to it. It waits for a signal nothing sends, which keeps the build's reference count at one
 * for the life of the server.
 */
export const E2E_HELD_WORKFLOW_TYPE = 'e2e-held-order';
export const E2E_HELD_RUN_ID = 'e2e-versioned-held-run';

/**
 * The one runtime setting the main host locks (`e2e-server.ts`), so `settings.spec.ts` can show
 * a locked key against the real Bureau. It is a `restart` key that nothing else in the suite reads.
 */
export const E2E_LOCKED_SETTING = 'workflowVersion' as const;
