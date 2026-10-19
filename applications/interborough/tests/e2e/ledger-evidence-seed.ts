/**
 * Seeds COR-124's attempt, lease, and cancellation evidence through real Weft
 * operations. Real `RemoteWorker`s claim real dispatches over the worker
 * protocol, Weft's own disconnect requeue produces the second attempt, the
 * worker's own `activityHeartbeat` frame records the heartbeat, and
 * `WeftServer.cancelTask` records cancellation intent. Nothing here writes
 * the task ledger or fakes a `weft.tasks.get` response.
 *
 * Three tasks, all on `E2E_LEDGER_QUEUE` so the fleet worker never claims
 * them:
 *
 * - `E2E_LEASED_TASK_OPERATION_ID` is claimed by a first worker, which then
 *   goes away without a result. After Weft's reconnect grace period the
 *   ledger requeues the attempt, and a second worker claims attempt 2,
 *   heartbeats, and holds the lease for the rest of the run. The ten-minute
 *   visibility timeout puts the session lease minutes out and the attempt
 *   lease (six visibility timeouts) an hour out, so no clock expires
 *   mid-suite.
 * - `E2E_CANCELLING_TASK_OPERATION_ID` is leased, then cancelled. Its
 *   activity ignores the abort signal, so the worker never acknowledges and
 *   the record stays `cancelling` until `E2E_CANCELLATION_GRACE_PERIOD_MS`.
 * - `E2E_CANCELLED_TASK_OPERATION_ID` is leased, then cancelled. Its activity
 *   honors the abort signal, so the owning attempt reports a cancelled
 *   result and the record settles terminal with that acknowledgement.
 */
import { RemoteWorker, type WeftServer } from '@lostgradient/weft';

import {
  E2E_CANCELLATION_REASON,
  E2E_CANCELLED_TASK_OPERATION_ID,
  E2E_CANCELLING_TASK_OPERATION_ID,
  E2E_CROSS_BUILD_QUEUE,
  E2E_CROSS_BUILD_TASK_OPERATION_ID,
  E2E_CROSS_BUILD_WORKER_ID,
  E2E_CURRENT_BUILD_ID,
  E2E_LEASED_TASK_OPERATION_ID,
  E2E_LEDGER_DEPLOYMENT_NAME,
  E2E_LEDGER_QUEUE,
  E2E_LEDGER_WORKER_ID,
  E2E_PORT,
  E2E_PREVIOUS_BUILD_ID,
} from './e2e-constants.ts';

type Scenario = 'hold-lease' | 'ignore-cancel' | 'honor-cancel';

interface ActivityContext {
  readonly signal: AbortSignal;
  heartbeat(details?: unknown): void;
}

type LedgerActivity = (input: unknown, context?: ActivityContext) => Promise<unknown>;

const TEN_MINUTES_MS = 600_000;
const SEED_WAIT_LIMIT_MS = 20_000;
const SEED_POLL_INTERVAL_MS = 50;

function scenarioOf(input: unknown): Scenario {
  const scenario =
    typeof input === 'object' && input !== null ? Reflect.get(input, 'scenario') : undefined;
  if (scenario === 'hold-lease' || scenario === 'ignore-cancel' || scenario === 'honor-cancel') {
    return scenario;
  }
  throw new Error(`Unknown ledger evidence scenario: ${String(scenario)}`);
}

/** Never settles and ignores abort: the attempt keeps its lease for the life of the server. */
function hold(): Promise<never> {
  return new Promise<never>(() => {});
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
}

/** The first worker only ever holds; it disappears before producing any result. */
const firstAttemptActivity: LedgerActivity = async () => hold();

/** The surviving worker: heartbeats a held lease, ignores or honors cancellation. */
const survivingActivity: LedgerActivity = async (input, context) => {
  const scenario = scenarioOf(input);
  if (scenario === 'hold-lease') {
    context?.heartbeat({ progress: 'second attempt running' });
    return hold();
  }
  if (scenario === 'ignore-cancel') return hold();
  if (context === undefined) throw new Error('honor-cancel needs an activity context');
  return waitForAbort(context.signal);
};

function ledgerWorker(
  workerId: string,
  activity: LedgerActivity,
  options: { readonly queue?: string; readonly buildId?: string } = {},
): RemoteWorker {
  const queue = options.queue ?? E2E_LEDGER_QUEUE;
  return new RemoteWorker({
    serverUrl: `ws://127.0.0.1:${E2E_PORT}/v1/tasks/${queue}/stream`,
    workerId,
    deploymentName: E2E_LEDGER_DEPLOYMENT_NAME,
    queue,
    buildId: options.buildId ?? E2E_CURRENT_BUILD_ID,
    workflows: {
      'order-processing': {
        name: 'order-processing',
        activities: { chargeCard: activity },
      },
    },
  });
}

async function waitFor(description: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + SEED_WAIT_LIMIT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(SEED_POLL_INTERVAL_MS);
  }
  throw new Error(`E2E ledger evidence seed timed out waiting for ${description}`);
}

async function waitForState(
  server: WeftServer,
  operationId: string,
  state: 'leased' | 'cancelling' | 'terminal',
): Promise<void> {
  await waitFor(`${operationId} to reach ${state}`, async () => {
    const result = await server.getTaskResult(operationId);
    if (result === null) return false;
    if (state === 'terminal') return result.status !== 'pending';
    return result.status === 'pending' && result.state === state;
  });
}

/** Reads `weft.tasks.get` over its REST binding on the host's origin, the same ledger read the console makes. */
async function readTaskDetail(operationId: string): Promise<Record<string, unknown>> {
  const response = await fetch(
    `http://127.0.0.1:${E2E_PORT}/v1/tasks/detail/${encodeURIComponent(operationId)}`,
  );
  if (!response.ok) return {};
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null ? { ...body } : {};
}

