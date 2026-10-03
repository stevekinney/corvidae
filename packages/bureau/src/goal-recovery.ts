/**
 * COR-851 — `bureau.goals.recover`, and the boot sweep that calls it.
 *
 * A goal's durable record says what it was doing; recovery makes the world
 * agree. For each goal that is not terminal it settles two things, in this
 * order.
 *
 * ## The controller
 *
 * Read the controller workflow's stored state:
 *
 * | state                                   | what recovery does                                  |
 * | --------------------------------------- | --------------------------------------------------- |
 * | no workflow                             | start one (the crash between record and start)      |
 * | running or pending                      | nothing; a controller is alive                      |
 * | suspended                               | resume it; cancel it when a cancellation is marked  |
 * | cancelled, or a cancellation marker     | commit `canceled` from the host                     |
 * | failed, timed out, or completed early   | restart it from the record, up to a bound           |
 * | its finalizer is still owed             | nothing; the restart waits and is not counted       |
 * | a workflow that is not the goal's       | never touched: it reads as absent (goal-ownership)  |
 *
 * A goal whose `canceled` is already committed is not skipped: its controller
 * or attempt run may still be running if the process that committed it died
 * first, so `recover()` and the boot sweep settle it the way `cancel()` does
 * and answer `already-terminal` only once the read-back finds everything ended.
 *
 * A controller that ended while the goal was not terminal and no one asked it
 * to stop ended abnormally. It is restarted with `onTerminalConflict:
 * 'start-new'`, and the new instance resumes purely from the record. Each
 * restart advances `controllerRestarts`; past `MAXIMUM_CONTROLLER_RESTARTS` the
 * goal is reported `unrecoverable` and left exactly as it is. COR-638's
 * terminal reasons are not extended to cover it.
 *
 * ## The attempt
 *
 * A goal waiting on an attempt waits for a signal nothing else will send if the
 * process that was forwarding it died. So for a `running` goal recovery reads
 * the attempt's run: one that already ended has its signal sent again (the
 * signal id is stable, so a duplicate is harmless), one that is alive gets a
 * forwarder, and one that never started is started now, by the same
 * start-or-adopt the controller's own activity uses.
 */

import { GOAL_CANCEL_SIGNAL, goalInputFeedbackFor } from '@lostgradient/operative';
import { WorkflowTeardownPendingError } from '@lostgradient/weft';

import { settleCanceledGoal, unfinishedAfterCancellation } from './goal-cancellation';
import {
  attemptToStop,
  commitCancellation,
  enforceDeterminism,
  type GoalControlDependencies,
  startController,
  TERMINAL_CONTROLLER_STATUSES,
} from './goal-controller';
import { GoalOwnershipError } from './goal-ownership';
import { goalIdentifiers } from './goal-ports';
import { cancelSignalId, type GoalState, goalWorkflowId, isTerminalGoalStatus } from './goal-state';
import type {
  BureauGoalAttemptRecovery,
  BureauGoalRecoveryEntry,
  BureauGoalRecoveryOutcome,
  BureauGoalRecoveryReport,
} from './goal-types';

/** How many times a goal's controller is restarted before recovery gives up on it. */
export const MAXIMUM_CONTROLLER_RESTARTS = 3;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface ControllerRecovery {
  readonly outcome: BureauGoalRecoveryOutcome;
  readonly detail?: string | undefined;
}

