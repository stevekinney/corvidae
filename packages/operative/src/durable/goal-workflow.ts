/**
 * COR-851 — the durable `goalRun` workflow: the single-owner controller of one
 * goal.
 *
 * The in-memory controller (`startGoal`) keeps its state in closures. This one
 * keeps none: the durable `GoalState` record is the state, every transition is
 * committed to it through an idempotent activity, and every decision is made by
 * the same pure functions `startGoal` uses (`goal-decision.ts`). The workflow
 * holds only plain data, takes every effect through {@link GoalWorkflowPorts}
 * (no closure is serialized), and is registered without `services`, so Weft
 * never writes a services marker for it and never consults the services
 * resolver when it recovers.
 *
 * ## One loop, driven by the record
 *
 * Each iteration begins with a fresh read of the record (a "decision point")
 * and does one segment of work chosen by what it reads, never by a counter held
 * in a local. A brand-new instance, an instance replaying after a crash, and
 * the adoption of a rejected or stale commit are therefore the same code path:
 * they all read the record and continue from whatever it says. `record.cancellation`
 * is authoritative; the `cancel` signal only wakes the controller sooner.
 *
 * ## Slot sequence
 *
 * Weft keys durable operations by position, so a replay must issue the same
 * operations in the same order. Every branch below is a pure function of
 * results already recorded earlier in the same history (the record read, the
 * race winner, a commit result), so replaying a history re-takes the branch it
 * took the first time and no slot is ever conditional on anything unrecorded.
 * The rejected-commit path adds no slot of its own: a commit that answers
 * `stale` or `rejected` simply ends the iteration, and the next one reads the
 * authoritative record.
 *
 * Every iteration:
 *
 * ```text
 * L   loadGoalState                       the decision point
 *     terminal                -> return the result (no further slot)
 *     record missing/corrupt  -> return 'record-unavailable'
 * ```
 *
 * then, by what `L` read, the first matching row:
 *
 * ```text
 * cancellation marker set                 (any non-terminal status)
 *   A   abortAttempt                       no-op when no run exists
 *   C   commitTransition  -> canceled      the in-flight attempt is closed 'aborted' in it
 *
 * aggregate duration elapsed              (any non-terminal status)
 *   A   abortAttempt
 *   C   commitTransition  -> exhausted     aggregate-budget-exceeded
 *
 * pending | retrying
 *   S   startAttempt                       start-or-adopt by the deterministic run id;
 *                                          raced against sleep(remaining) when a duration bound is set,
 *                                          and when the deadline wins nothing more: the next L ends the goal
 *   C   commitTransition  -> running       attempt N, usage.attempts = N + 1, active = attempt
 *   S'  (S answered 'failed')              commitTransition -> failed (attempt-run-failed) in place of C
 *
 * running
 *   R   raceKeyed { attempt: waitForSignal('attempt-terminal:N'),
 *                   cancel:  waitForSignal('cancel'),
 *                   deadline: sleep(remaining) }      deadline only when a duration bound is set
 *       cancel | deadline won   -> nothing more; the next L sees the marker or the elapsed bound
 *       attempt won:
 *         L2  loadGoalState               re-read: the marker, the status, and the clock
 *             marker set, status moved, or bound elapsed -> nothing more; the next L handles it
 *         C   commitTransition -> evaluating     the run reached 'stop-condition'
 *         C   commitTransition -> <decision>     any other finish reason skips the validator
 *
 * evaluating
 *   V   runValidator                       at-least-once: a crash here re-runs it; raced against
 *                                          sleep(remaining) when a duration bound is set, and given
 *                                          min(validatorTimeoutMs, remaining) as its own timeout.
 *                                          When the deadline wins nothing more: the next L sees the
 *                                          elapsed bound and ends the goal (A, C -> exhausted)
 *   L2  loadGoalState                      re-read: the marker, the status, and the clock
 *       marker set or status moved -> nothing more; the next L handles it
 *       aggregate duration elapsed while the validator ran (the verdict is not applied):
 *         A   abortAttempt
 *         C   commitTransition -> exhausted     aggregate-budget-exceeded
 *   C   commitTransition -> <decision>     the verdict and the decision, together
 * ```
 *
 * Every wait on code the workflow does not own (the attempt's own signal, the
 * start of its run, the validator) is raced against the aggregate deadline, so a
 * hung one cannot hold a goal past `maximumTotalDurationMs`. With a bound, the race
 * is `raceKeyed({ work, deadline })` (one branch more than the unbounded wait); the
 * choice depends only on the recorded read, so a replay opens the same race. The
 * abandoned activity is idempotent and its late effects stand down (the start port
 * re-reads the goal before it writes, and stops the run it created if the goal
 * ended meanwhile). An abandoned start can outlive the goal's ending, and a
 * process that dies between the run's creation and that stand-down leaves a run
 * the terminal goal never names, so the host's recovery stops whatever run an
 * `exhausted` or `canceled` goal's ending overtook (`attemptToStop`'s target
 * and the last recorded attempt's), at every boot and `recover()`, until the
 * goal is closed and its cleanup recorded.
 *
 * The decision is committed once even though the validator may run twice: the
 * transition carries `decisionId = <attemptId>:decision`, the store accepts the
 * first and answers `duplicate`, `stale`, or `decision-already-recorded` to any
 * other, and the controller then adopts whatever the next read says.
 *
 * ## Cancellation and the deadline
 *
 * A cooperative cancellation is the `abortAttempt` and `commitTransition` pair
 * above. If the owner escalates to `engine.cancel`, the generator dies
 * mid-flight and nothing here can commit the terminal transition, so the host
 * completes it: it reads the engine's `cancelled` status together with the
 * record's cancellation marker and commits `canceled` through the store.
 *
 * The workflow also declares a definition-level finalizer, `finalizeGoal`, so
 * the run an attempt left behind is stopped even when the generator never got
 * to. At every decision point, right after the record read, the controller
 * stages `ctx.setFinalizerState` with the run a cancellation must stop (the
 * same target `abortAttempt` names: the attempt in flight, or the next
 * attempt's deterministic id for an orphan a crashed start left). Staging is
 * not a durable slot: it is a pure function of the recorded read, it is
 * committed with the next checkpoint, and a recovered workflow re-stages it
 * from the same history, so the slot sequence above is unchanged. After a
 * `cancelled` or `timed-out` terminal Weft drives the finalizer with the last
 * staged value, retrying and re-driving it across a crash, and it calls the
 * same idempotent `abortAttempt` port. A replaying controller re-stages each
 * recorded iteration's older target until it reaches the live frontier, so
 * `finalizeGoal` also re-reads the record when it runs (it is never replayed)
 * and stops the in-flight run named there; a hard cancel that lands mid-replay
 * still ends the right run. A workflow that ends `completed` or
 * `failed` owes no finalizer, and one that never reached a decision point
 * staged nothing, so `getFinalizerStatus` answers `null` for both: nothing owed.
 *
 * The deadline timer is a race branch: Weft anchors it to the
 * checkpoint time on resume, so a restart re-arms the same absolute deadline
 * rather than a fresh one, and the elapsed bound is checked again from a fresh
 * clock reading at every decision point regardless.
 *
 * ## Concurrency
 *
 * Weft's `workflow-lease` ownership fences this workflow to one engine. A
 * deposed controller that still issues a write is harmless: each commit request
 * is a deterministic function of the record it read, so it either answers
 * `duplicate` (the same transition is already current) or `stale` (the record
 * moved on), and a controller that receives either re-reads.
 */

