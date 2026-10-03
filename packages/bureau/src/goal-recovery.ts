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
 * | running, pending, or suspended, marked  | end it, then commit `canceled` from the host        |
 * | suspended                               | resume it                                           |
 * | cancelled, or a cancellation marker     | commit `canceled` from the host (also with no engine)|
 * | any of the starts above, bureau closing | nothing, `shutting-down`; no restart is spent       |
 * | failed, timed out, or completed early   | restart it from the record, up to a bound           |
 * | its finalizer is still owed, or unread  | restart-pending; not counted; recover() retries it  |
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

import { goalInputFeedbackFor, isAttemptStartFailureDetail } from '@lostgradient/operative';
import { WorkflowTeardownPendingError } from '@lostgradient/weft';

import { runsToStop, settleCanceledGoal, unfinishedAfterCancellation } from './goal-cancellation';
import { cleanUpGoal, isCleanupDone } from './goal-cleanup';
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
import { type GoalState, goalWorkflowId, isTerminalGoalStatus } from './goal-state';
import type {
  BureauGoalAttemptRecovery,
  BureauGoalCancellationWait,
  BureauGoalRecoveryEntry,
  BureauGoalRecoveryOutcome,
  BureauGoalRecoveryReport,
} from './goal-types';

/** How many times a goal's controller is restarted before recovery gives up on it. */
export const MAXIMUM_CONTROLLER_RESTARTS = 3;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Recovery began while the bureau was shutting down, so it started nothing. */
const SHUTTING_DOWN: ControllerRecovery = {
  outcome: 'shutting-down',
  detail: 'The bureau is shutting down; the next boot recovers this goal.',
};

interface ControllerRecovery {
  readonly outcome: BureauGoalRecoveryOutcome;
  readonly detail?: string | undefined;
  readonly awaiting?: readonly BureauGoalCancellationWait[] | undefined;
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
  const commit = await settleCancellationCommit(dependencies, marked);
  if (commit.kind === 'settled') return commit.outcome;
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
    : {
        outcome: 'cancellation-pending',
        awaiting,
        detail: `Still waiting on: ${awaiting.join(', ')}.`,
      };
}

