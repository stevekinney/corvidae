/**
 * Retrying an instance of a workflow file from the step it failed at (COR-2424): the pure half.
 * Which step a failed instance failed at, read from the engine's timeline, whether that step can
 * run again in the same instance, and the refusal a request gets when it cannot.
 *
 * A retry resumes the instance in place from its checkpoint (`engine.retryFailed`): the step that
 * failed runs again, and every step before it is replayed from the checkpoint and never runs
 * again. So the step a request names is only checked against the step the instance failed at; it
 * never moves where the instance resumes.
 *
 * @module workflow-run-retry
 */

import type { WorkflowTimelineEntry } from '@lostgradient/weft';

import { workflowFileStepsInCanonicalOrder, type WorkflowFileStep } from './workflow-file';

/**
 * Why a retry was refused. Each is a state of the instance or its workflow, never of the caller's
 * access, which is answered as a run that does not exist.
 *
 * - `run-not-failed`: the instance is not `failed` (a retry already running it again included).
 * - `step-not-found`: the step is not a step of the version the instance ran.
 * - `earlier-steps-incomplete`: the step comes after the step the instance failed at, so a step
 *   before it never completed.
 * - `step-completed`: the step comes before the step the instance failed at; it completed, and a
 *   retry never runs a completed step again.
 * - `step-not-retryable`: the instance failed outside a step (its input or result broke the
 *   workflow's schema), or at a step that would only fail the same way again: a person's rejection
 *   at a review, a `workflow` step (its child run is found again by its id, and failed), or a step
 *   inside a `parallel`.
 * - `no-checkpoint`: the engine kept nothing to resume the instance from, so a retry would run
 *   every step again.
 * - `version-unavailable`: the version the instance ran is no longer stored, or pins an activity
 *   or a code workflow at a version that is not loaded, so it cannot run on it again.
 */
export type WorkflowRetryRefusal =
  | 'run-not-failed'
  | 'step-not-found'
  | 'earlier-steps-incomplete'
  | 'step-completed'
  | 'step-not-retryable'
  | 'no-checkpoint'
  | 'version-unavailable';

/** A retry the instance's state refused. Nothing was changed. */
export class WorkflowRetryRefusedError extends Error {
  /** The reason the run could not be retried. */
  readonly code: WorkflowRetryRefusal;
  /** The run that was left in its prior state. */
  readonly runId: string;
  constructor(code: WorkflowRetryRefusal, runId: string, message: string) {
    super(message);
    this.name = 'WorkflowRetryRefusedError';
    this.code = code;
    this.runId = runId;
  }
}

/** What {@link BureauWorkflows.retryRun} answers: the instance is running again from `step`. */
export interface WorkflowRetryResult {
  /** The run that resumed from the requested step. */
  readonly runId: string;
  /** The step that runs again, counted from 1. */
  readonly step: number;
  /** The Weft revision the instance runs on: the one it began on. */
  readonly workflowVersion: string;
  /** The request's own identifier, or `null` when it gave none. */
  readonly retryId: string | null;
}

/** What a caller asks a retry for. */
export interface WorkflowRetryOptions {
  /** The step to run again, counted from 1: it must be the step the instance failed at. */
  readonly step: number;
  /**
   * The caller's identifier of this request. A request repeated with it answers what the first
   * did, and finishes it when the first stopped partway, instead of being refused because the
   * instance is running again.
   */
  readonly retryId?: string | undefined;
}

/** The longest `retryId`, in characters. */
export const WORKFLOW_RETRY_ID_MAXIMUM_LENGTH = 128;

/**
 * The step a failed instance failed at, counted from 0 in the canonical order, read from the last
 * entry of its timeline that failed and that no later entry of the same step completed: its own
 * document step, or, for an operation that ran branches, its last rejected branch's. A try of a
 * step that failed and was then tried again and succeeded is not where the instance failed.
 * `undefined` when no such entry names a step: the instance failed outside one.
 */
export function failedStepIndexOf(timeline: readonly WorkflowTimelineEntry[]): number | undefined {
  const position = timeline.findLastIndex(
    (entry, index) =>
      entry.status === 'failed' &&
      !timeline
        .slice(index + 1)
        .some((later) => later.status === 'completed' && later.documentStep === entry.documentStep),
  );
  const failed = position === -1 ? undefined : timeline[position];
  if (failed === undefined) return undefined;
  if (failed.documentStep !== undefined) return failed.documentStep;
  const branch = (failed.branches ?? []).findLast(
    (candidate) => candidate.outcome === 'rejected' && candidate.documentStep !== undefined,
  );
  return branch?.documentStep;
}

/**
 * Whether the step at `index` (from 0, canonical order) of `steps` can run again in place: an
 * `activity` step that is not inside a `parallel`. A `workflow` step's child keeps its id, so it
 * would be found again and fail the step again; a `parallel`'s branches are not proved to replay.
 */
export function isRetryableStep(steps: readonly WorkflowFileStep[], index: number): boolean {
  const ordered = workflowFileStepsInCanonicalOrder(steps);
  const entry = ordered[index];
  if (entry === undefined) return false;
  if (entry.step['kind'] !== 'activity' || entry.path.includes('.branches.')) return false;
  // A map that runs items together settles them in one round, and a retry replays that round: an
  // item that had completed would run again. Only a map that runs one item at a time resumes at the
  // item that failed (checked by `document-retry-failed.test.ts` in Weft).
  for (
    let at = entry.path.indexOf('.steps');
    at !== -1;
    at = entry.path.indexOf('.steps', at + 1)
  ) {
    const map = ordered.find((candidate) => candidate.path === entry.path.slice(0, at));
    if (map?.step['kind'] === 'map' && map.step['concurrency'] !== 1) return false;
  }
  return true;
}

/** How many steps `steps` has, counted as the engine counts them. */
export function canonicalStepCount(steps: readonly WorkflowFileStep[]): number {
  return workflowFileStepsInCanonicalOrder(steps).length;
}
