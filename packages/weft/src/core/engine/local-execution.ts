/**
 * What this engine holds in memory for a workflow's execution, read from the things that own it.
 *
 * An inline start is queued and launched by `inline-launch-queue.ts`, which records its progress
 * here: the two membership indexes on `EngineInternals` (queued; queued or launching) and, beside
 * them, the claim epoch the start was enqueued under. A reclaim that meets a run whose launch is
 * queued or in flight under the claim it holds neither counts it as driven nor drives it a second
 * time, nor waits for it: it leaves the run to the flush (`defersToQueuedInlineWorkflowStart`).
 *
 * A run is *live* when the strategy that executes it holds it: for the inline strategy a context,
 * a turn still being handled, or the parked marker of a run waiting for a signal; for a worker
 * strategy, whose worker is acquired asynchronously, the in-memory checkpoint the engine holds for
 * the run from adoption until terminal cleanup, suspension, or disposal releases it. These are the
 * same terms `recoverAll()`'s preflight reads as local ownership (`isInlineWorkflowLocallyOwned`,
 * `hasLocalCheckpointOwnership`), without the queued launch, which is deferred to rather than live.
 *
 * This module imports nothing but the internals type, so the resume path can read it without a
 * cycle through the lifecycle barrel.
 */
import type { EngineInternals } from './internals.ts';

/**
 * The claim epoch each queued or launching inline start was enqueued under (`null` under no
 * per-workflow claim), by workflow id. Held beside the engine, like the execution attempts.
 */
const queuedInlineStartClaimEpochs = new WeakMap<EngineInternals, Map<string, number | null>>();

function queuedEpochsOf(internals: EngineInternals): Map<string, number | null> {
  let epochs = queuedInlineStartClaimEpochs.get(internals);
  if (epochs === undefined) {
    epochs = new Map();
    queuedInlineStartClaimEpochs.set(internals, epochs);
  }
  return epochs;
}

/** An inline start of the workflow is queued under the claim held now; its launch has not run. */
export function recordInlineWorkflowStartQueued(
  internals: EngineInternals,
  workflowId: string,
): void {
  internals.queuedInlineWorkflowStartIds.add(workflowId);
  internals.queuedOrLaunchingInlineWorkflowStartIds.add(workflowId);
  queuedEpochsOf(internals).set(
    workflowId,
    internals.workflowClaimRegistry?.currentEpoch(workflowId) ?? null,
  );
}

/** The queued start's launch is about to start the generator: it is no longer queued, still launching. */
export function recordInlineWorkflowStartLaunching(
  internals: EngineInternals,
  workflowId: string,
): void {
  internals.queuedInlineWorkflowStartIds.delete(workflowId);
}

/** The launch of the workflow's queued start is over: it started the generator, skipped the run, was discarded, or threw. */
export function settleInlineWorkflowStart(internals: EngineInternals, workflowId: string): void {
  internals.queuedInlineWorkflowStartIds.delete(workflowId);
  internals.queuedOrLaunchingInlineWorkflowStartIds.delete(workflowId);
  queuedInlineStartClaimEpochs.get(internals)?.delete(workflowId);
}

/** Forget every queued or launching inline start, as a synchronous disposal discards them all. */
export function settleEveryInlineWorkflowStart(internals: EngineInternals): void {
  internals.queuedInlineWorkflowStartIds.clear();
  internals.queuedOrLaunchingInlineWorkflowStartIds.clear();
  queuedInlineStartClaimEpochs.get(internals)?.clear();
}

/**
 * Whether the workflow's queued or launching inline start was enqueued under a claim this engine
 * no longer holds: the claim was lost and taken back since, so the start's checkpoint may be behind
 * the run's durable one. The flush discards such a start, and a reclaim does not defer to it.
 */
export function isQueuedInlineWorkflowStartStale(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  const enqueuedUnder = queuedInlineStartClaimEpochs.get(internals)?.get(workflowId);
  return (
    enqueuedUnder !== undefined &&
    enqueuedUnder !== (internals.workflowClaimRegistry?.currentEpoch(workflowId) ?? null)
  );
}

/**
 * Whether a reclaim should leave the workflow to an inline start of it that is queued or launching
 * under the claim held now. That start is this engine's own drive in the making: its flush drives
 * the run under this claim, so a reclaim that evicted or replayed would drive the generation a
 * second time, and one that waited for the flush would wait on the host under `'manual'` launch
 * scheduling, where only the host flushes. A reclaim that meets one returns and leaves the run to
 * the flush; a flush that throws before its generator exists lets the run go, claim included, so
 * the next pass acquires and drives it. A start enqueued under an earlier claim is stale: the flush
 * will discard it, and the reclaim drives the run itself.
 */
export function defersToQueuedInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  return (
    internals.queuedOrLaunchingInlineWorkflowStartIds.has(workflowId) &&
    !isQueuedInlineWorkflowStartStale(internals, workflowId)
  );
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
