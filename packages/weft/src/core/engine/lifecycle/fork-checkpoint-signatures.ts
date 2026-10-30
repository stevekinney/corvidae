import type { Checkpoint } from '../../types.ts';

/**
 * The replay signatures a fork keeps: those of steps with a cached outcome. The source's pending
 * signature shows that the SOURCE reached that operation. A worker reads a signature at the step it
 * is about to run as proof that an earlier execution of this run already logged what sits in front,
 * so a fork that kept it would deliver its own first lines marked `replayed` and the log store would
 * skip them. Without it, the fork's first turn pins its own signature, as any first turn does, and a
 * recovery after that turn is a relaunch of the fork's own execution.
 */
export function signaturesOfSettledSteps(
  checkpoint: Checkpoint,
): NonNullable<Checkpoint['workerReplaySignatures']> {
  const settledSteps = new Set(
    [...checkpoint.accumulatedResults, ...(checkpoint.workerReplayFailures ?? [])].map(
      ([step]) => step,
    ),
  );
  return (checkpoint.workerReplaySignatures ?? []).filter(([step]) => settledSteps.has(step));
}
