import {
  isCheckpointGenerationAbandoned,
  markCheckpointGenerationAbandoned,
} from './abandoned-checkpoint-generations.ts';
import {
  WeftWorkflowCheckpointConflictWarning,
  WorkflowCheckpointConflictError,
} from './checkpoint-conflict-error.ts';
import { currentExecutionGeneration } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Stop driving a workflow whose checkpoint commit lost its compare-and-swap
 * race to another engine over the same store, without writing anything durable.
 *
 * Under `ownership: 'none'` nothing fences the two engines, so the loser cannot
 * converge; it fails fast and loudly instead. Synchronously: remember the lost
 * generation (so every later wake, failure, and `result()` for it is refused),
 * retire the execution so the generator is never fed again, reject the pending
 * `result()` waiter with the typed error, evict the cached handle so a later
 * `getHandle()` builds one that observes the marker, and emit the operator
 * warning. Nothing else is released: maps, timers, waiters, feeds, and claims
 * stay as they were, and durable timers and buffered signals stay in storage for
 * the winner. `ownership: 'workflow-lease'` is the complete answer for two live
 * engines.
 *
 * Returns early unless the engine is still driving the generation whose commit
 * lost (the error carries its token): it holds that generation's checkpoint or,
 * for a workflow it suspended, which releases the checkpoint and keeps the
 * attempt, the attempt that launched it. A local replacement installed while the
 * loss was classified is healthy and not ours to abandon, and a released
 * generation (finished, purged, or rolled back, which drop the checkpoint and the
 * attempt together) has nothing left to abandon.
 * A generation recovered from before execution tokens existed has none, on the
 * error and in memory alike, and is marked under the token-less key like any
 * other. Idempotent.
 */
export function abandonWorkflowAfterCheckpointConflict(
  internals: EngineInternals,
  error: WorkflowCheckpointConflictError,
): void {
  const { workflowId, workflowExecutionToken } = error;
  const driven =
    internals.checkpoints.get(workflowId) ?? currentExecutionGeneration(internals, workflowId);
  // Neither a checkpoint nor an attempt means nothing of this engine's to abandon, however the
  // loss was reported.
  if (driven === undefined || driven.workflowExecutionToken !== workflowExecutionToken) return;
  if (isCheckpointGenerationAbandoned(internals, workflowId, workflowExecutionToken)) return;
  markCheckpointGenerationAbandoned(internals, workflowId, workflowExecutionToken);
  try {
    internals.strategy.retireWorkflow(workflowId);
  } catch {
    // A retirement that cannot reach the execution (a closed worker channel)
    // must not stop the rest of the abandonment, which is what settles result().
  }
  const waiter = internals.resultResolvers.get(workflowId);
  if (waiter !== undefined) {
    internals.resultResolvers.delete(workflowId);
    waiter.reject(error);
  }
  const cached = internals.handleCache.get(workflowId);
  if (cached !== undefined) {
    internals.finalizationRegistry.unregister(cached.unregisterToken);
    internals.handleCache.delete(workflowId);
  }

  emitCheckpointConflictWarning(new WeftWorkflowCheckpointConflictWarning(workflowId));
}

type WarningProcess = { emitWarning?: (warning: Error) => void } | null | undefined;

/**
 * Emit the operator warning without assuming a Node-style runtime: `process` is
 * not a global in browser or Service Worker builds, where two engines can still
 * share one IndexedDB store, so fall back to `console.warn` there.
 */
export function emitCheckpointConflictWarning(
  warning: WeftWorkflowCheckpointConflictWarning,
  runtimeProcess: WarningProcess = (globalThis as { process?: WarningProcess }).process,
): void {
  if (typeof runtimeProcess?.emitWarning === 'function') {
    runtimeProcess.emitWarning(warning);
    return;
  }
  console.warn(warning);
}

/**
 * Run an engine-level checkpoint persist and, when it rejects with
 * {@link WorkflowCheckpointConflictError}, abandon the workflow before the error
 * reaches the caller. Covering every engine entry into `persistCheckpoint`
 * (the generator checkpoint message, data operations, and the durableActivity
 * retry-sleep persist) means the generator is already gone, and the in-flight
 * operation no longer current, by the time any caller's failure handling turns
 * the rejection into a failed operation result or a failed workflow.
 *
 * Deliberately not `async`: the persist promise itself is returned, so a
 * successful persist settles for its caller exactly when it would without this
 * wrapper. An extra await here measurably exposed a latent ordering race in the
 * bulk signal path (COR-1408 investigation). The abandonment runs as a side
 * reaction registered before the caller can await, so on rejection it runs
 * first; the caller still observes the original rejection unchanged.
 */
export function persistCheckpointAbandoningOnConflict(
  internals: EngineInternals,
  persist: () => Promise<void>,
): Promise<void> {
  const persisted = persist();
  void persisted.catch((error: unknown) => {
    if (error instanceof WorkflowCheckpointConflictError) {
      abandonWorkflowAfterCheckpointConflict(internals, error);
    }
  });
  return persisted;
}
