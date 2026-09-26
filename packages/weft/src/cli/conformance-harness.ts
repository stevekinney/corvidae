/**
 * Process lifecycle and observation primitives for the `weft conformance`
 * command's checks (`conformance.ts`). Every wait here is barrier-based —
 * polled against an observed condition (registry state, a ledger record, a
 * worker's own reported heartbeat/idle status), never a fixed sleep standing
 * in for "probably done by now" — so a check fails only when the condition
 * it names genuinely never becomes true within `timeoutMs`, not when a slow
 * machine merely takes longer than some guessed margin.
 *
 * @module cli/conformance-harness
 */

import {
  decode,
  isRemoteTaskTerminalCancelled,
  isRemoteTaskTerminalResolved,
  MemoryStorage,
  REMOTE_WORKER_PROTOCOL_VERSION,
  taskLedgerKey,
  type WeftServer,
} from '../index.ts';

export const CONFORMANCE_QUEUE = 'conformance';
export const CONFORMANCE_ACTIVITIES = [
  'conformance.echo',
  'conformance.sleep',
  'conformance.cancel',
] as const;
export const CONFORMANCE_HEARTBEAT_INTERVAL_MS = 25;

export type RunningWorker = {
  process: ReturnType<typeof Bun.spawn>;
};

export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }

  const message = `Timed out after ${timeoutMs}ms waiting for ${label}`;
  throw lastError instanceof Error
    ? new Error(`${message}: ${lastError.message}`)
    : new Error(message);
}

