import type { Checkpoint } from '../../types.ts';
import { adoptLaunchCheckpoint, releaseLaunchCheckpoint } from '../checkpoint-commit-snapshots.ts';
import type { EngineInternals } from '../internals.ts';
import {
  forgetSeededCleanupMembership,
  forgetSeededServices,
} from '../scheduled-seed-ownership.ts';

/**
 * What one start or prepare installs in memory for its workflow id, and how to undo it.
 *
 * Until `adopt` has run, the start has installed nothing of its own, so whatever the
 * engine holds under the id belongs to a live run: its execution attempt, checkpoint,
 * committed bytes, headers, version tuple, services, and terminal-cleanup membership.
 * A start rejected that early (a duplicate id, an unregistered type, an oversized input)
 * must leave all of it alone, and `rollback` does nothing then. After `adopt`, the
 * checkpoint under the id is this start's, and `rollback` removes everything a failed
 * launch left behind. `adopt` also ends the claim of any scheduled seed still waiting to be
 * released for the id (see `scheduled-seed-ownership.ts`), so a start that goes on to
 * succeed cannot have its services or its cleanup membership removed by that release.
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
      releaseLaunchCheckpoint(internals, workflowId);
      internals.workflowHeaders.delete(workflowId);
      internals.workflowVersionTuples.delete(workflowId);
      internals.workflowServices.delete(workflowId);
      forgetSeededServices(internals, workflowId);
      internals.workflowsNeedingTerminalCleanup.delete(workflowId);
      forgetSeededCleanupMembership(internals, workflowId);
    },
  };
}
