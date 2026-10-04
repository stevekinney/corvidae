import {
  WeftWorkflowCheckpointConflictWarning,
  WorkflowCheckpointConflictError,
} from './checkpoint-conflict-error.ts';
import { abandonExecutionAttempt, currentExecutionAttempt } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Stop driving a workflow whose checkpoint commit lost its compare-and-swap
 * race to another engine over the same store, without writing anything durable.
 *
 * Under `ownership: 'none'` nothing fences the two engines, so the loser cannot
 * converge; it fails fast and loudly instead. Synchronously: mark the lost
 * generation abandoned in the execution attempt registry (so every later wake,
 * failure, timer, and `result()` for it is refused), retire the execution so the
 * generator is never fed again, reject the pending `result()` waiter with the
 * typed error, evict the cached handle so a later `getHandle()` builds one that
 * observes the abandonment, and emit the operator warning. Nothing else is
 * released: maps, timers, waiters, feeds, and claims stay as they were, and
 * durable timers and buffered signals stay in storage for the winner.
 * `ownership: 'workflow-lease'` is the complete answer for two live engines.
 *
 * Does nothing unless this engine holds an execution attempt that launched the
 * generation whose commit lost (the error carries its token), whether the run is
 * live or suspended: a suspension releases the checkpoint and keeps the attempt,
 * so a commit still in flight from before it is abandoned like any other. A local
 * replacement installed while the loss was classified is healthy and not ours to
 * abandon, a generation this engine released (finished, purged, rolled back, or
 * the engine disposed) has no attempt left to abandon, and one already abandoned
 * is not abandoned twice. A generation recovered from before execution tokens
 * existed has no token, on the error and in the attempt alike, and is abandoned
 * like any other. Idempotent.
 */
export function abandonWorkflowAfterCheckpointConflict(
  internals: EngineInternals,
  error: WorkflowCheckpointConflictError,
): void {
  const { workflowId, workflowExecutionToken } = error;
  if (!abandonExecutionAttempt(internals, workflowId, workflowExecutionToken)) return;
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

/**
 * The rejection a `result()` requested after a loss settles with: the conflict for the generation
 * this engine holds for the workflow and has abandoned, running or suspended, or `undefined` when
 * it holds no abandoned generation. Read from the execution attempt, which a suspension keeps and
 * the in-memory checkpoint does not.
 */
export function abandonedGenerationConflict(
  internals: EngineInternals,
  workflowId: string,
): WorkflowCheckpointConflictError | undefined {
  const held = currentExecutionAttempt(internals, workflowId);
  if (held?.abandoned !== true) return undefined;
  return new WorkflowCheckpointConflictError(workflowId, {
    workflowExecutionToken: held.workflowExecutionToken,
  });
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
