import type { Checkpoint } from '../types.ts';
import { forgetAbandonedCheckpointGeneration } from './abandoned-checkpoint-generations.ts';
import { beginExecutionAttempt, forgetExecutionAttempt } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';

const committedCheckpointBytes = new WeakMap<EngineInternals, Map<string, Uint8Array>>();

export function rememberCommittedCheckpointBytes(
  internals: EngineInternals,
  workflowId: string,
  serialized: Uint8Array,
): void {
  let bytesByWorkflowId = committedCheckpointBytes.get(internals);
  if (!bytesByWorkflowId) {
    bytesByWorkflowId = new Map();
    committedCheckpointBytes.set(internals, bytesByWorkflowId);
  }
  bytesByWorkflowId.set(workflowId, new Uint8Array(serialized));
}

export function getCommittedCheckpointBytes(
  internals: EngineInternals,
  workflowId: string,
): Uint8Array | undefined {
  const committedBytes = committedCheckpointBytes.get(internals)?.get(workflowId);
  return committedBytes ? new Uint8Array(committedBytes) : undefined;
}

/**
 * Forget the committed checkpoint bytes, and the execution attempt that wrote them, for
 * a workflow whose in-memory checkpoint the engine is dropping for good.
 */
export function forgetCommittedCheckpointBytes(
  internals: EngineInternals,
  workflowId: string,
): void {
  committedCheckpointBytes.get(internals)?.delete(workflowId);
  forgetExecutionAttempt(internals, workflowId);
}

/**
 * Install `checkpoint` as the in-memory checkpoint of a workflow this engine is
 * launching (start, resume, fork, delayed-start fire), beginning a new execution
 * attempt and clearing any recorded abandoned-generation marker for that same
 * generation: the engine drives it again, so an earlier loss no longer applies to
 * it, and work still in flight from the earlier attempt is recognized as stale by
 * its attempt instead. With `serialized`, also primes the checkpoint-bytes
 * compare-and-swap baseline from those committed bytes.
 */
export function adoptLaunchCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  checkpoint: Checkpoint,
  serialized?: Uint8Array,
): void {
  internals.checkpoints.set(workflowId, checkpoint);
  beginExecutionAttempt(internals, workflowId);
  forgetAbandonedCheckpointGeneration(internals, workflowId, checkpoint.workflowExecutionToken);
  if (serialized !== undefined) rememberCommittedCheckpointBytes(internals, workflowId, serialized);
}
