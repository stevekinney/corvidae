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

function toView(record: GoalWorkflowRecord): GoalWorkflowView {
  return {
    ...record,
    attempts: record.attempts.map(({ validation: _validation, ...attempt }) => attempt),
  };
}

export function createGoalWorkflowActivities(ports: GoalWorkflowPorts) {
  return {
    loadGoalState: activity({
      name: 'loadGoalState',
      idempotent: true,
      execute: async (input: { goalRunId: string }): Promise<GoalWorkflowLoadResult> => {
        const { record, nowMs } = await ports.loadGoalState(input.goalRunId);
        return { view: record === undefined ? undefined : toView(record), nowMs };
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
