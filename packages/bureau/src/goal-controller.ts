/**
 * COR-851 — what the control plane does to a goal's controller workflow and to
 * the record underneath it, shared by `create`, `cancel`, and `recover`.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  buildGoalForcedFinish,
  decideCancellation,
  decideDeterminismRequirement,
  GOAL_WORKFLOW_TYPE,
  type GoalWorkflowAbortRequest,
  type GoalWorkflowPorts,
} from '@lostgradient/operative';
import { WorkflowAlreadyExistsError } from '@lostgradient/weft';

import type { AttemptForwarder } from './goal-forwarder';
import { goalIdentifiers } from './goal-ports';
import { type GoalState, goalWorkflowId } from './goal-state';
import type { GoalStore, GoalTransitionResult } from './goal-store';
import type { BureauGoalControllerStart, GoalEngine } from './goal-types';
import type { GoalValidatorCatalog } from './goal-validator-catalog';
import type { CancelDurableRunOutcome, DiagnosticSink } from './types';

/** What the control plane's operations share. */
export interface GoalControlDependencies {
  readonly store: GoalStore;
  /** What the goal's validator promises, for the requirement a goal states about it. */
  readonly catalog: Pick<GoalValidatorCatalog, 'resolve'>;
  readonly clock: Pick<RuntimeServices['clock'], 'now' | 'nowISO'>;
  readonly diagnose: DiagnosticSink;
  readonly getEngine: () => GoalEngine | undefined;
  readonly cancelRun: (runId: string) => Promise<CancelDurableRunOutcome>;
  readonly forwarder: AttemptForwarder;
  /** The same start-or-adopt the controller's activity uses, for a recovery that must start a run itself. */
  readonly startAttempt: GoalWorkflowPorts['startAttempt'];
  readonly isClosing: () => boolean;
}

/** Weft's own statuses for a workflow that has stopped for good. */
export const TERMINAL_CONTROLLER_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

/**
 * Starts the goal's controller under its stable id. With `replaceTerminal`, a
 * controller that already ended is replaced by a fresh one that resumes from
 * the record; a live one is never displaced.
 */
export async function startController(
  engine: GoalEngine,
  goalRunId: string,
  replaceTerminal: boolean,
): Promise<'started' | 'exists'> {
  try {
    await engine.start(
      GOAL_WORKFLOW_TYPE,
      { goalRunId },
      {
        id: goalWorkflowId(goalRunId),
        ...(replaceTerminal ? { onTerminalConflict: 'start-new' as const } : {}),
      },
    );
    return 'started';
  } catch (error) {
    if (error instanceof WorkflowAlreadyExistsError) return 'exists';
    throw error;
  }
}

/**
 * The attempt whose run a cancellation, or an elapsed duration bound, must stop:
 * the one in flight, or else the next one, because a start that died just short
 * of its commit leaves an orphan run under the next attempt's deterministic id.
 * Stopping a run that never existed is a no-op.
 */
export function attemptToStop(record: GoalState): GoalWorkflowAbortRequest {
  const last = record.attempts.at(-1);
  const attemptIndex =
    last !== undefined && (last.status === 'running' || last.status === 'evaluating')
      ? last.attemptIndex
      : record.attempts.length;
  return {
    goalRunId: record.goalRunId,
    attemptIndex,
    attemptId: goalIdentifiers.attemptId(record.goalRunId, attemptIndex),
    runId: goalIdentifiers.attemptRunId(record.goalRunId, attemptIndex),
  };
}

/**
 * Commits `canceled` for a goal whose cancellation marker is set, from the
 * record's own current state and with the same builder the controller uses.
 * The host does this when the controller can no longer: `engine.cancel` ends a
 * workflow mid-flight, so nothing inside it is left to commit the transition. A
 * controller that commits the same transition first makes this a `duplicate`.
 */
export async function commitCancellation(
  store: GoalStore,
  record: GoalState,
  nowMs: number,
): Promise<GoalTransitionResult | { readonly status: 'not-needed' }> {
  if (record.status === 'canceled') return { status: 'not-needed' };
  return store.applyTransition(
    buildGoalForcedFinish(record, goalIdentifiers, nowMs, decideCancellation()),
  );
}

/**
 * COR-638: a validator that cannot supply the evidence a goal demands ends it
 * `failed`/`unsupported-validation` before any attempt runs. The check belongs
 * wherever a controller is about to be started, not only where a goal is
 * created: a process can die between writing the record and ending it, and the
 * catalog's descriptor can change in between.
 *
 * Applies only to a goal nothing has happened to yet (`pending`, transition 0).
 * Returns the ended record, or `undefined` when the goal may run. A validator
 * the catalog no longer holds is not this check's business; the attempt's own
 * validation reports that.
 */
export async function enforceDeterminism(
  dependencies: Pick<GoalControlDependencies, 'store' | 'catalog' | 'clock'>,
  record: GoalState,
): Promise<GoalState | undefined> {
  if (record.status !== 'pending' || record.transitionSeq !== 0) return undefined;
  const resolution = dependencies.catalog.resolve(record.validator);
  if (!resolution.ok) return undefined;
  const unsupported = decideDeterminismRequirement(
    record.requireDeterministicValidation,
    resolution.entry.descriptor.determinism,
  );
  if (unsupported?.kind !== 'fail') return undefined;
  const ended = await dependencies.store.applyTransition({
    goalRunId: record.goalRunId,
    seq: 1,
    transitionId: goalIdentifiers.transitionId(record.goalRunId, 1),
    to: 'failed',
    at: dependencies.clock.nowISO(),
    cause: `fail: ${unsupported.reason}`,
    terminalReason: unsupported.reason,
    ...(unsupported.failureDetail === undefined
      ? {}
      : { failureDetail: unsupported.failureDetail }),
  });
  return ended.status === 'applied' || ended.status === 'duplicate' ? ended.record : undefined;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Makes sure a goal that is not terminal has its controller: ends it first when
 * its validator cannot supply what it requires, then starts the controller
 * under its stable id (a controller that already exists is left alone). Shared
 * by a new goal and by a repeated `create` for one whose first call died
 * between recording it and starting it.
 */
export async function ensureController(
  dependencies: Pick<
    GoalControlDependencies,
    'store' | 'catalog' | 'clock' | 'diagnose' | 'getEngine'
  >,
  record: GoalState,
): Promise<{ readonly goal: GoalState; readonly controller: BureauGoalControllerStart }> {
  const ended = await enforceDeterminism(dependencies, record);
  if (ended !== undefined) return { goal: ended, controller: { status: 'not-needed' } };
  const engine = dependencies.getEngine();
  if (engine === undefined) {
    return {
      goal: record,
      controller: {
        status: 'start-failed',
        reason: 'There is no durable engine to run a controller.',
      },
    };
  }
  try {
    await startController(engine, record.goalRunId, false);
    return { goal: record, controller: { status: 'started' } };
  } catch (error) {
    dependencies.diagnose({
      level: 'error',
      scope: 'goals',
      message: `[bureau] Goal "${record.goalRunId}" was recorded but its controller did not start; recover() starts it: ${describeError(error)}`,
      cause: error,
    });
    return { goal: record, controller: { status: 'start-failed', reason: describeError(error) } };
  }
}
