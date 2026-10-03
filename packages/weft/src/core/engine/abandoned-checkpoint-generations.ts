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
 * Held beside the engine rather than on `EngineInternals`, like the committed
 * checkpoint bytes in `checkpoint-commit-snapshots.ts`, so an engine that never
 * loses a race carries nothing and every wake-path check is a single `WeakMap`
 * miss.
 */
const abandonedGenerationsByEngine = new WeakMap<EngineInternals, Set<string>>();

function abandonedCheckpointGenerationKey(workflowId: string, workflowExecutionToken: string) {
  return JSON.stringify([workflowId, workflowExecutionToken]);
}

/** Remember that this engine abandoned the generation. A generation without a token cannot be keyed and is ignored. */
export function markCheckpointGenerationAbandoned(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): void {
  if (workflowExecutionToken === undefined) return;
  let abandoned = abandonedGenerationsByEngine.get(internals);
  if (abandoned === undefined) {
    abandoned = new Set();
    abandonedGenerationsByEngine.set(internals, abandoned);
  }
  abandoned.add(abandonedCheckpointGenerationKey(workflowId, workflowExecutionToken));
}

/** Forget the marker once this engine successfully launches that same generation again. */
export function forgetAbandonedCheckpointGeneration(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): void {
  if (workflowExecutionToken === undefined) return;
  abandonedGenerationsByEngine
    .get(internals)
    ?.delete(abandonedCheckpointGenerationKey(workflowId, workflowExecutionToken));
}

/** Drop every marker; called when the engine is disposed. */
export function clearAbandonedCheckpointGenerations(internals: EngineInternals): void {
  abandonedGenerationsByEngine.delete(internals);
}

/** Whether the generation identified by `workflowExecutionToken` is marked abandoned. */
export function isCheckpointGenerationAbandoned(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): boolean {
  return (
    workflowExecutionToken !== undefined &&
    abandonedGenerationsByEngine
      .get(internals)
      ?.has(abandonedCheckpointGenerationKey(workflowId, workflowExecutionToken)) === true
  );
}

/**
 * Whether the generation this engine currently holds in memory for the workflow
 * is marked abandoned. Synchronous, and a single `WeakMap` miss for an engine
 * that never lost a race, so it is safe on every wake path.
 */
export function isCurrentCheckpointGenerationAbandoned(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  const abandoned = abandonedGenerationsByEngine.get(internals);
  if (abandoned === undefined || abandoned.size === 0) return false;
  return isCheckpointGenerationAbandoned(
    internals,
    workflowId,
    internals.checkpoints.get(workflowId)?.workflowExecutionToken,
  );
}

/** Number of generations currently marked abandoned (diagnostics and tests). */
export function abandonedCheckpointGenerationCount(internals: EngineInternals): number {
  return abandonedGenerationsByEngine.get(internals)?.size ?? 0;
}