import type { WorkflowContext } from '@lostgradient/weft';
import { workflow } from '@lostgradient/weft';

import {
  decideAttemptRunFailure,
  decideCancellation,
  decideDurationElapsed,
  decideOutcome,
  decideRunFinish,
  type GoalDecision,
} from '../goal-decision';
import { createGoalWorkflowActivities } from './goal-workflow-activities';
import {
  GOAL_CANCEL_SIGNAL,
  GOAL_WORKFLOW_RESULT_SCHEMA_VERSION,
  GOAL_WORKFLOW_TYPE,
  type GoalAttemptTerminalSignal,
  goalAttemptTerminalSignalName,
  GoalControllerError,
  type GoalWorkflowAbortRequest,
  type GoalWorkflowCommit,
  type GoalWorkflowInput,
  type GoalWorkflowPorts,
  type GoalWorkflowResult,
  type GoalWorkflowTransition,
  type GoalWorkflowView,
} from './goal-workflow-ports';
import {
  abortRequestFor,
  buildEvaluationStarted,
  buildGoalForcedFinish,
  buildOpenAttempt,
  buildRunFinishDecision,
  buildStartFailure,
  buildValidationDecision,
  currentAttemptOf,
  decisionContextFor,
  goalInputFeedbackFor,
  isDeadlineElapsed,
  isTerminalStatus,
  remainingMilliseconds,
} from './goal-workflow-transitions';

