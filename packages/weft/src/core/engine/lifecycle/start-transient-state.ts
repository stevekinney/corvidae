import type { Checkpoint } from '../../types.ts';
import {
  adoptLaunchCheckpoint,
  forgetCommittedCheckpointBytes,
} from '../checkpoint-commit-snapshots.ts';
import type { EngineInternals } from '../internals.ts';

/**
 * What one start or prepare installs in memory for its workflow id, and how to undo it.
 *
 * Until `adopt` has run, the start has installed nothing of its own, so whatever the
 * engine holds under the id belongs to a live run: its execution attempt, checkpoint,
 * committed bytes, headers, version tuple, services, and terminal-cleanup membership.
 * A start rejected that early (a duplicate id, an unregistered type, an oversized input)
 * must leave all of it alone, and `rollback` does nothing then. After `adopt`, the
 * checkpoint under the id is this start's, and `rollback` removes everything a failed
 * launch left behind.
 */
export type LaunchAdoption = {
  /** Install `checkpoint` as the launch checkpoint of this start, and prime its committed bytes. */
  adopt(checkpoint: Checkpoint, serialized: Uint8Array): void;
  /** Undo what `adopt` installed; a no-op for a start that has not adopted a checkpoint. */
  rollback(): void;
};

export function createLaunchAdoption(
  internals: EngineInternals,
  workflowId: string,
): LaunchAdoption {
  let adopted = false;
  return {
    adopt(checkpoint, serialized) {
      adoptLaunchCheckpoint(internals, workflowId, checkpoint, serialized);
      adopted = true;
    },
    rollback() {
      if (!adopted) return;
      forgetCommittedCheckpointBytes(internals, workflowId);
      internals.checkpoints.delete(workflowId);
      internals.workflowHeaders.delete(workflowId);
      internals.workflowVersionTuples.delete(workflowId);
      internals.workflowServices.delete(workflowId);
      internals.workflowsNeedingTerminalCleanup.delete(workflowId);
    },
  };
}
