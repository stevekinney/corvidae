/**
 * The `wf:{id}:retrying` record behind `WorkflowSummary.retrying` (COR-2529): which activity a
 * running workflow is retrying and on which attempt, kept in a small record of its own so a list
 * answers it without loading a checkpoint.
 *
 * It is derived at the checkpoint commit, never written by the retry loop: the retry decision
 * already lives in the checkpoint's locals (`activity-retry-state.ts`) and commits with the
 * checkpoint at the backoff sleep, so the record changes in that same batch and no attempt adds a
 * write of its own. The commit compares the retrying activity its checkpoint shows with the one
 * the previous committed checkpoint showed and adds an operation only when they differ, which
 * covers every way an activity settles and every way a run resumes.
 *
 * @module core/engine/activity-retrying-record
 */
import type { BatchOperation } from '@lostgradient/storage';
import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import { readRetryingActivity } from '../context/activity-retry-state.ts';
import type { Checkpoint, WorkflowRetrying } from '../types.ts';
import type { EngineInternals } from './internals.ts';

function sameRetrying(
  left: WorkflowRetrying | undefined,
  right: WorkflowRetrying | undefined,
): boolean {
  return left?.activity === right?.activity && left?.attempt === right?.attempt;
}

/**
 * The operation that moves the record from what the previous committed checkpoint shows to what
 * `nextLocals` shows: a put for an activity now retrying, a delete once none is, and nothing when
 * the two agree. A run this engine holds no checkpoint for (a fresh start) shows nothing before.
 */
export function buildActivityRetryingOperations(
  internals: EngineInternals,
  workflowId: string,
  nextCheckpoint: Pick<Checkpoint, 'locals' | 'workflowExecutionToken'>,
): BatchOperation[] {
  const previous = readRetryingActivity(internals.checkpoints.get(workflowId)?.locals);
  const next = readRetryingActivity(nextCheckpoint.locals);
  if (sameRetrying(previous, next)) return [];
  const key = KEYS.activityRetrying(workflowId);
  if (next === undefined) return [{ type: 'delete', key }];
  // The record names the run it belongs to: a run that ends while retrying leaves it behind (no
  // checkpoint commits after the failure), and a `start-new` replacement under the same id must
  // not read the run before it as its own.
  const record: ActivityRetryingRecord = {
    ...next,
    ...(nextCheckpoint.workflowExecutionToken === undefined
      ? {}
      : { workflowExecutionToken: nextCheckpoint.workflowExecutionToken }),
  };
  return [{ type: 'put', key, value: encode(record) }];
}

/** What the `wf:{id}:retrying` record holds: the retrying activity and the run it belongs to. */
type ActivityRetryingRecord = WorkflowRetrying & { workflowExecutionToken?: string };

/**
 * The decoded record when it belongs to the run with `workflowExecutionToken`, and `undefined` when
 * it is absent, not the shape the engine writes, or left by another run under the same id.
 */
export function decodeActivityRetrying(
  bytes: Uint8Array | null,
  workflowExecutionToken: string | undefined,
): WorkflowRetrying | undefined {
  if (bytes === null) return undefined;
  const value: unknown = decode(bytes);
  if (!isRecord(value)) return undefined;
  if (value['workflowExecutionToken'] !== workflowExecutionToken) return undefined;
  const { activity, attempt } = value;
  if (typeof activity !== 'string' || activity.length === 0) return undefined;
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 2) {
    return undefined;
  }
  return { activity, attempt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