type GoalContext = WorkflowContext;

/** What one iteration did: the commit it made, or `undefined` when it only waited. */
type Segment = Generator<unknown, GoalWorkflowCommit | undefined, unknown>;

/**
 * Consecutive iterations whose commit was refused (`stale`, or a rejection the
 * next read resolves) before the controller gives up. A healthy goal never
 * refuses twice in a row: the refusal is what makes the next read authoritative.
 */
const MAXIMUM_CONSECUTIVE_REFUSALS = 5;

/**
 * Consecutive iterations that only waited (a wake with no marker behind it, an
 * attempt signal for a record that moved on, a deadline the record's clock does
 * not agree has elapsed) before the controller gives up. Bounds how much history
 * a controller whose two clocks disagree could write.
 */
const MAXIMUM_CONSECUTIVE_IDLE_WAKES = 25;

/** Rejections the next decision point resolves by reading the record. */
const ADOPTABLE_REJECTIONS: readonly string[] = [
  'terminal',
  'cancellation-requested',
  'decision-already-recorded',
];

function terminalResult(view: GoalWorkflowView): GoalWorkflowResult {
  if (view.terminalReason === undefined) {
    throw new GoalControllerError(
      `Goal "${view.goalRunId}" is ${view.status} with no terminal reason.`,
    );
  }
  return {
    schemaVersion: GOAL_WORKFLOW_RESULT_SCHEMA_VERSION,
    outcome: 'terminal',
    goalRunId: view.goalRunId,
    status: view.status as Extract<GoalWorkflowResult, { outcome: 'terminal' }>['status'],
    terminalReason: view.terminalReason,
    ...(view.failureDetail === undefined ? {} : { failureDetail: view.failureDetail }),
    transitionSeq: view.transitionSeq,
  };
}

const recordUnavailable = (goalRunId: string): GoalWorkflowResult => ({
  schemaVersion: GOAL_WORKFLOW_RESULT_SCHEMA_VERSION,
  outcome: 'record-unavailable',
  goalRunId,
});

function isRefusal(commit: GoalWorkflowCommit): boolean {
  return (
    commit.status === 'stale' ||
    (commit.status === 'rejected' && ADOPTABLE_REJECTIONS.includes(commit.reason))
  );
}

/**
 * Builds the durable `goalRun` workflow over the given ports. The ports are
 * captured once, like `createRunWorkflow`'s checkpoint store, so no per-run
 * registry or `services` is needed.
 */