async function dispatch(
  server: WeftServer,
  operationId: string,
  scenario: Scenario,
  options: { readonly queue?: string; readonly maxAttempts?: number } = {},
) {
  const dispatched = await server.dispatchTask({
    operationId,
    workflowId: `${operationId}-workflow`,
    workflowExecutionToken: `${operationId}-token`,
    workflowType: 'order-processing',
    // Qualified: the worker registry routes by `${workflowType}.${activityName}`.
    activityName: 'order-processing.chargeCard',
    input: { scenario },
    queue: options.queue ?? E2E_LEDGER_QUEUE,
    visibilityTimeout: TEN_MINUTES_MS,
    retryPolicy: {
      maxAttempts: options.maxAttempts ?? 3,
      initialBackoff: '100ms',
      backoffMultiplier: 1,
      maxBackoff: '100ms',
    },
  });
  if (!dispatched) throw new Error(`E2E ledger evidence dispatch refused for ${operationId}`);
}

const DEPARTED_BUILD_ATTEMPTS = 3;

/**
 * Seeds COR-281's cross-build retry storm: `DEPARTED_BUILD_ATTEMPTS` workers on
 * the previous build each claim the task and disappear, and the returned worker,
 * on the current build, holds the next attempt. Waits on the ledger's own attempt
 * history after each hand-off, so the order of the attempts is the order seeded.
 */
async function seedCrossBuildStorm(server: WeftServer): Promise<RemoteWorker> {
  const options = { queue: E2E_CROSS_BUILD_QUEUE, buildId: E2E_PREVIOUS_BUILD_ID };
  for (let attempt = 1; attempt <= DEPARTED_BUILD_ATTEMPTS; attempt += 1) {
    const departed = ledgerWorker(
      `${E2E_CROSS_BUILD_WORKER_ID}-departed-${attempt}`,
      firstAttemptActivity,
      options,
    );
    await departed.connect();
    if (attempt === 1) {
      await dispatch(server, E2E_CROSS_BUILD_TASK_OPERATION_ID, 'hold-lease', {
        queue: E2E_CROSS_BUILD_QUEUE,
        maxAttempts: 8,
      });
    }
    await waitFor(
      `${E2E_CROSS_BUILD_TASK_OPERATION_ID} attempt ${attempt} to be leased`,
      async () => {
        const detail = await readTaskDetail(E2E_CROSS_BUILD_TASK_OPERATION_ID);
        return (
          detail['state'] === 'leased' &&
          Array.isArray(detail['attempts']) &&
          detail['attempts'].length === attempt
        );
      },
    );
    departed[Symbol.dispose]();
  }
  const surviving = ledgerWorker(E2E_CROSS_BUILD_WORKER_ID, survivingActivity, {
    queue: E2E_CROSS_BUILD_QUEUE,
  });
  await surviving.connect();
  await waitFor(`${E2E_CROSS_BUILD_TASK_OPERATION_ID} attempt 4 to be leased`, async () => {
    const detail = await readTaskDetail(E2E_CROSS_BUILD_TASK_OPERATION_ID);
    return (
      detail['state'] === 'leased' &&
      Array.isArray(detail['attempts']) &&
      detail['attempts'].length === DEPARTED_BUILD_ATTEMPTS + 1
    );
  });
  return surviving;
}

/** Seeds the COR-124 evidence tasks and COR-281's cross-build retry storm; resolves once each has reached its seeded state. */
export async function seedLedgerEvidence(server: WeftServer): Promise<readonly RemoteWorker[]> {
  // Attempt 1: claimed by a worker that then disappears without a result.
  const firstWorker = ledgerWorker(`${E2E_LEDGER_WORKER_ID}-departed`, firstAttemptActivity);
  await firstWorker.connect();
  await dispatch(server, E2E_LEASED_TASK_OPERATION_ID, 'hold-lease');
  await waitForState(server, E2E_LEASED_TASK_OPERATION_ID, 'leased');
  firstWorker[Symbol.dispose]();

  // Attempt 2: once the reconnect grace period requeues attempt 1, the
  // surviving worker claims the task and heartbeats.
  const worker = ledgerWorker(E2E_LEDGER_WORKER_ID, survivingActivity);
  await worker.connect();
  await waitFor(
    `${E2E_LEASED_TASK_OPERATION_ID} to hold a heartbeating second attempt`,
    async () => {
      const detail = await readTaskDetail(E2E_LEASED_TASK_OPERATION_ID);
      return (
        detail['state'] === 'leased' &&
        Array.isArray(detail['attempts']) &&
        detail['attempts'].length >= 2 &&
        typeof detail['lastHeartbeatAt'] === 'number'
      );
    },
  );

  await dispatch(server, E2E_CANCELLING_TASK_OPERATION_ID, 'ignore-cancel');
  await waitForState(server, E2E_CANCELLING_TASK_OPERATION_ID, 'leased');
  await server.cancelTask(E2E_CANCELLING_TASK_OPERATION_ID, E2E_CANCELLATION_REASON);
  await waitForState(server, E2E_CANCELLING_TASK_OPERATION_ID, 'cancelling');

  await dispatch(server, E2E_CANCELLED_TASK_OPERATION_ID, 'honor-cancel');
  await waitForState(server, E2E_CANCELLED_TASK_OPERATION_ID, 'leased');
  await server.cancelTask(E2E_CANCELLED_TASK_OPERATION_ID, E2E_CANCELLATION_REASON);
  await waitForState(server, E2E_CANCELLED_TASK_OPERATION_ID, 'terminal');

  return [worker, await seedCrossBuildStorm(server)];
}
