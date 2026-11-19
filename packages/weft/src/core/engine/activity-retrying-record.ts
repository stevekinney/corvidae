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
import type { WorkflowRetrying } from '../types.ts';
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
  nextLocals: Record<string, unknown> | undefined,
): BatchOperation[] {
  const previous = readRetryingActivity(internals.checkpoints.get(workflowId)?.locals);
  const next = readRetryingActivity(nextLocals);
  if (sameRetrying(previous, next)) return [];
  const key = KEYS.activityRetrying(workflowId);
  return next === undefined
    ? [{ type: 'delete', key }]
    : [{ type: 'put', key, value: encode(next) }];
}

/** The decoded record, or `undefined` when it is absent or not the shape the engine writes. */
export function decodeActivityRetrying(bytes: Uint8Array | null): WorkflowRetrying | undefined {
  if (bytes === null) return undefined;
  const value: unknown = decode(bytes);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { activity, attempt } = value as Record<string, unknown>;
  if (typeof activity !== 'string' || activity.length === 0) return undefined;
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 2)
    return undefined;
  return { activity, attempt };
}
