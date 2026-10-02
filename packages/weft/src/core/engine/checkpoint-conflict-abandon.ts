import {
  WeftWorkflowCheckpointConflictWarning,
  type WorkflowCheckpointConflictError,
} from './checkpoint-conflict-error.ts';
import { dropQueuedInlineWorkflowStart } from './inline-launch-queue.ts';
import type { EngineInternals } from './internals.ts';
import { evictSuspendedWorkflowWaiters, type TerminationCallbacks } from './termination/cleanup.ts';

/**
 * Stop driving a workflow whose checkpoint commit lost its compare-and-swap
 * race to another engine over the same store, without writing anything durable.
 *
 * The winning engine owns the workflow's checkpoint, terminal state, and
 * record, so this must never fail, complete, or checkpoint the run: it only
 * releases this engine's in-memory execution state (generator, abort
 * controller, context, parked-inline entry, queued launch, in-memory
 * checkpoint, signal/update/sleep/condition/review waiters), settles every
 * pending `result()` waiter with the typed error, remembers the loss so a later
 * `result()` call rejects instead of waiting on a generator that is gone, and
 * emits the operator warning. Durable timers and buffered signals stay in
 * storage for the winner.
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
  internals.inlineStrategy?.cancelWorkflow(workflowId);
  dropQueuedInlineWorkflowStart(internals, workflowId);
  internals.checkpoints.delete(workflowId);
  internals.parkedInlineWorkflows.delete(workflowId);
  internals.durableInlineOperations.delete(workflowId);
  evictSuspendedWorkflowWaiters(internals, workflowId, callbacks);

  internals.checkpointConflicts.set(workflowId, error);
  const waiter = internals.resultResolvers.get(workflowId);
  if (waiter !== undefined) {
    internals.resultResolvers.delete(workflowId);
    waiter.reject(error);
  }

  process.emitWarning(new WeftWorkflowCheckpointConflictWarning(workflowId));
}