export function createGoalWorkflow(ports: GoalWorkflowPorts) {
  const activities = createGoalWorkflowActivities(ports);
  const { identifiers } = ports;

  const runToStop = (view: GoalWorkflowView): GoalWorkflowAbortRequest =>
    abortRequestFor(view, identifiers);

  function* commit(
    ctx: GoalContext,
    request: GoalWorkflowTransition,
  ): Generator<unknown, GoalWorkflowCommit, unknown> {
    return yield* ctx.run(activities.commitTransition, request);
  }

  function* finishForced(
    ctx: GoalContext,
    view: GoalWorkflowView,
    nowMs: number,
    decision: GoalDecision,
  ): Segment {
    yield* ctx.run(activities.abortAttempt, runToStop(view));
    return yield* commit(ctx, buildGoalForcedFinish(view, identifiers, nowMs, decision));
  }

  /**
   * Runs one activity that calls out to code the workflow does not own, and
   * gives up on it when the aggregate duration elapses first. With no duration
   * bound the activity is simply awaited. The branch taken is a pure function
   * of the recorded read (`view`, `nowMs`), so a replay opens the same race.
   *
   * `elapsed` means the deadline won: nothing was learned about the activity,
   * and the caller returns so the next decision point reads the elapsed bound
   * and ends the goal. The abandoned activity is never relied on again; its
   * effects are the idempotent kind each one documents.
   */
  function* beforeDeadline<TResult>(
    ctx: GoalContext,
    view: GoalWorkflowView,
    nowMs: number,
    operation: () => Generator<unknown, TResult, unknown>,
  ): Generator<
    unknown,
    { readonly elapsed: false; readonly value: TResult } | { readonly elapsed: true },
    unknown
  > {
    const remaining = remainingMilliseconds(view, nowMs);
    if (remaining === undefined) return { elapsed: false, value: yield* operation() };
    const winner = yield* ctx.raceKeyed({
      work: operation(),
      deadline: ctx.sleep(Math.ceil(remaining)),
    });
    return winner.key === 'work' ? { elapsed: false, value: winner.value } : { elapsed: true };
  }

  function* openAttempt(ctx: GoalContext, view: GoalWorkflowView, nowMs: number): Segment {
    const attemptIndex = view.attempts.length;
    const feedback = goalInputFeedbackFor(view.attempts, attemptIndex);
    const request = {
      goalRunId: view.goalRunId,
      attemptIndex,
      attemptId: identifiers.attemptId(view.goalRunId, attemptIndex),
      runId: identifiers.attemptRunId(view.goalRunId, attemptIndex),
      ...(feedback === undefined ? {} : { feedback }),
    };
    const attempt = yield* beforeDeadline(ctx, view, nowMs, () =>
      ctx.run(activities.startAttempt, request),
    );
    if (attempt.elapsed) return undefined;
    const started = attempt.value;
    if (started.status === 'failed') {
      const decision = decideAttemptRunFailure(started.detail);
      return yield* commit(ctx, buildStartFailure(view, identifiers, nowMs, decision));
    }
    return yield* commit(
      ctx,
      buildOpenAttempt(view, identifiers, nowMs, { attemptIndex, sessionId: started.sessionId }),
    );
  }

  function* awaitAttempt(ctx: GoalContext, view: GoalWorkflowView, nowMs: number): Segment {
    const attempt = currentAttemptOf(view);
    if (attempt === undefined || attempt.status !== 'running') {
      throw new GoalControllerError(`Goal "${view.goalRunId}" is running with no running attempt.`);
    }
    const signalName = goalAttemptTerminalSignalName(attempt.attemptIndex);
    const remaining = remainingMilliseconds(view, nowMs);
    const winner =
      remaining === undefined
        ? yield* ctx.raceKeyed({
            attempt: ctx.waitForSignal<GoalAttemptTerminalSignal>(signalName),
            cancel: ctx.waitForSignal<unknown>(GOAL_CANCEL_SIGNAL),
          })
        : yield* ctx.raceKeyed({
            attempt: ctx.waitForSignal<GoalAttemptTerminalSignal>(signalName),
            cancel: ctx.waitForSignal<unknown>(GOAL_CANCEL_SIGNAL),
            deadline: ctx.sleep(Math.ceil(remaining)),
          });
    // The signal is an optimisation. Whichever of the marker or the elapsed
    // bound woke the controller, the next decision point reads it from the
    // record and the clock; there is nothing to commit from the wake itself.
    if (winner.key !== 'attempt') return undefined;
    const finished = winner.value;

    const reread = yield* ctx.run(activities.loadGoalState, { goalRunId: view.goalRunId });
    const fresh = reread.view;
    if (
      fresh === undefined ||
      fresh.cancellation !== undefined ||
      fresh.status !== 'running' ||
      fresh.transitionSeq !== view.transitionSeq ||
      isDeadlineElapsed(fresh, reread.nowMs)
    ) {
      return undefined;
    }
    const resolution = decideRunFinish(decisionContextFor(fresh, reread.nowMs), {
      finishReason: finished.finishReason,
      operatorAborted: false,
      costEstimateReported: finished.costUsd !== undefined,
      feedback: goalInputFeedbackFor(fresh.attempts, attempt.attemptIndex),
    });
    if (resolution.kind === 'decision') {
      return yield* commit(
        ctx,
        buildRunFinishDecision(fresh, identifiers, reread.nowMs, attempt, finished, resolution),
      );
    }
    return yield* commit(
      ctx,
      buildEvaluationStarted(fresh, identifiers, reread.nowMs, attempt, finished),
    );
  }

  function* validate(ctx: GoalContext, view: GoalWorkflowView, nowMs: number): Segment {
    const attempt = currentAttemptOf(view);
    if (attempt === undefined || attempt.status !== 'evaluating') {
      throw new GoalControllerError(
        `Goal "${view.goalRunId}" is evaluating with no evaluating attempt.`,
      );
    }
    // The validator is code the goal's owner supplied, and the port runs it
    // without an abort signal, so the aggregate duration cannot stop it from
    // outside. It is raced against the deadline, and told not to outlast it.
    const remaining = remainingMilliseconds(view, nowMs);
    const timeoutMs =
      remaining === undefined
        ? view.validatorTimeoutMs
        : Math.min(view.validatorTimeoutMs ?? Infinity, Math.ceil(remaining));
    const validation = yield* beforeDeadline(ctx, view, nowMs, () =>
      ctx.run(activities.runValidator, {
        goalRunId: view.goalRunId,
        attemptId: attempt.attemptId,
        attemptIndex: attempt.attemptIndex,
        validator: view.validator,
        ...(timeoutMs === undefined ? {} : { validatorTimeoutMs: timeoutMs }),
      }),
    );
    if (validation.elapsed) return undefined;
    const result = validation.value;
    const reread = yield* ctx.run(activities.loadGoalState, { goalRunId: view.goalRunId });
    const fresh = reread.view;
    if (
      fresh === undefined ||
      fresh.cancellation !== undefined ||
      fresh.status !== 'evaluating' ||
      fresh.transitionSeq !== view.transitionSeq
    ) {
      return undefined;
    }
    // A verdict that arrives once the duration is spent is not applied: the
    // bound is enforced here as it is at every other decision point.
    if (isDeadlineElapsed(fresh, reread.nowMs)) {
      return yield* finishForced(ctx, fresh, reread.nowMs, decideDurationElapsed());
    }
    const decision = decideOutcome(decisionContextFor(fresh, reread.nowMs), {
      outcome: result.outcome,
      inputFeedback: goalInputFeedbackFor(fresh.attempts, attempt.attemptIndex),
      operatorAborted: false,
    });
    return yield* commit(
      ctx,
      buildValidationDecision(fresh, identifiers, reread.nowMs, attempt, result, decision),
    );
  }

  function* advance(ctx: GoalContext, view: GoalWorkflowView, nowMs: number): Segment {
    if (view.cancellation !== undefined) {
      return yield* finishForced(ctx, view, nowMs, decideCancellation());
    }
    if (isDeadlineElapsed(view, nowMs)) {
      return yield* finishForced(ctx, view, nowMs, decideDurationElapsed());
    }
    switch (view.status) {
      case 'running':
        return yield* awaitAttempt(ctx, view, nowMs);
      case 'evaluating':
        return yield* validate(ctx, view, nowMs);
      default:
        return yield* openAttempt(ctx, view, nowMs);
    }
  }

  return (
    workflow({ name: GOAL_WORKFLOW_TYPE, finalizer: activities.finalizeGoal })
      // eslint-disable-next-line @typescript-eslint/require-await -- Weft durable generator: async work flows through yield*, not a top-level await.
      .execute(async function* (
        ctx,
        input: GoalWorkflowInput,
      ): AsyncGenerator<unknown, GoalWorkflowResult> {
        const { goalRunId } = input;
        let consecutiveRefusals = 0;
        let consecutiveIdleWakes = 0;
        for (;;) {
          const { view, nowMs } = yield* ctx.run(activities.loadGoalState, { goalRunId });
          if (view === undefined) return recordUnavailable(goalRunId);
          if (isTerminalStatus(view.status)) return terminalResult(view);
          // Stage what the finalizer needs, last write wins: the run a hard
          // cancel from here on must stop. It is committed with the next
          // checkpoint, and the replay of a recovered workflow re-stages it
          // from the same recorded read, so it is never a durable slot.
          ctx.setFinalizerState(runToStop(view));

          const committed = yield* advance(ctx, view, nowMs);
          if (committed === undefined) {
            consecutiveIdleWakes += 1;
            if (consecutiveIdleWakes >= MAXIMUM_CONSECUTIVE_IDLE_WAKES) {
              throw new GoalControllerError(
                `Goal "${goalRunId}" woke ${consecutiveIdleWakes} times in a row without anything to do.`,
              );
            }
            continue;
          }
          consecutiveIdleWakes = 0;
          if (committed.status === 'missing' || committed.status === 'corrupt') {
            return recordUnavailable(goalRunId);
          }
          if (committed.status === 'rejected' && !ADOPTABLE_REJECTIONS.includes(committed.reason)) {
            throw new GoalControllerError(
              `Goal "${goalRunId}" transition ${view.transitionSeq + 1} was rejected: ${committed.reason}.`,
            );
          }
          consecutiveRefusals = isRefusal(committed) ? consecutiveRefusals + 1 : 0;
          if (consecutiveRefusals >= MAXIMUM_CONSECUTIVE_REFUSALS) {
            throw new GoalControllerError(
              `Goal "${goalRunId}" transition ${view.transitionSeq + 1} was refused ${consecutiveRefusals} times in a row.`,
            );
          }
        }
      })
  );
}