export function startWorker(command: string[], server: WeftServer): RunningWorker {
  const environment = {
    ...Bun.env,
    WEFT_WORKER_URL: `${server.url.replace('http://', 'ws://')}/v1/tasks/${CONFORMANCE_QUEUE}/stream`,
    WEFT_WORKER_QUEUE: CONFORMANCE_QUEUE,
    WEFT_WORKER_ACTIVITIES: CONFORMANCE_ACTIVITIES.join(','),
    WEFT_WORKER_PROTOCOL_VERSION: String(REMOTE_WORKER_PROTOCOL_VERSION),
    WEFT_CONFORMANCE_HEARTBEAT_INTERVAL_MS: String(CONFORMANCE_HEARTBEAT_INTERVAL_MS),
  };

  return {
    process: Bun.spawn(command, {
      env: environment,
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  };
}

export async function stopWorker(worker: RunningWorker | undefined): Promise<void> {
  if (worker === undefined) return;
  if (worker.process.exitCode !== null) return;

  worker.process.kill('SIGTERM');
  try {
    await Promise.race([worker.process.exited, Bun.sleep(1_000)]);
  } catch {
    // Ignore shutdown races; the fallback kill below handles a still-running child.
  }
  if (worker.process.exitCode === null) {
    worker.process.kill('SIGKILL');
    await worker.process.exited.catch(() => undefined);
  }
}

export async function waitForRegisteredWorker(
  server: WeftServer,
  timeoutMs: number,
): Promise<string> {
  await waitForCondition(() => server.registry.getAll().length > 0, timeoutMs, 'worker register');
  const worker = server.registry.getAll()[0];
  if (worker === undefined) {
    throw new Error('worker registry was empty after registration wait');
  }
  return worker.id;
}

export async function waitForReplacementWorker(
  server: WeftServer,
  originalWorkerId: string,
  timeoutMs: number,
): Promise<string> {
  let replacementWorkerId: string | undefined;
  await waitForCondition(
    () => {
      replacementWorkerId = server.registry
        .getAll()
        .find((registeredWorker) => registeredWorker.id !== originalWorkerId)?.id;
      return replacementWorkerId !== undefined;
    },
    timeoutMs,
    'replacement worker register',
  );
  if (replacementWorkerId === undefined) {
    throw new Error('replacement worker registry was empty after registration wait');
  }
  return replacementWorkerId;
}

export async function waitForWorkerHeartbeat(
  server: WeftServer,
  workerId: string,
  timeoutMs: number,
): Promise<void> {
  const disconnectedMessage = `Worker ${workerId} disconnected before heartbeat was observed`;
  const heartbeatBefore = server.registry.getWorker(workerId)?.lastHeartbeat;
  if (heartbeatBefore === undefined) {
    throw new Error(disconnectedMessage);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const worker = server.registry.getWorker(workerId);
    if (worker === undefined) {
      throw new Error(disconnectedMessage);
    }
    if (worker.lastHeartbeat > heartbeatBefore) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for worker ${workerId} heartbeat`);
}

export async function waitForWorkerIdle(
  server: WeftServer,
  workerId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const worker = server.registry.getWorker(workerId);
    if (worker === undefined) {
      throw new Error(`Worker ${workerId} disconnected while waiting to become idle`);
    }
    if (worker.inFlight === 0) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for worker ${workerId} to become idle`);
}

/**
 * Read the resolved status of a task through the durable remote task ledger
 * (WFT-22) — the sole writer of task state; `op:resolved:` no longer exists.
 * Only a `resolved`-disposition terminal record carries a `status`; a
 * cancelled or retry-exhausted disposition returns `undefined` since neither
 * represents "resolved as completed/failed" the way this harness's checks
 * expect.
 */
export async function readResolvedStatus(
  storage: MemoryStorage,
  operationId: string,
): Promise<'completed' | 'failed' | undefined> {
  const stored = await storage.get(taskLedgerKey(operationId));
  if (stored === null) return undefined;
  const decoded = decode(stored);
  if (!isRemoteTaskTerminalResolved(decoded)) return undefined;
  return decoded.status;
}

export async function waitForResolvedStatus(
  storage: MemoryStorage,
  operationId: string,
  status: 'completed' | 'failed',
  timeoutMs: number,
): Promise<void> {
  await waitForCondition(
    async () => (await readResolvedStatus(storage, operationId)) === status,
    timeoutMs,
    `${operationId} to resolve as ${status}`,
  );
}

/**
 * Whether a task has resolved with the ledger's distinct `cancelled`
 * disposition (COR-230, acceptance criterion 13) — a `RemoteTaskTerminalCancelled`
 * record, not a `resolved`-disposition record with `status: 'failed'`. Before
 * COR-230, a worker's cooperative `taskResult(status: 'cancelled')` was
 * folded into an ordinary failed resolution; this check exists specifically
 * to prove that conflation is gone.
 */
export async function readCancelledDisposition(
  storage: MemoryStorage,
  operationId: string,
): Promise<boolean> {
  const stored = await storage.get(taskLedgerKey(operationId));
  if (stored === null) return false;
  return isRemoteTaskTerminalCancelled(decode(stored));
}

export async function waitForCancelledDisposition(
  storage: MemoryStorage,
  operationId: string,
  timeoutMs: number,
): Promise<void> {
  await waitForCondition(
    () => readCancelledDisposition(storage, operationId),
    timeoutMs,
    `${operationId} to resolve with the cancelled disposition`,
  );
}

/**
 * Read which worker session currently holds an operation's attempt, straight
 * from the durable task ledger record (`leased`/`completing`/`cancelling`
 * all carry `workerSessionId`; `queued` and `terminal` do not). The server
 * commits this transition atomically, before it ever sends the reassigned
 * `task` frame over the wire (`task-dispatch.ts`), so it is the earliest
 * observable signal that a reassignment has actually happened — unlike a
 * worker's registry `inFlight` count, which a worker that resolves a
 * reassigned attempt immediately can already have dropped back to zero
 * before the very next poll.
 */
export async function readCurrentAttemptWorkerSessionId(
  storage: MemoryStorage,
  operationId: string,
): Promise<string | undefined> {
  const stored = await storage.get(taskLedgerKey(operationId));
  if (stored === null) return undefined;
  const decoded = decode(stored);
  if (decoded === null || typeof decoded !== 'object') return undefined;
  const workerSessionId = (decoded as Record<string, unknown>)['workerSessionId'];
  return typeof workerSessionId === 'string' ? workerSessionId : undefined;
}

/**
 * Wait for an operation to be reassigned to `workerId`. Reading only "is
 * `workerId` the CURRENT attempt's worker session" is not enough on its own:
 * that is a genuinely transient state — a fixture that resolves a reassigned
 * attempt immediately (the `holdForReassignment` contract in
 * `conformance.ts`) can complete it and advance the ledger to `terminal`
 * (which carries no `workerSessionId` at all) within a single poll interval,
 * so a poll that lands even one tick late would see neither "leased under
 * `workerId`" nor any earlier state — a false timeout, not a real one. A
 * resolved status (of either disposition — the caller checks which one
 * separately) is proof reassignment already happened and completed, so it
 * counts too; a `workerId` that has itself disconnected also ends the wait,
 * matching a fixture that simulates the replacement vanishing instead of
 * completing.
 */
export async function waitForReassignmentToWorker(
  server: WeftServer,
  storage: MemoryStorage,
  operationId: string,
  workerId: string,
  timeoutMs: number,
): Promise<void> {
  await waitForCondition(
    async () =>
      (await readCurrentAttemptWorkerSessionId(storage, operationId)) === workerId ||
      (await readResolvedStatus(storage, operationId)) !== undefined ||
      server.registry.getWorker(workerId) === undefined,
    timeoutMs,
    `${operationId} reassigned to worker ${workerId}`,
  );
}
