/**
 * What this engine holds in memory for a workflow's execution, read from the things that own it.
 *
 * An inline start is queued and launched by `inline-launch-queue.ts`, which records its progress
 * here: the two membership indexes on `EngineInternals` (queued; queued or launching) and, beside
 * them, a promise that settles when the launch is over, whether it started the generator, skipped
 * the run, or threw. A reclaim that meets a run whose launch is queued or in flight neither counts
 * it as driven nor drives it a second time: it waits for that settlement and then asks again.
 *
 * A run is *live* when the strategy that executes it holds it: for the inline strategy a context,
 * a turn still being handled, or the parked marker of a run waiting for a signal; for a worker
 * strategy, whose worker is acquired asynchronously, the in-memory checkpoint the engine holds for
 * the run from adoption until terminal cleanup, suspension, or disposal releases it. These are the
 * same terms `recoverAll()`'s preflight reads as local ownership (`isInlineWorkflowLocallyOwned`,
 * `hasLocalCheckpointOwnership`), without the queued launch, which is joinable rather than live.
 *
 * This module imports nothing but the internals type, so the resume path can read it without a
 * cycle through the lifecycle barrel.
 */
import type { EngineInternals } from './internals.ts';

const inlineStartSettlements = new WeakMap<
  EngineInternals,
  Map<string, PromiseWithResolvers<void>>
>();

function settlementsOf(internals: EngineInternals): Map<string, PromiseWithResolvers<void>> {
  let settlements = inlineStartSettlements.get(internals);
  if (settlements === undefined) {
    settlements = new Map();
    inlineStartSettlements.set(internals, settlements);
  }
  return settlements;
}

/** An inline start of the workflow is queued; its launch has not run. */
export function recordInlineWorkflowStartQueued(
  internals: EngineInternals,
  workflowId: string,
): void {
  internals.queuedInlineWorkflowStartIds.add(workflowId);
  internals.queuedOrLaunchingInlineWorkflowStartIds.add(workflowId);
  const settlements = settlementsOf(internals);
  if (!settlements.has(workflowId)) settlements.set(workflowId, Promise.withResolvers<void>());
}

/** The queued start's launch is about to start the generator: it is no longer queued, still launching. */
export function recordInlineWorkflowStartLaunching(
  internals: EngineInternals,
  workflowId: string,
): void {
  internals.queuedInlineWorkflowStartIds.delete(workflowId);
}

/**
 * The launch of the workflow's queued start is over: it started the generator, skipped the run, was
 * discarded, or threw. Whoever waited for it may now read what it left behind.
 */
export function settleInlineWorkflowStart(internals: EngineInternals, workflowId: string): void {
  internals.queuedInlineWorkflowStartIds.delete(workflowId);
  internals.queuedOrLaunchingInlineWorkflowStartIds.delete(workflowId);
  const settlements = inlineStartSettlements.get(internals);
  const settlement = settlements?.get(workflowId);
  if (settlements === undefined || settlement === undefined) return;
  settlements.delete(workflowId);
  settlement.resolve();
}

/** Settle every queued or launching inline start, as a synchronous disposal discards them all. */
export function settleEveryInlineWorkflowStart(internals: EngineInternals): void {
  internals.queuedInlineWorkflowStartIds.clear();
  internals.queuedOrLaunchingInlineWorkflowStartIds.clear();
  const settlements = inlineStartSettlements.get(internals);
  if (settlements === undefined) return;
  for (const settlement of settlements.values()) settlement.resolve();
  settlements.clear();
}

/**
 * A promise that settles once the workflow's queued or launching inline start is over, or
 * `undefined` when none is: a caller that finds none awaits nothing, so a path that never meets a
 * queued start keeps its turn count. One wait suffices: a running id cannot be started again, so no
 * second start can be queued behind the one that settles.
 */
export function queuedInlineWorkflowStartSettlement(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> | undefined {
  return inlineStartSettlements.get(internals)?.get(workflowId)?.promise;
}

/** Whether the inline strategy holds a live execution of the workflow: a context, a turn, or a park. */
export function isInlineWorkflowExecutionLive(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  const inlineStrategy = internals.inlineStrategy;
  return (
    inlineStrategy !== null &&
    (inlineStrategy.getContext(workflowId) !== undefined ||
      inlineStrategy.waitForWorkflowTurn(workflowId) !== undefined ||
      internals.parkedInlineWorkflows.has(workflowId))
  );
}

/**
 * Whether this engine holds a live execution of the workflow: the inline strategy holds it, or, for
 * a worker strategy, the engine holds the run's in-memory checkpoint. A queued or launching inline
 * start is not one, and neither is a run whose launch adopted a checkpoint and then stopped short of
 * the generator, which the inline strategy never received.
 */
export function holdsWorkflowExecution(internals: EngineInternals, workflowId: string): boolean {
  if (internals.inlineStrategy !== null)
    return isInlineWorkflowExecutionLive(internals, workflowId);
  return internals.checkpoints.has(workflowId);
}

/** Whether an inline start of the workflow is queued and its launch has not run. */
export function hasQueuedInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  return internals.queuedInlineWorkflowStartIds.has(workflowId);
}

/** Whether an inline start of the workflow is queued, or its launch is in flight. */
export function hasQueuedOrLaunchingInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  return internals.queuedOrLaunchingInlineWorkflowStartIds.has(workflowId);
}

function workflowStatusCanRetainLocalOwnership(workflowStatus: string): boolean {
  return workflowStatus === 'running' || workflowStatus === 'pending';
}

/**
 * `recoverAll()`'s and `resume()`'s local-ownership test for an inline run: a queued or launching
 * start, or a live execution, of a run that is still running or pending.
 */
export function isInlineWorkflowLocallyOwned(
  internals: EngineInternals,
  workflowId: string,
  workflowStatus: string,
): boolean {
  if (!workflowStatusCanRetainLocalOwnership(workflowStatus)) {
    return false;
  }

  return (
    hasQueuedOrLaunchingInlineWorkflowStart(internals, workflowId) ||
    isInlineWorkflowExecutionLive(internals, workflowId)
  );
}

/** The same test from the in-memory checkpoint, which worker-mode runs own by. */
export function hasLocalCheckpointOwnership(
  internals: EngineInternals,
  workflowId: string,
  workflowStatus: string,
): boolean {
  return (
    internals.checkpoints.has(workflowId) && workflowStatusCanRetainLocalOwnership(workflowStatus)
  );
}
