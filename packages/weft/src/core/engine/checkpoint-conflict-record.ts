import type { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import type { EngineInternals } from './internals.ts';
import { loadWorkflowState } from './storage-io.ts';

/**
 * What this engine remembers about a workflow it abandoned after losing a
 * checkpoint compare-and-swap race: the error, and the identity of the lost
 * generation. `workflowExecutionToken` is the durable token of the run the
 * engine was driving, read before its in-memory state was released. It scopes
 * the loss to that run, because the winning engine can finish it and start a
 * different run under the same workflow id (`onTerminalConflict: 'start-new'`)
 * without this engine ever seeing it.
 */
export interface CheckpointConflictRecord {
  readonly error: WorkflowCheckpointConflictError;
  readonly workflowExecutionToken: string | undefined;
}

/**
 * Drop the recorded loss for a workflow this engine is about to drive again, and
 * evict its cached handle when there was one.
 *
 * `WorkflowHandle.result()` memoizes its promise, and abandonment settled that
 * promise with the conflict, so a handle that already observed the loss would
 * keep rejecting even after the resumed run completes. Evicting it means the
 * next `getHandle()` (which the resume path returns) builds a handle that
 * observes the resumed run. A handle object the caller still holds keeps
 * reporting the loss it already saw; the handle returned by the resume reports
 * the resumed run's outcome.
 */
export function clearCheckpointConflictForResume(
  internals: EngineInternals,
  workflowId: string,
): void {
  if (!internals.checkpointConflicts.delete(workflowId)) return;
  const entry = internals.handleCache.get(workflowId);
  if (entry === undefined) return;
  internals.finalizationRegistry.unregister(entry.unregisterToken);
  internals.handleCache.delete(workflowId);
}

/**
 * Settle `result()` for a workflow with a recorded loss: reject with the loss
 * only while storage still identifies the lost run, otherwise drop the stale
 * record and resolve through `resolveCurrent` (the ordinary result path).
 */
export async function resultAfterCheckpointConflict(
  internals: EngineInternals,
  workflowId: string,
  conflict: CheckpointConflictRecord,
  resolveCurrent: () => Promise<unknown>,
): Promise<unknown> {
  let lostRunStillCurrent: boolean;
  try {
    const state = await loadWorkflowState(internals, workflowId);
    lostRunStillCurrent = state?.workflowExecutionToken === conflict.workflowExecutionToken;
  } catch {
    // An unreadable store cannot show a replacement run, so keep reporting the loss.
    lostRunStillCurrent = true;
  }
  const recorded = internals.checkpointConflicts.get(workflowId);
  if (recorded === conflict && lostRunStillCurrent) throw conflict.error;
  // The record was superseded while reading (a local resume or launch cleared
  // it), or storage holds a different run: the loss no longer applies. Drop a
  // record that is still ours, then resolve against whatever is current.
  if (recorded === conflict) internals.checkpointConflicts.delete(workflowId);
  return resolveCurrent();
}

/**
 * Whether `state` is the durable run this engine abandoned after losing its
 * checkpoint compare-and-swap race, so a terminal write over it must be skipped.
 */
export function isAbandonedGeneration(
  internals: EngineInternals,
  workflowId: string,
  state: { readonly workflowExecutionToken?: string | undefined },
): boolean {
  const conflict = internals.checkpointConflicts.get(workflowId);
  return conflict !== undefined && conflict.workflowExecutionToken === state.workflowExecutionToken;
}
