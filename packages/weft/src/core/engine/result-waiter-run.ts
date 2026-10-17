/**
 * Binds a result waiter to the run generation it was created for.
 *
 * `internals.resultResolvers` is keyed by workflow id, and an `onTerminalConflict: 'start-new'`
 * replacement reuses the id. A replacement started by another engine never touches this engine's
 * map, so a waiter created for the original run can still be registered when the replacement
 * terminates. Every place that settles a waiter from a run's outcome therefore asks, through this
 * module, whether the waiter belongs to that run. A waiter that does not is rejected as replaced
 * with {@link workflowRunReplacedError}, never settled with the replacement's outcome. Every
 * check is a synchronous comparison, so none adds an await to a persist, launch, or terminal path.
 *
 * @module core/engine/result-waiter-run
 */
import type { WorkflowResultWaiter } from './engine-internal-types.ts';
import type { EngineInternals } from './internals.ts';
import { markResultReplaced } from './result-committer.ts';

/** What a result waiter rejects with when a newer run reused its workflow id before it settled. */
export function workflowRunReplacedError(workflowId: string): Error {
  return new Error(`Workflow "${workflowId}" was replaced by a newer run before it ended.`);
}

/**
 * Whether `waiter` is the result waiter for the run identified by `executionToken`. A side with
 * no token (a run recorded before execution tokens existed, or a waiter not yet bound) cannot be
 * told apart from the other, so it is treated as the same run, as it was before tokens.
 */
export function waiterBelongsToRun(
  waiter: WorkflowResultWaiter,
  executionToken: string | undefined,
): boolean {
  return (
    waiter.workflowExecutionToken === undefined ||
    executionToken === undefined ||
    waiter.workflowExecutionToken === executionToken
  );
}

/** Bind `waiter` to the run `executionToken` identifies, unless it is already bound. */
export function bindResultWaiterToRun(
  waiter: WorkflowResultWaiter,
  executionToken: string | undefined,
): void {
  if (waiter.workflowExecutionToken === undefined && executionToken !== undefined) {
    waiter.workflowExecutionToken = executionToken;
  }
}

/**
 * Reject `waiter` because a newer run reused its workflow id, and drop it from the map if it is
 * still the entry there. The original run's outcome is no longer readable, since the replacement
 * purged it, so the handle also reports the run as concluded by another engine: only another
 * engine can have terminated a run whose waiter this engine never settled.
 */
export function rejectReplacedResultWaiter(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): void {
  if (internals.resultResolvers.get(workflowId) === waiter) {
    internals.resultResolvers.delete(workflowId);
  }
  markResultReplaced(waiter);
  waiter.reject(workflowRunReplacedError(workflowId));
}

/**
 * The waiter registered for `workflowId` if it belongs to the run `executionToken` identifies.
 * A registered waiter that belongs to an older run is rejected as replaced and dropped, and
 * `undefined` is returned so the caller settles nothing with this run's outcome.
 */
export function resultWaiterForRun(
  internals: EngineInternals,
  workflowId: string,
  executionToken: string | undefined,
): WorkflowResultWaiter | undefined {
  const waiter = internals.resultResolvers.get(workflowId);
  if (waiter === undefined) return undefined;
  if (waiterBelongsToRun(waiter, executionToken)) return waiter;
  rejectReplacedResultWaiter(internals, workflowId, waiter);
  return undefined;
}
