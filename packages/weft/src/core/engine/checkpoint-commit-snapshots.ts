import type { Checkpoint } from '../types.ts';
import { forgetAbandonedCheckpointGeneration } from './abandoned-checkpoint-generations.ts';
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

export function forgetCommittedCheckpointBytes(
  internals: EngineInternals,
  workflowId: string,
): void {
  committedCheckpointBytes.get(internals)?.delete(workflowId);
}

/**
 * Install `checkpoint` as the in-memory checkpoint of a workflow this engine is
 * launching (start, resume, fork, delayed-start fire), clearing any recorded
 * abandoned-generation marker for that same generation: the engine drives it
 * again, so an earlier loss no longer applies to it. With `serialized`, also
 * primes the checkpoint-bytes compare-and-swap baseline from those committed
 * bytes.
 */
export function adoptLaunchCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  checkpoint: Checkpoint,
  serialized?: Uint8Array,
): void {
  internals.checkpoints.set(workflowId, checkpoint);
  forgetAbandonedCheckpointGeneration(internals, workflowId, checkpoint.workflowExecutionToken);
  if (serialized !== undefined) rememberCommittedCheckpointBytes(internals, workflowId, serialized);
}