/** The controller's own cancellation was requested, or its workflow was cancelled out from under it. */
async function completeCancellation(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<ControllerRecovery> {
  const { store, clock, cancelRun, diagnose } = dependencies;
  let marked = record;
  if (marked.cancellation === undefined) {
    // The controller was cancelled with no marker: someone ended its workflow
    // directly. That is an operator's cancellation, so it is recorded as one.
    const now = clock.nowISO();
    const outcome = await store.requestCancellation(
      record.goalRunId,
      { requestedAt: now, reason: 'The goal controller was cancelled.' },
      now,
    );
    if (outcome.status === 'rejected') return { outcome: 'already-terminal' };
    if (outcome.status !== 'updated' && outcome.status !== 'unchanged') {
      return { outcome: 'unrecoverable', detail: `cancellation marker: ${outcome.status}` };
    }
    marked = outcome.record;
  }
  const runIds = [attemptToStop(marked).runId, marked.attempts.at(-1)?.runId].filter(
    (runId, index, all): runId is string => runId !== undefined && all.indexOf(runId) === index,
  );
  for (const runId of runIds) {
    const stopped = await cancelRun(runId).catch((error: unknown) => ({
      status: 'failed' as const,
      error,
    }));
    if (stopped.status === 'failed') {
      diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Could not stop run "${runId}" of goal "${record.goalRunId}" while completing its cancellation: ${describe(stopped.error)}`,
        cause: stopped.error,
      });
    }
  }
  const committed = await commitCancellation(store, marked, clock.now());
  if (
    committed.status !== 'applied' &&
    committed.status !== 'duplicate' &&
    committed.status !== 'not-needed'
  ) {
    return { outcome: 'running', detail: `cancellation commit: ${committed.status}` };
  }
  // The record says `canceled`; whether the world agrees is a separate read, the
  // same one `cancel()` answers from. A run that could not be stopped keeps the
  // goal pending here rather than being reported done.
  const awaiting = await unfinishedAfterCancellation(
    dependencies.getEngine(),
    record.goalRunId,
    runIds,
    true,
    dependencies.diagnose,
  );
  return awaiting.length === 0
    ? { outcome: 'canceled' }
    : { outcome: 'cancellation-pending', detail: `Still waiting on: ${awaiting.join(', ')}.` };
}

async function recoverController(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<ControllerRecovery> {
  const { store, clock, getEngine } = dependencies;
  const engine = getEngine();
  if (engine === undefined) {
    return { outcome: 'unrecoverable', detail: 'There is no durable engine to run a controller.' };
  }
  const { goalRunId } = record;
  const state = await engine.get(goalWorkflowId(goalRunId));
  if (
    state === null ||
    state.status === 'failed' ||
    state.status === 'timed-out' ||
    state.status === 'completed'
  ) {
    // A controller is about to be started for a goal nothing has run yet.
    const ended = await enforceDeterminism(dependencies, record);
    if (ended !== undefined) return { outcome: 'unsupported-validation' };
  }
  if (state === null) {
    return {
      outcome:
        (await startController(engine, goalRunId, false)) === 'started' ? 'started' : 'running',
    };
  }
  if (state.status === 'running' || state.status === 'pending') {
    // A controller parked on its attempt wakes for a marker only by the signal,
    // and the process that wrote the marker may have died before sending it.
    // The signal id is stable, so sending it again is harmless.
    if (record.cancellation !== undefined) {
      await engine
        .signal(
          goalWorkflowId(goalRunId),
          GOAL_CANCEL_SIGNAL,
          {},
          { signalId: cancelSignalId(goalRunId) },
        )
        .catch(() => undefined);
    }
    return { outcome: 'running' };
  }
  if (state.status === 'suspended') {
    if (record.cancellation !== undefined) {
      // A resumed controller would re-park on its attempt signal and the marker
      // in the store never wakes it, so the cancellation it was asked for would
      // hang with the attempt running. Ending the suspended workflow is what
      // `cancel()` does to a controller; the rest is settled the same way.
      try {
        await engine.cancel(goalWorkflowId(goalRunId));
      } catch (error) {
        dependencies.diagnose({
          level: 'error',
          scope: 'goals',
          message: `[bureau] Could not cancel the suspended controller of goal "${goalRunId}": ${describe(error)}`,
          cause: error,
        });
      }
      return completeCancellation(dependencies, record);
    }
    await engine.resume(goalWorkflowId(goalRunId));
    return { outcome: 'running' };
  }
  if (record.cancellation !== undefined || state.status === 'cancelled') {
    return completeCancellation(dependencies, record);
  }
  if (!TERMINAL_CONTROLLER_STATUSES.has(state.status)) {
    return { outcome: 'running', detail: `controller status ${state.status}` };
  }

  // Failed, timed out, or completed while the goal is not terminal.
  if (record.controllerRestarts >= MAXIMUM_CONTROLLER_RESTARTS) {
    return {
      outcome: 'unrecoverable',
      detail: `The controller ended ${state.status} and has already been restarted ${record.controllerRestarts} times.`,
    };
  }
  // A controller that ended still owes its finalizer until Weft says it does
  // not, and Weft refuses to replace a run in that state. Nothing is counted
  // for a restart that cannot happen yet: the next recovery tries again.
  const finalizer = await engine.getFinalizerStatus(goalWorkflowId(goalRunId)).catch(() => null);
  if (finalizer !== null && (finalizer.status === 'pending' || finalizer.status === 'running')) {
    return {
      outcome: 'running',
      detail: `The controller ended ${state.status} and its finalizer is still ${finalizer.status}; it is restarted once that settles.`,
    };
  }
  // The count is a compare-and-swap on the value this recovery read, so of
  // several recoveries that saw the same ended controller exactly one is
  // counted, and only that one starts a replacement. A restart counted but
  // never started (a crash between the two) is spent: the bound errs toward
  // giving up, never toward a second controller.
  const counted = await store.recordControllerRestart(
    goalRunId,
    clock.nowISO(),
    record.controllerRestarts,
  );
  if (counted.status === 'rejected') return { outcome: 'already-terminal' };
  if (counted.status === 'stale') {
    return { outcome: 'running', detail: 'Another recovery is restarting the controller.' };
  }
  if (counted.status !== 'updated') {
    return { outcome: 'unrecoverable', detail: `restart count: ${counted.status}` };
  }
  let started: 'started' | 'exists';
  try {
    started = await startController(engine, goalRunId, true);
  } catch (error) {
    // A teardown that began between the readiness check above and this start.
    // That window is a few reads wide, and the count it spends is the one cost
    // of closing it: the check, not a refund, is what keeps a pending teardown
    // from consuming the bound.
    if (error instanceof WorkflowTeardownPendingError) {
      return {
        outcome: 'running',
        detail: `The restart waits for the controller's teardown: ${error.message}`,
      };
    }
    throw error;
  }
  return {
    outcome: started === 'started' ? 'restarted' : 'running',
    detail: `The controller ended ${state.status}${state.error === undefined ? '' : `: ${state.error}`}.`,
  };
}

