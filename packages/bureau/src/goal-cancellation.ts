/**
 * COR-851 — `bureau.goals.cancel`.
 *
 * Cancellation is durable before it is anything else. The marker written to the
 * goal's record is authoritative: once it is there the store accepts no
 * transition but `canceled`, so no late controller write can overtake it.
 * Everything after that makes the rest of the world agree, in this order:
 *
 * 1. Wake the controller with the `cancel` signal. An optimisation: a
 *    controller that was parked commits `canceled` itself.
 * 2. `engine.cancel` the controller workflow, and await its durable commit. It
 *    ends the generator mid-flight, so a controller that had not yet acted on
 *    the signal never will.
 * 3. Stop the attempt's run (`cancelDurableRun`, idempotent).
 * 4. Commit `canceled` from the host, with the controller's own builder. A
 *    controller that already did leaves this a `duplicate`.
 * 5. One fresh read of everything that must be finished: the goal record, the
 *    controller's terminal status, its finalizer, and the attempt's run.
 *
 * There is no polling after step 2. What the read finds in step 5 is the answer:
 * every condition terminal is `canceled`, anything else is
 * `cancellation-pending` and names what it saw unfinished, because
 * `engine.cancel` having resolved is not proof that a cancellation committed.
 */

import { GOAL_CANCEL_SIGNAL } from '@lostgradient/operative';
import {
  TERMINAL_CONTROLLER_STATUSES,
  attemptToStop,
  commitCancellation,
  type GoalControlDependencies,
} from './goal-controller';
import { goalWorkflowId, isTerminalGoalStatus, type GoalState } from './goal-state';
import type {
  BureauGoalCancelOptions,
  BureauGoalCancelOutcome,
  BureauGoalCancellationWait,
} from './goal-types';

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Performs a cancellation the caller has already authorized against `record`. */
export async function cancelGoal(
  dependencies: GoalControlDependencies,
  record: GoalState,
  options: BureauGoalCancelOptions,
): Promise<BureauGoalCancelOutcome> {
  const { store, clock, diagnose, getEngine, cancelRun } = dependencies;
  const { goalRunId } = record;
  if (isTerminalGoalStatus(record.status)) return { outcome: 'already-terminal', goal: record };

  const now = clock.nowISO();
  const marked = await store.requestCancellation(
    goalRunId,
    {
      requestedAt: now,
      ...(options.principal === undefined ? {} : { principal: options.principal }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    },
    now,
  );
  if (marked.status === 'missing' || marked.status === 'corrupt') return { outcome: 'not-found' };
  if (marked.status === 'rejected') return { outcome: 'already-terminal', goal: marked.record };
  if (marked.status === 'stale') {
    return { outcome: 'cancellation-pending', goal: marked.record, awaiting: ['goal-record'] };
  }

  const engine = getEngine();
  const workflowId = goalWorkflowId(goalRunId);
  const attempt = attemptToStop(marked.record);
  if (engine !== undefined) {
    // Each step is attempted whatever the one before did: a failure leaves the
    // marker in place and shows up as something unfinished in the read-back.
    try {
      await engine.signal(workflowId, GOAL_CANCEL_SIGNAL, {}, { signalId: `cancel:${goalRunId}` });
    } catch {
      // Only an optimisation; the controller may already be gone.
    }
    try {
      await engine.cancel(workflowId);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Could not cancel the controller of goal "${goalRunId}": ${describe(error)}`,
        cause: error,
      });
    }
    const stopped = await cancelRun(attempt.runId).catch((error: unknown) => ({
      status: 'failed' as const,
      error,
    }));
    if (stopped.status === 'failed') {
      diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Could not stop run "${attempt.runId}" for goal "${goalRunId}": ${describe(stopped.error)}`,
        cause: stopped.error,
      });
    }
  }
  const latest = (await store.get(goalRunId)) ?? marked.record;
  if (!isTerminalGoalStatus(latest.status)) {
    await commitCancellation(store, latest, clock.now());
  }

  return readBack(dependencies, goalRunId, attempt.runId, marked.record);
}

/** One fresh read of every condition `cancel()` answers for. */
async function readBack(
  dependencies: GoalControlDependencies,
  goalRunId: string,
  attemptRunId: string,
  fallback: GoalState,
): Promise<BureauGoalCancelOutcome> {
  const { store, getEngine } = dependencies;
  const goal = (await store.get(goalRunId)) ?? fallback;
  const awaiting: BureauGoalCancellationWait[] = [];
  if (goal.status !== 'canceled') awaiting.push('goal-record');

  const engine = getEngine();
  if (engine !== undefined) {
    const controller = await engine.get(goalWorkflowId(goalRunId)).catch(() => undefined);
    if (
      controller === undefined ||
      (controller !== null && !TERMINAL_CONTROLLER_STATUSES.has(controller.status))
    ) {
      awaiting.push('controller');
    }
    const finalizer = await engine
      .getFinalizerStatus(goalWorkflowId(goalRunId))
      .catch(() => undefined);
    if (finalizer === undefined || (finalizer !== null && finalizer.status !== 'succeeded')) {
      awaiting.push('finalizer');
    }
    const attempt = await engine.get(attemptRunId).catch(() => undefined);
    if (
      attempt === undefined ||
      (attempt !== null && !TERMINAL_CONTROLLER_STATUSES.has(attempt.status))
    ) {
      awaiting.push('attempt-run');
    }
  }
  return awaiting.length === 0
    ? { outcome: 'canceled', goal }
    : { outcome: 'cancellation-pending', goal, awaiting };
}
