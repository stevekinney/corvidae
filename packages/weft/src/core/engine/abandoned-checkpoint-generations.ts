import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Bookkeeping for workflow generations this engine stopped driving because
 * their checkpoint commit lost its compare-and-swap race to another engine over
 * the same store (see `abandonWorkflowAfterCheckpointConflict`).
 *
 * A generation is identified by the workflow id plus its durable
 * `workflowExecutionToken`. A replacement generation always carries a new token,
 * so a marker can never apply to a later run under the same id; the only things
 * that remove one are this engine launching that same generation again
 * ({@link forgetAbandonedCheckpointGeneration}) and engine disposal
 * ({@link clearAbandonedCheckpointGenerations}). The set is bounded by the
 * number of conflicts the engine has seen.
 *
 * A run recovered from before execution tokens existed has no token, and is
 * keyed under a token-less sentinel instead of being left unmarked: without a
 * marker a `result()` requested through a fresh handle after the loss would
 * register a waiter that nothing under `ownership: 'none'` ever settles. That
 * sentinel names the one pre-token run an id can have, since every later run
 * carries a token, so adopting any token-bearing generation for the id retires
 * it ({@link forgetAbandonedCheckpointGeneration}).
 *
 * Held beside the engine rather than on `EngineInternals`, like the committed
 * checkpoint bytes in `checkpoint-commit-snapshots.ts`, so an engine that never
 * loses a race carries nothing and every wake-path check is a single `WeakMap`
 * miss.
 */
const abandonedGenerationsByEngine = new WeakMap<EngineInternals, Set<string>>();

/** `null` stands for the single pre-token generation an id can have. */
function abandonedCheckpointGenerationKey(
  workflowId: string,
  workflowExecutionToken: string | undefined,
) {
  return JSON.stringify([workflowId, workflowExecutionToken ?? null]);
}

/** Remember that this engine abandoned the generation; a pre-token generation is keyed by the token-less sentinel. */
export function markCheckpointGenerationAbandoned(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): void {
  let abandoned = abandonedGenerationsByEngine.get(internals);
  if (abandoned === undefined) {
    abandoned = new Set();
    abandonedGenerationsByEngine.set(internals, abandoned);
  }
  abandoned.add(abandonedCheckpointGenerationKey(workflowId, workflowExecutionToken));
}

/**
 * Forget the marker once this engine successfully launches that same generation
 * again. Launching a token-bearing generation also forgets the pre-token marker
 * for the id: no pre-token run can be the one that was just launched or the one
 * that replaced it, so that marker can only be stale.
 */
export function forgetAbandonedCheckpointGeneration(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): void {
  const abandoned = abandonedGenerationsByEngine.get(internals);
  if (abandoned === undefined) return;
  abandoned.delete(abandonedCheckpointGenerationKey(workflowId, workflowExecutionToken));
  if (workflowExecutionToken !== undefined) {
    abandoned.delete(abandonedCheckpointGenerationKey(workflowId, undefined));
  }
}

/** Drop every marker; called when the engine is disposed. */
export function clearAbandonedCheckpointGenerations(internals: EngineInternals): void {
  abandonedGenerationsByEngine.delete(internals);
}

/** Whether the generation identified by `workflowExecutionToken` (`undefined` for a pre-token run) is marked abandoned. */
export function isCheckpointGenerationAbandoned(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): boolean {
  return (
    abandonedGenerationsByEngine
      .get(internals)
      ?.has(abandonedCheckpointGenerationKey(workflowId, workflowExecutionToken)) === true
  );
}

/**
 * Whether the generation this engine currently holds in memory for the workflow
 * is marked abandoned. Synchronous, and a single `WeakMap` miss for an engine
 * that never lost a race, so it is safe on every wake path. A workflow with no
 * in-memory checkpoint holds no generation at all, which is different from a
 * pre-token one, so it is never abandoned.
 */
export function isCurrentCheckpointGenerationAbandoned(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  const abandoned = abandonedGenerationsByEngine.get(internals);
  if (abandoned === undefined || abandoned.size === 0) return false;
  const current = internals.checkpoints.get(workflowId);
  return (
    current !== undefined &&
    isCheckpointGenerationAbandoned(internals, workflowId, current.workflowExecutionToken)
  );
}

/** Number of generations currently marked abandoned (diagnostics and tests). */
export function abandonedCheckpointGenerationCount(internals: EngineInternals): number {
  return abandonedGenerationsByEngine.get(internals)?.size ?? 0;
}

/** Whether `error` reports a lost checkpoint race for exactly this workflow. */
export function isCheckpointConflictFor(error: unknown, workflowId: string): boolean {
  return error instanceof WorkflowCheckpointConflictError && error.workflowId === workflowId;
}
