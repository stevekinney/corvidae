/**
 * COR-851 — the Weft activities behind the `goalRun` workflow.
 *
 * Each activity is a thin, idempotent wrapper over one port. The workflow body
 * never calls a port directly: every effect goes through `ctx.run`, so its
 * result is recorded once and replayed from history afterwards.
 */

import { activity } from '@lostgradient/weft';

import type { ProjectedValidatorResult } from '../goal-decision';
import type {
  GoalWorkflowAbortRequest,
  GoalWorkflowCommit,
  GoalWorkflowPorts,
  GoalWorkflowRecord,
  GoalWorkflowStart,
  GoalWorkflowStartRequest,
  GoalWorkflowTransition,
  GoalWorkflowValidatorRequest,
  GoalWorkflowView,
} from './goal-workflow-ports';

export interface GoalWorkflowLoadResult {
  /** `undefined` when the record is missing or unreadable. */
  readonly view: GoalWorkflowView | undefined;
  readonly nowMs: number;
}

/**
 * Built field by field. `GoalState` satisfies `GoalWorkflowRecord` structurally
 * and carries far more at runtime (the objective, the conversation policy and
 * its artifact, the principal, the audit log), and every load is cached in the
 * workflow's history, so a spread would copy all of it on every load.
 */
export function toGoalWorkflowView(record: GoalWorkflowRecord): GoalWorkflowView {
  return {
    goalRunId: record.goalRunId,
    status: record.status,
    transitionSeq: record.transitionSeq,
    validator: record.validator,
    ...(record.validatorTimeoutMs === undefined
      ? {}
      : { validatorTimeoutMs: record.validatorTimeoutMs }),
    bounds: record.bounds,
    ...(record.retryPolicy === undefined ? {} : { retryPolicy: record.retryPolicy }),
    attempts: record.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      attemptIndex: attempt.attemptIndex,
      runId: attempt.runId,
      sessionId: attempt.sessionId,
      startedAt: attempt.startedAt,
      ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt }),
      ...(attempt.finishReason === undefined ? {} : { finishReason: attempt.finishReason }),
      ...(attempt.feedback === undefined ? {} : { feedback: attempt.feedback }),
      usage: attempt.usage,
      status: attempt.status,
    })),
    usage: record.usage,
    ...(record.active === undefined ? {} : { active: record.active }),
    ...(record.cancellation === undefined
      ? {}
      : { cancellation: { requestedAt: record.cancellation.requestedAt } }),
    ...(record.terminalReason === undefined ? {} : { terminalReason: record.terminalReason }),
    ...(record.failureDetail === undefined ? {} : { failureDetail: record.failureDetail }),
    createdAt: record.createdAt,
  };
}

export function createGoalWorkflowActivities(ports: GoalWorkflowPorts) {
  return {
    loadGoalState: activity({
      name: 'loadGoalState',
      idempotent: true,
      execute: async (input: { goalRunId: string }): Promise<GoalWorkflowLoadResult> => {
        const { record, nowMs } = await ports.loadGoalState(input.goalRunId);
        return { view: record === undefined ? undefined : toGoalWorkflowView(record), nowMs };
      },
    }),

    commitTransition: activity({
      name: 'commitTransition',
      idempotent: true,
      execute: (input: GoalWorkflowTransition): Promise<GoalWorkflowCommit> =>
        ports.commitTransition(input),
    }),

    startAttempt: activity({
      name: 'startAttempt',
      idempotent: true,
      execute: (input: GoalWorkflowStartRequest): Promise<GoalWorkflowStart> =>
        ports.startAttempt(input),
    }),

    runValidator: activity({
      name: 'runValidator',
      idempotent: true,
      execute: (input: GoalWorkflowValidatorRequest): Promise<ProjectedValidatorResult> =>
        ports.runValidator(input),
    }),

    abortAttempt: activity({
      name: 'abortAttempt',
      idempotent: true,
      execute: (input: GoalWorkflowAbortRequest): Promise<void> => ports.abortAttempt(input),
    }),
  };
}

export type GoalWorkflowActivities = ReturnType<typeof createGoalWorkflowActivities>;
