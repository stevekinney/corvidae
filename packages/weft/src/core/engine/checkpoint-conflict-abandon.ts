import {
  WeftWorkflowCheckpointConflictWarning,
  WorkflowCheckpointConflictError,
} from './checkpoint-conflict-error.ts';
import { dropQueuedInlineWorkflowStart } from './inline-launch-queue.ts';
import type { EngineInternals } from './internals.ts';
import { swallowPromiseRejection } from './strategy-helpers.ts';
import {
  releaseAbandonedWorkflowMemory,
  type TerminationCallbacks,
} from './termination/cleanup.ts';

/**
 * Stop driving a workflow whose checkpoint commit lost its compare-and-swap
 * race to another engine over the same store, without writing anything durable.
 *
 * The winning engine owns the workflow's checkpoint, terminal state, and
 * record, so this must never fail, complete, or checkpoint the run: it only
 * releases this engine's in-memory execution state (generator, abort
 * controller, context, parked-inline entry, queued launch, every per-workflow
 * map {@link releaseAbandonedWorkflowMemory} covers, and this engine's local
 * workflow-lease claim, forgotten without a durable release so it stops renewing
 * and expires), settles every pending `result()` waiter with the typed error,
 * remembers the loss so a later `result()` call rejects instead of waiting on a
 * generator that is gone, and emits the operator warning. Durable timers and
 * buffered signals stay in storage for the winner.
 *
 * Called where the conflict is detected, before the error propagates, so the
 * generator is already gone when any caller's failure handling runs: the
 * in-flight operation is no longer current (nothing is fed to the generator)
 * and no later `failWorkflow` is accepted for the run. Idempotent.
 *
 * Under `ownership: 'lease'` and `'workflow-lease'` a deposition is handled
 * upstream (`EngineDeposedError`); only a same-epoch lost race reaches here, and
 * with one holder per store or workflow that means the checkpoint bytes changed
 * under the holder's own epoch. This engine cannot advance the run either way, so
 * the same release applies.
 */
export function abandonWorkflowAfterCheckpointConflict(
  internals: EngineInternals,
  error: WorkflowCheckpointConflictError,
  callbacks: Pick<TerminationCallbacks, 'swallowPromiseRejection'>,
): void {
  const { workflowId } = error;
  if (internals.checkpointConflicts.has(workflowId)) return;
  internals.strategy.retireWorkflow(workflowId);
  dropQueuedInlineWorkflowStart(internals, workflowId);
  internals.durableInlineOperations.delete(workflowId);
  releaseAbandonedWorkflowMemory(internals, workflowId, callbacks);
  internals.workflowClaimRegistry?.forgetLocalClaim(workflowId);

  internals.checkpointConflicts.set(workflowId, error);
  const waiter = internals.resultResolvers.get(workflowId);
  if (waiter !== undefined) {
    internals.resultResolvers.delete(workflowId);
    waiter.reject(error);
  }

  process.emitWarning(new WeftWorkflowCheckpointConflictWarning(workflowId));
}

/**
 * Run an engine-level checkpoint persist and, when it throws
 * {@link WorkflowCheckpointConflictError}, abandon the workflow before the error
 * reaches the caller. Wrapping every engine entry into `persistCheckpoint`
 * (the generator checkpoint message, data operations, and the durableActivity
 * retry-sleep persist) means the generator is already gone, and the in-flight
 * operation no longer current, by the time any caller's failure handling turns
 * the throw into a failed operation result or a failed workflow. The error is
 * rethrown unchanged for callers that unwind through it.
 */
export async function persistCheckpointAbandoningOnConflict(
  internals: EngineInternals,
  persist: () => Promise<void>,
): Promise<void> {
  try {
    await persist();
  } catch (error) {
    if (error instanceof WorkflowCheckpointConflictError) {
      abandonWorkflowAfterCheckpointConflict(internals, error, { swallowPromiseRejection });
    }
    throw error;
  }
}

/**
 * A child this engine abandoned after losing its checkpoint compare-and-swap
 * race is healthy under the winning engine, so its local `result()` rejection is
 * not a child failure the parent may observe or fail on. The local parent's
 * progress depends on a result this engine will never produce, which makes the
 * parent stale too: abandon it the same way (no durable write, its own conflict
 * error naming the parent with the child's as `cause`) and settle the parent's
 * view of the child never, like every other discarded wake.
 */
export function abandonParentOfAbandonedChild(
  internals: EngineInternals,
  childWorkflowId: string,
  parentWorkflowId: string,
  childResult: Promise<unknown>,
): Promise<unknown> {
  return childResult.catch((error: unknown) => {
    if (
      !(error instanceof WorkflowCheckpointConflictError) ||
      error.workflowId !== childWorkflowId
    ) {
      throw error;
    }
    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError(parentWorkflowId, { cause: error }),
      { swallowPromiseRejection },
    );
    return new Promise<never>(() => {});
  });
}
