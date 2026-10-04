import type { WorkflowState } from '../types.ts';
import { isCheckpointGenerationAbandoned } from './abandoned-checkpoint-generations.ts';
import type { EngineInternals } from './internals.ts';

/**
 * One launch of a workflow id by this engine: a start, resume, recovery, fork, or
 * delayed-start fire that adopts a checkpoint (see `adoptLaunchCheckpoint`).
 *
 * A generation's execution token cannot tell two launches of the same stored
 * generation apart, and a pre-token run has no token to begin with, so work that is
 * still in flight from an earlier launch needs an identity of its own to be recognized
 * once the engine has launched the id again. The attempt is that identity. Checkpoint
 * commits within one launch replace the in-memory checkpoint object many times, so the
 * attempt is held beside it rather than read off it.
 *
 * The attempt also records the execution token of the generation it launched (none for a
 * run recovered from before tokens existed). That is what keeps a suspended workflow's
 * generation identifiable once suspension has released its checkpoint: a checkpoint
 * commit still in flight from before the suspend is judged by it, since the in-memory
 * checkpoint it would otherwise be compared with is gone.
 *
 * Held beside the engine rather than on `EngineInternals`, like the committed
 * checkpoint bytes in `checkpoint-commit-snapshots.ts`, and with the same lifecycle:
 * `forgetCommittedCheckpointBytes` retires it wherever the engine stops holding the
 * checkpoint for good (terminal cleanup, purge, and rollback of a launch that adopted its
 * checkpoint and did not complete). A launch rejected before it adopted one retires
 * nothing, because the attempt under that id is a live run's. A suspended workflow keeps
 * its entry until it is resumed, which adopts a new one: it is the one case where the
 * engine holds an attempt and no checkpoint.
 */
export type ExecutionAttempt = symbol;

type ExecutionAttemptRecord = {
  readonly attempt: ExecutionAttempt;
  /** Token of the generation this attempt launched; `undefined` for a pre-token run. */
  readonly workflowExecutionToken: string | undefined;
};

const attemptsByEngine = new WeakMap<EngineInternals, Map<string, ExecutionAttemptRecord>>();

/**
 * Start a new attempt for the workflow: the engine just adopted a launch checkpoint for it,
 * of the generation identified by `workflowExecutionToken`.
 */
export function beginExecutionAttempt(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): void {
  let attempts = attemptsByEngine.get(internals);
  if (attempts === undefined) {
    attempts = new Map();
    attemptsByEngine.set(internals, attempts);
  }
  attempts.set(workflowId, { attempt: Symbol(), workflowExecutionToken });
}

/** Retire the workflow's attempt along with the checkpoint it belonged to. */
export function forgetExecutionAttempt(internals: EngineInternals, workflowId: string): void {
  attemptsByEngine.get(internals)?.delete(workflowId);
}

/** The attempt this engine is currently making at the workflow, or `undefined` when it has launched none. */
export function currentExecutionAttempt(
  internals: EngineInternals,
  workflowId: string,
): ExecutionAttempt | undefined {
  return attemptsByEngine.get(internals)?.get(workflowId)?.attempt;
}

/**
 * The generation this engine's current attempt at the workflow launched, or `undefined` when
 * it has launched none. Unlike the in-memory checkpoint, it outlives a suspension.
 */
export function currentExecutionGeneration(
  internals: EngineInternals,
  workflowId: string,
): { readonly workflowExecutionToken: string | undefined } | undefined {
  return attemptsByEngine.get(internals)?.get(workflowId);
}

/**
 * Where a terminal failure comes from, which decides what identifies the run it
 * belongs to.
 *
 * - `'execution'`: raised by the run this engine drives, so it belongs to the attempt
 *   and generation the engine holds when the failure begins.
 * - `'launch'`: raised while the engine launches, resumes, or recovers the stored
 *   generation, before it adopts that generation's checkpoint. Whatever the engine
 *   still holds for the id is then an earlier attempt (possibly an abandoned one) that
 *   the failure says nothing about, so only the stored generation identifies it.
 */
export type FailureOrigin = 'execution' | 'launch';

/**
 * Capture which run a terminal failure belongs to and return the `skipCommitIf`
 * predicate that refuses its write once that run is no longer this engine's to fail.
 * Call it synchronously, before the failure's first await.
 *
 * The write is refused when any of these holds at the moment it would commit:
 *
 * - the stored generation is one this engine abandoned after losing a checkpoint
 *   compare-and-swap race, so it belongs to the winning engine;
 * - for an `'execution'` failure, the generation the engine held when the failure began
 *   is marked abandoned, which a replacement stored by another engine does not change;
 * - for an `'execution'` failure, the engine's current attempt is no longer the one it
 *   began under: the id was launched again here, whether as a replacement generation or
 *   as the very same generation relaunched, and a stale failure must never be written
 *   over a later run.
 *
 * A `'launch'` failure, or an execution failure that began with no attempt, is judged by
 * the stored generation alone. The markers are read as they stand when the predicate
 * runs, so a generation abandoned while the failure was in flight still refuses it.
 */
export function staleFailureGuard(
  internals: EngineInternals,
  workflowId: string,
  origin: FailureOrigin,
): (stored: WorkflowState) => boolean {
  const held = origin === 'execution' ? internals.checkpoints.get(workflowId) : undefined;
  const attempt =
    origin === 'execution' ? currentExecutionAttempt(internals, workflowId) : undefined;
  return (stored) =>
    isCheckpointGenerationAbandoned(internals, workflowId, stored.workflowExecutionToken) ||
    (held !== undefined &&
      isCheckpointGenerationAbandoned(internals, workflowId, held.workflowExecutionToken)) ||
    (attempt !== undefined && currentExecutionAttempt(internals, workflowId) !== attempt);
}