/** Reconciles the attempt a `running` goal is waiting on. */
async function recoverAttempt(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<{ attempt?: BureauGoalAttemptRecovery; detail?: string }> {
  const { store, forwarder, startAttempt } = dependencies;
  const current = (await store.get(record.goalRunId)) ?? record;
  const last = current.attempts.at(-1);
  if (current.status !== 'running' || last === undefined || last.status !== 'running') return {};
  const target = {
    goalRunId: current.goalRunId,
    attemptIndex: last.attemptIndex,
    runId: last.runId,
  };
  const reconciled = await forwarder.reconcile(target);
  if (reconciled === 'watching') return { attempt: 'watching' };
  if (reconciled === 'signal-resent') return { attempt: 'signal-resent' };
  if (reconciled === 'not-needed') return {};

  // No run exists under the attempt's id. The controller recorded the attempt as
  // started, so the run was lost with its workflow before it could be recovered;
  // start it again, exactly as the controller's own activity would have.
  const feedback = goalInputFeedbackFor(current.attempts, last.attemptIndex);
  const started = await startAttempt({
    goalRunId: current.goalRunId,
    attemptIndex: last.attemptIndex,
    attemptId: goalIdentifiers.attemptId(current.goalRunId, last.attemptIndex),
    runId: last.runId,
    ...(feedback === undefined ? {} : { feedback }),
  });
  return started.status === 'failed'
    ? { attempt: 'failed', detail: started.detail }
    : { attempt: 'run-started' };
}

/**
 * Finishes what a committed `canceled` leaves to do, and answers the way
 * `cancel()` would: `already-terminal` when everything is settled, otherwise
 * `cancellation-pending` naming what is not.
 */
async function settleCommittedCancellation(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<BureauGoalRecoveryEntry> {
  const settled = await settleCanceledGoal(dependencies, record);
  if (settled.outcome === 'cancellation-pending') {
    return {
      goalRunId: record.goalRunId,
      outcome: 'cancellation-pending',
      detail: `Still waiting on: ${settled.awaiting.join(', ')}.`,
    };
  }
  return { goalRunId: record.goalRunId, outcome: 'already-terminal' };
}

/** Whether a record still has anything for recovery to do. */
const needsRecovery = (record: GoalState): boolean =>
  !isTerminalGoalStatus(record.status) ||
  (record.status === 'canceled' && record.closedAt === undefined);

/** Recovers one goal. Never throws. */
export async function recoverGoal(
  dependencies: GoalControlDependencies,
  goalRunId: string,
): Promise<BureauGoalRecoveryEntry> {
  const record = await dependencies.store.get(goalRunId);
  if (record === undefined) return { goalRunId, outcome: 'not-found' };
  if (isTerminalGoalStatus(record.status)) {
    // A goal whose `canceled` is committed may still have its controller or
    // attempt run to stop, if the process that committed it died first.
    return record.status === 'canceled'
      ? settleCommittedCancellation(dependencies, record)
      : { goalRunId, outcome: 'already-terminal' };
  }
  let controller: ControllerRecovery;
  try {
    controller = await recoverController(dependencies, record);
  } catch (error) {
    // Something that is not the goal's controller holds its workflow id: it was
    // left alone, and the goal cannot run until that is resolved.
    if (error instanceof GoalOwnershipError) {
      return { goalRunId, outcome: 'unrecoverable', detail: error.message };
    }
    throw error;
  }
  if (controller.outcome === 'unrecoverable' || controller.outcome === 'already-terminal') {
    return { goalRunId, ...controller };
  }
  if (
    controller.outcome === 'canceled' ||
    controller.outcome === 'cancellation-pending' ||
    controller.outcome === 'unsupported-validation'
  ) {
    return { goalRunId, ...controller };
  }
  const attempt = await recoverAttempt(dependencies, record).catch((error: unknown) => ({
    attempt: 'failed' as const,
    detail: describe(error),
  }));
  return {
    goalRunId,
    outcome: controller.outcome,
    ...(attempt.attempt === undefined ? {} : { attempt: attempt.attempt }),
    ...(attempt.detail === undefined && controller.detail === undefined
      ? {}
      : { detail: [controller.detail, attempt.detail].filter(Boolean).join(' ') }),
  };
}

/** The boot sweep: every goal that is not terminal, and every canceled one not yet closed, whose cleanup may be owed. */
export async function recoverEveryGoal(
  dependencies: GoalControlDependencies,
  /** Narrows the sweep to the goals the caller may see; every goal when omitted. */
  allows: (record: GoalState) => boolean = () => true,
): Promise<BureauGoalRecoveryReport> {
  const goals: BureauGoalRecoveryEntry[] = [];
  const failures: { goalRunId: string; reason: string }[] = [];
  let records: GoalState[];
  try {
    const stored = await dependencies.store.list();
    records = stored.filter((record) => needsRecovery(record) && allows(record));
  } catch (error) {
    return { goals, failures: [{ goalRunId: '*', reason: describe(error) }] };
  }
  for (const record of records) {
    try {
      const entry = await recoverGoal(dependencies, record.goalRunId);
      // A canceled goal is in the sweep only to have its cleanup finished; one
      // with nothing left to finish is no more news than any other ended goal.
      if (isTerminalGoalStatus(record.status) && entry.outcome === 'already-terminal') continue;
      goals.push(entry);
    } catch (error) {
      failures.push({ goalRunId: record.goalRunId, reason: describe(error) });
    }
  }
  return { goals, failures };
}
