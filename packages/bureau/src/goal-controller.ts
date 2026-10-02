/**
 * COR-851 — what the control plane does to a goal's controller workflow and to
 * the record underneath it, shared by `create`, `cancel`, and `recover`.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  buildGoalForcedFinish,
  decideCancellation,
  GOAL_WORKFLOW_TYPE,
  type GoalWorkflowAbortRequest,
  type GoalWorkflowPorts,
} from '@lostgradient/operative';
import { WorkflowAlreadyExistsError } from '@lostgradient/weft';

import type { AttemptForwarder } from './goal-forwarder';
import { goalIdentifiers } from './goal-ports';
import { type GoalState, goalWorkflowId } from './goal-state';
import type { GoalStore, GoalTransitionResult } from './goal-store';
import type { GoalEngine } from './goal-types';
import type { CancelDurableRunOutcome, DiagnosticSink } from './types';

/** What the control plane's operations share. */
export interface GoalControlDependencies {
  readonly store: GoalStore;
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
