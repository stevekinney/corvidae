import type { WorkflowState } from '../types.ts';
import type { ExecutionAttempt } from './execution-attempts.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';
import { deriveWorkflowResultFromState, loadWorkflowState } from './storage-io.ts';
import { isTerminalWorkflowStatus } from './validation.ts';

/**
 * A parent's view of a child this engine lost to a checkpoint race (COR-1426).
 *
 * The child's result waiter was rejected with the conflict: the winning engine owns the child, so
 * nothing on this engine will ever settle the parent's view of it. The child is healthy, though,
 * and its outcome becomes durable on the winner. So the parent keeps waiting and observes that
 * durable terminal state, polled at `workflowClaimRenewIntervalMs` (the interval of the existing
 * cross-engine result poll, which only runs under `workflow-lease`, where this conflict cannot
 * occur). It reads only, never writes, and never fails the parent for the child's loss. A child
 * that fails, is cancelled, or times out on the winner fails the parent with that outcome, exactly
 * as an awaited child's terminal state would.
 *
 * Unbounded on purpose: if the winner never finishes the child, the parent stays parked, which is
 * what it did before. The poll stops, writing nothing, as soon as the parent no longer awaits:
 * its race branch lost (aborted signal), the parent was relaunched or
 * replaced (the captured attempt is no longer current, which is also what disposal does, since it
 * retires every attempt), suspended (its checkpoint was released),
 * is terminalizing or terminal, or this engine lost its claim (`confirmParentStillOwned`).
 * `engine.resume(parent)` begins a new attempt that replays `startChild()`, which starts a fresh
 * poll; the old one stops.
 *
 * `backgroundTasks: 'manual'` starts no timer: `runMaintenance()` drives {@link pollChildOutcomes}.
 */
export type ChildOutcomeWatch = {
  readonly parentWorkflowId: string;
  readonly childWorkflowId: string;
  /** The attempt the parent held when it began awaiting, captured before any await. */
  readonly parentAttempt: ExecutionAttempt | undefined;
  /** Aborted when a `ctx.race` branch awaiting the child loses. */
  readonly signal: AbortSignal | undefined;
  /** The existing parent-claim fence; `false` means this engine no longer owns the parent. */
  readonly confirmParentStillOwned: () => Promise<boolean>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

type Poller = { tick(): Promise<void> };

const pollersByEngine = new WeakMap<EngineInternals, Set<Poller>>();

function parentNoLongerAwaits(internals: EngineInternals, watch: ChildOutcomeWatch): boolean {
  const { parentWorkflowId, parentAttempt } = watch;
  return (
    watch.signal?.aborted === true ||
    parentAttempt === undefined ||
    currentExecutionAttempt(internals, parentWorkflowId) !== parentAttempt ||
    !internals.checkpoints.has(parentWorkflowId) ||
    internals.terminalizingWorkflows.has(parentWorkflowId)
  );
}

async function readChildState(
  internals: EngineInternals,
  childWorkflowId: string,
): Promise<WorkflowState | null> {
  try {
    return await loadWorkflowState(internals, childWorkflowId);
  } catch {
    // An unreadable child is not a verdict on it: keep waiting and read again.
    return null;
  }
}

function settleFromState(watch: ChildOutcomeWatch, state: WorkflowState): void {
  try {
    watch.resolve(deriveWorkflowResultFromState(state));
  } catch (outcome) {
    // The persisted failure, cancellation, or timeout of the child is the parent's outcome too.
    watch.reject(outcome);
  }
}

export function watchChildDurableOutcome(
  internals: EngineInternals,
  watch: ChildOutcomeWatch,
): void {
  let pollers = pollersByEngine.get(internals);
  if (pollers === undefined) {
    pollers = new Set();
    pollersByEngine.set(internals, pollers);
  }
  const registry = pollers;
  let finished = false;
  let reading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (): void => {
    finished = true;
    registry.delete(poller);
    if (timer !== undefined) {
      clearTimeout(timer);
      internals.pendingResultPollTimers.delete(timer);
    }
  };

  const observe = async (): Promise<void> => {
    if (parentNoLongerAwaits(internals, watch)) return finish();
    const state = await readChildState(internals, watch.childWorkflowId);
    if (finished || parentNoLongerAwaits(internals, watch)) return finish();
    if (state === null || !isTerminalWorkflowStatus(state.status)) return;
    if (!(await watch.confirmParentStillOwned()) || parentNoLongerAwaits(internals, watch)) {
      return finish();
    }
    finish();
    settleFromState(watch, state);
  };

  const tick = async (): Promise<void> => {
    if (finished || reading) return;
    reading = true;
    try {
      await observe();
    } finally {
      reading = false;
    }
  };
  const poller: Poller = { tick };
  registry.add(poller);

  const scheduleNext = (): void => {
    if (finished || internals.options.backgroundTaskMode !== 'automatic') return;
    const handle = setTimeout(() => {
      internals.pendingResultPollTimers.delete(handle);
      void tick().then(scheduleNext);
    }, internals.options.workflowClaimRenewIntervalMs);
    // Tracked so disposal cancels it; never holds an otherwise-idle process open.
    internals.pendingResultPollTimers.add(handle);
    (handle as { unref?: () => void }).unref?.();
    timer = handle;
  };
  void tick().then(scheduleNext);
}

/** Drive every pending parent view once; `runMaintenance()` calls this where no timer runs. */
export async function pollChildOutcomes(internals: EngineInternals): Promise<void> {
  const pollers = pollersByEngine.get(internals);
  if (pollers === undefined) return;
  for (const poller of Array.from(pollers)) await poller.tick();
}