/** Ends the controller's workflow, then completes the cancellation the record asks for. */
async function endControllerAndCompleteCancellation(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<ControllerRecovery> {
  const engine = dependencies.getEngine();
  const { goalRunId } = record;
  try {
    await engine?.cancel(goalWorkflowId(goalRunId));
  } catch (error) {
    dependencies.diagnose({
      level: 'error',
      scope: 'goals',
      message: `[bureau] Could not cancel the controller of goal "${goalRunId}": ${describe(error)}`,
      cause: error,
    });
  }
  return completeCancellation(dependencies, record);
}

/** How many times a commit that lost to a concurrent writer is retried against the record it lost to. */
const CANCELLATION_COMMIT_ATTEMPTS = 3;

/**
 * Commits the cancellation a record's marker asks for and says what the answer
 * means, for the path with an engine and the path without one alike. Every
 * answer the commit can give is its own case, so a new one fails the compiler.
 *
 * - `committed`: the record says `canceled` (this call or another wrote it);
 *   what the world says is a separate read.
 * - `settled`: the commit cannot end in `canceled` and this is the honest answer.
 */
type CancellationCommit =
  | { readonly kind: 'committed' }
  | { readonly kind: 'settled'; readonly outcome: ControllerRecovery };

async function settleCancellationCommit(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<CancellationCommit> {
  const { store, clock } = dependencies;
  let current = record;
  for (let attempt = 0; attempt < CANCELLATION_COMMIT_ATTEMPTS; attempt += 1) {
    const committed = await commitCancellation(store, current, clock.now());
    switch (committed.status) {
      case 'applied':
      case 'duplicate':
      case 'not-needed':
        return { kind: 'committed' };
      case 'stale':
      case 'rejected':
        // Late, out of order, or conflicting: the record it carries is the
        // authoritative one, so the decision is made again against it.
        if (committed.record.status === 'canceled') return { kind: 'committed' };
        if (isTerminalGoalStatus(committed.record.status)) {
          return { kind: 'settled', outcome: { outcome: 'already-terminal' } };
        }
        if (committed.status === 'rejected') {
          return {
            kind: 'settled',
            outcome: {
              outcome: 'unrecoverable',
              detail: `The cancellation could not be committed: ${committed.reason}.`,
            },
          };
        }
        current = committed.record;
        break;
      case 'missing':
        return { kind: 'settled', outcome: { outcome: 'not-found' } };
      case 'corrupt':
        return {
          kind: 'settled',
          outcome: { outcome: 'unrecoverable', detail: UNREADABLE_RECORD_DETAIL(record.goalRunId) },
        };
    }
  }
  // Every round lost to a concurrent writer and the goal is still not canceled.
  // The marker is recorded and the next sweep commits it.
  return {
    kind: 'settled',
    outcome: {
      outcome: 'cancellation-pending',
      awaiting: ['goal-record'],
      detail: 'The cancellation is recorded, but committing it kept losing to concurrent writers.',
    },
  };
}

/**
 * A recorded cancellation with no durable engine: committing it needs no
 * engine, but everything the engine would have stopped is unread, so a
 * committed record is `cancellation-pending` awaiting the engine, never `canceled`.
 */
async function commitWithoutEngine(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<ControllerRecovery> {
  const result = await settleCancellationCommit(dependencies, record);
  return result.kind === 'settled'
    ? result.outcome
    : {
        outcome: 'cancellation-pending',
        awaiting: ['durable-engine'],
        detail: 'The cancellation is recorded, but there is no durable engine to read it back.',
      };
}

async function recoverController(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<ControllerRecovery> {
  const { store, clock, getEngine } = dependencies;
  const engine = getEngine();
  if (engine === undefined) {
    if (record.cancellation !== undefined) return commitWithoutEngine(dependencies, record);
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
    // Nothing below may start, resume, or restart a controller once the bureau
    // has begun shutting down: the engine is being disposed. A marked goal whose
    // controller already ended starts nothing (its cancellation is completed
    // below), so only the cases that would start one stop here.
    if (dependencies.isClosing() && (state === null || record.cancellation === undefined)) {
      return SHUTTING_DOWN;
    }
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
    // A cancellation marker means the goal is ending, and a controller that is
    // alive may be inside an activity that never returns (a validator, a start),
    // where no signal can reach it: the marker is read only at a decision point.
    // So it is ended, and the cancellation completed from the host, exactly as
    // for a suspended controller.
    if (record.cancellation !== undefined) {
      return endControllerAndCompleteCancellation(dependencies, record);
    }
    return { outcome: 'running' };
  }
  if (state.status === 'suspended') {
    if (record.cancellation !== undefined) {
      // A resumed controller would re-park on its attempt signal and the marker
      // in the store never wakes it, so the cancellation it was asked for would
      // hang with the attempt running. Ending the suspended workflow is what
      // `cancel()` does to a controller; the rest is settled the same way.
      return endControllerAndCompleteCancellation(dependencies, record);
    }
    if (dependencies.isClosing()) return SHUTTING_DOWN;
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
  // for a restart that cannot happen yet. Nothing retries it either, so it is
  // reported `restart-pending` (a failure in the boot report), and the next
  // `recover()` tries again. A finalizer that cannot be read is no evidence it
  // is settled: restarting on it would spend a count on a restart Weft refuses.
  let finalizer: Awaited<ReturnType<typeof engine.getFinalizerStatus>>;
  try {
    finalizer = await engine.getFinalizerStatus(goalWorkflowId(goalRunId));
  } catch (error) {
    return {
      outcome: 'restart-pending',
      detail: `The controller ended ${state.status} and its finalizer could not be read: ${describe(error)}`,
    };
  }
  if (finalizer !== null && (finalizer.status === 'pending' || finalizer.status === 'running')) {
    return {
      outcome: 'restart-pending',
      detail: `The controller ended ${state.status} and its finalizer is still ${finalizer.status}; recover() restarts it once that settles.`,
    };
  }
  // A shutdown that began while the finalizer was read must not consume a
  // restart for a controller that cannot be started. The window after this check,
  // between the count and the start, is a few awaits wide.
  if (dependencies.isClosing()) return SHUTTING_DOWN;
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
  if (counted.status === 'rejected') {
    // Only a terminal goal is done. A full audit log leaves the goal running
    // with no controller and no room to record a restart: that is a goal
    // recovery gave up on, and it must not read as one that ended.
    return counted.reason === 'terminal'
      ? { outcome: 'already-terminal' }
      : {
          outcome: 'unrecoverable',
          detail: `The controller ended ${state.status}, but the goal's audit log has no room to record a restart.`,
        };
  }
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
        outcome: 'restart-pending',
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
  // start it again, exactly as the controller's own activity would have, unless
  // the bureau is shutting down, when no run may be started.
  if (dependencies.isClosing()) {
    return { detail: 'The attempt was not restarted: the bureau is shutting down.' };
  }
  const feedback = goalInputFeedbackFor(current.attempts, last.attemptIndex);
  const started = await startAttempt({
    goalRunId: current.goalRunId,
    attemptIndex: last.attemptIndex,
    attemptId: goalIdentifiers.attemptId(current.goalRunId, last.attemptIndex),
    runId: last.runId,
    ...(feedback === undefined ? {} : { feedback }),
  });
  if (started.status === 'stood-down') {
    // The goal was canceled, ended, or ran out of its duration; nothing was
    // created, and the controller ends the goal from the record.
    return { detail: 'The attempt was not restarted: the goal is over or out of time.' };
  }
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
  if (settled.outcome === 'not-found') return { goalRunId: record.goalRunId, outcome: 'not-found' };
  if (settled.outcome === 'record-unreadable') {
    return {
      goalRunId: record.goalRunId,
      outcome: 'unrecoverable',
      detail: UNREADABLE_RECORD_DETAIL(record.goalRunId),
    };
  }
  if (settled.outcome === 'cancellation-pending') {
    return {
      goalRunId: record.goalRunId,
      outcome: 'cancellation-pending',
      awaiting: settled.awaiting,
      detail: `Still waiting on: ${settled.awaiting.join(', ')}.`,
    };
  }
  return { goalRunId: record.goalRunId, outcome: 'already-terminal' };
}

/** A closure was committed but the cleanup it owes was not recorded as finished. */
const owesCleanup = (record: GoalState): boolean =>
  record.closedAt !== undefined && record.cleanedUpAt === undefined;

/**
 * An ending that can leave a run behind. The controller never abandons a start
 * it issued (it waits for the start activity to settle), so it knows the run it
 * must stop, and stops it before it commits the ending. What it cannot know
 * about is a start it did not wait for: a try Weft timed out that is still
 * running in the background, or the host's own recovery start, which creates
 * its run after the goal ended, or a process that dies after the engine's start
 * committed the run and before the start's own stand-down check stopped it.
 * Either leaves a run alive under a goal that is already terminal. A start can
 * be in flight when the goal is canceled, when its aggregate duration runs out,
 * and when the start itself ends the goal `failed` (`attempt-run-failed`, from a
 * start-failure commit), so those three are swept; a goal that failed for any
 * other reason, or succeeded, ended after every start it issued had settled.
 * A goal that is still running whose controller recovery gave up on
 * (`unrecoverable`) is not terminal and is reported at every boot; the run such
 * a start leaves is not swept until the goal ends.
 */
export const mayHaveOvertakenAStart = (record: GoalState): boolean =>
  record.status === 'canceled' ||
  record.status === 'exhausted' ||
  (record.status === 'failed' &&
    record.terminalReason === 'attempt-run-failed' &&
    isAttemptStartFailureDetail(record.failureDetail));

/** Whether a record still has anything for recovery to do. */
const needsRecovery = (record: GoalState): boolean =>
  !isTerminalGoalStatus(record.status) ||
  (mayHaveOvertakenAStart(record) && record.closedAt === undefined) ||
  owesCleanup(record);

/**
 * Stops the run an exhausted or start-failed goal's ending may have overtaken,
 * the defense in depth behind the controller's refusal to abandon a start. It covers exactly
 * one crash point: a start's run was created (the engine's start committed) but
 * the process died, or a timed-out background try ran on, before the start's own
 * stand-down check stopped it, after the goal had already ended. The goal is
 * terminal and its controller is done, so nothing but this will ever name that
 * run again. A run that does not exist when it is read is not proof that none
 * will appear: a start that has claimed its run but not yet created it, in a
 * background try that is still alive in this process, looks absent. That start
 * stands itself down once it sees the goal ended or out of time (the check
 * after the engine's start), so it is the process's own check that covers it,
 * and this sweep covers the crash that skips that check. `runsToStop` names the
 * in-flight attempt's run, or the next attempt's deterministic id for a start that died short of its commit. A run
 * that does not exist or has ended is left alone; one that cannot be read or
 * stopped is reported, and stays owed until the next boot or `recover()`, and so
 * is every run while there is no engine to read one with. A canceled goal is
 * settled the same way by `settleCommittedCancellation`. `close()` runs it first,
 * because a closed and cleaned goal leaves the sweep.
 */
export async function stopOvertakenRuns(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<BureauGoalRecoveryEntry> {
  const engine = dependencies.getEngine();
  // A run it may have left cannot be inspected without an engine, so the goal
  // is not reported done: it stays in the sweep until one can be read.
  if (engine === undefined) {
    return {
      goalRunId: record.goalRunId,
      outcome: 'cleanup-pending',
      detail:
        'The goal ended, but there is no durable engine to look for a run its ending may have overtaken.',
    };
  }
  const failures: string[] = [];
  for (const runId of runsToStop(record)) {
    try {
      const run = await engine.get(runId);
      if (run === null || TERMINAL_CONTROLLER_STATUSES.has(run.status)) continue;
      const stopped = await dependencies.cancelRun(runId);
      if (stopped.status === 'failed') throw stopped.error;
    } catch (error) {
      dependencies.diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Could not stop run "${runId}", which the ending of goal "${record.goalRunId}" overtook; it is retried at the next boot or recover(): ${describe(error)}`,
        cause: error,
      });
      failures.push(`run "${runId}": ${describe(error)}`);
    }
  }
  return failures.length === 0
    ? { goalRunId: record.goalRunId, outcome: 'already-terminal' }
    : {
        goalRunId: record.goalRunId,
        outcome: 'cleanup-pending',
        detail: `The goal ended, but a run its ending overtook could not be stopped (${failures.join('; ')}).`,
      };
}

/**
 * Finishes the checkpoint cleanup a closed goal still owes: the process that
 * committed the closure died before it finished, or a part could not be pruned
 * then. Recorded on the goal only once nothing is left owed, so a part that
 * still cannot be pruned is tried again by the next boot or `close()`, and says
 * so: the entry it returns is `cleanup-pending`, which the boot report counts as
 * a failure. `undefined` when nothing is owed any longer.
 */
async function finishOwedCleanup(
  dependencies: GoalControlDependencies,
  record: GoalState,
): Promise<BureauGoalRecoveryEntry | undefined> {
  if (!owesCleanup(record)) return undefined;
  // Pruning is not started once the bureau is shutting down, and the cleanup is
  // still owed, so the goal must not read as finished: the next boot finishes it.
  if (dependencies.isClosing()) return { goalRunId: record.goalRunId, ...SHUTTING_DOWN };
  const cleanup = await cleanUpGoal(dependencies, record);
  if (isCleanupDone(cleanup)) {
    await dependencies.store.markCleanedUp(record.goalRunId, dependencies.clock.nowISO());
    return undefined;
  }
  const reason =
    dependencies.getEngine() === undefined
      ? 'there is no durable engine to prune it with'
      : cleanup.status === 'failed'
        ? describe(cleanup.error)
        : `it is unresolved (${cleanup.status === 'unresolved' ? cleanup.reason : 'unknown'})`;
  if (cleanup.status === 'failed') {
    dependencies.diagnose({
      level: 'error',
      scope: 'goals',
      message: `[bureau] Could not apply checkpoint retention to the closed goal "${record.goalRunId}"; it is retried at the next boot or close(): ${describe(cleanup.error)}`,
      cause: cleanup.error,
    });
  }
  return {
    goalRunId: record.goalRunId,
    outcome: 'cleanup-pending',
    detail: `The closed goal's checkpoint cleanup is not finished: ${reason}.`,
  };
}

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
    const settled: BureauGoalRecoveryEntry =
      record.status === 'canceled'
        ? await settleCommittedCancellation(dependencies, record)
        : mayHaveOvertakenAStart(record)
          ? await stopOvertakenRuns(dependencies, record)
          : { goalRunId, outcome: 'already-terminal' };
    // Only once nothing is left to stop: pruning a history something still reads would lose it.
    if (settled.outcome === 'already-terminal') {
      return (await finishOwedCleanup(dependencies, record)) ?? settled;
    }
    return settled;
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
  if (
    controller.outcome === 'unrecoverable' ||
    controller.outcome === 'already-terminal' ||
    controller.outcome === 'not-found'
  ) {
    return { goalRunId, ...controller };
  }
  if (
    controller.outcome === 'canceled' ||
    controller.outcome === 'cancellation-pending' ||
    controller.outcome === 'restart-pending' ||
    controller.outcome === 'shutting-down' ||
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

export const UNREADABLE_RECORD_DETAIL = (goalRunId: string): string =>
  `The record stored for goal "${goalRunId}" is unreadable, so recovery cannot tell what it was doing.`;

/** The boot sweep: every goal that is not terminal, and every canceled one not yet closed, whose cleanup may be owed. */
export async function recoverEveryGoal(
  dependencies: GoalControlDependencies,
  /** Narrows the sweep to the goals the caller may see; every goal when omitted. */
  allows: (record: GoalState) => boolean = () => true,
  /**
   * Also report the records that cannot be decoded as failures. They have no
   * principal to check, so this is for a caller who may see every goal.
   */
  includeUnreadable = false,
): Promise<BureauGoalRecoveryReport> {
  const goals: BureauGoalRecoveryEntry[] = [];
  const failures: { goalRunId: string; reason: string }[] = [];
  let records: GoalState[];
  try {
    const scanned = await dependencies.store.scan();
    records = scanned.records.filter((record) => needsRecovery(record) && allows(record));
    if (includeUnreadable) {
      for (const goalRunId of scanned.unreadable) {
        failures.push({ goalRunId, reason: UNREADABLE_RECORD_DETAIL(goalRunId) });
      }
    }
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

/**
 * Why an entry of a recovery report is a failure rather than news, or
 * `undefined` when it is not one. The boot report folds these into its
 * per-run failures, so `waitForRecovery()` does not read clean over a goal that
 * is stuck: one recovery gave up on, one with no controller and nothing to
 * restart it, one whose attempt could not be reconciled, one that has ended but
 * owes cleanup (a closure's pruning, or a run its ending overtook) it could not
 * finish, or a cancellation that cannot settle (a dead-lettered finalizer, or no
 * engine to read it with).
 * A cancellation still waiting on a controller, finalizer, or run in progress is
 * not one: those finish on their own.
 */
export function recoveryEntryFailure(entry: BureauGoalRecoveryEntry): string | undefined {
  const reason = (fallback: string): string => entry.detail ?? fallback;
  if (entry.outcome === 'unrecoverable') return reason('The goal could not be recovered.');
  if (entry.outcome === 'restart-pending') {
    return reason('The controller ended and its restart is pending.');
  }
  if (entry.outcome === 'cleanup-pending') {
    return reason("The ended goal's cleanup is not finished.");
  }
  if (entry.attempt === 'failed') {
    return reason("The goal's attempt could not be reconciled.");
  }
  if (
    entry.outcome === 'cancellation-pending' &&
    entry.awaiting?.some((wait) => wait === 'finalizer-failed' || wait === 'durable-engine')
  ) {
    return reason('The cancellation cannot settle.');
  }
  return undefined;
}
