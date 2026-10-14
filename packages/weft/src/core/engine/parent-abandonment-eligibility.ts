import { currentExecutionAttempt, type ExecutionAttempt } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';
import { wakeOwnershipCheck } from './wake-ownership-check.ts';

/**
 * Whether this engine may give up a parent workflow because the child (or descendant) it awaits
 * lost its checkpoint compare-and-swap race.
 *
 * Abandoning a parent is a side effect on a workflow whose own checkpoint did not lose anything,
 * so it is allowed only when every one of these positively holds. Anything uncertain means the
 * parent stays parked, which is what it did before abandonment existed. The caller evaluates this
 * after its last `await` and calls the abandonment in the same synchronous stretch, so no state
 * can change between the answer and the effect.
 *
 * Lifecycle states considered, and how each is treated:
 *
 * - relaunched or replaced since it began awaiting (resume, recovery, start-new): ineligible; the
 *   captured attempt is no longer the current one, so the loss is about work this engine left.
 * - already abandoned (its own loss, or an earlier child's): ineligible; nothing left to abandon.
 * - suspended: ineligible; the attempt survives a suspension but the checkpoint is released, and a
 *   resume begins a new attempt that replays its own awaits.
 * - cancelling, timing out, failing, or completing (`terminalizingWorkflows`): ineligible; the
 *   terminal outcome in progress must keep its result.
 * - terminal or purged: ineligible; terminal cleanup retires the attempt and the checkpoint.
 * - engine disposed: ineligible; disposal retires every attempt, so the captured attempt is gone.
 * - the awaiting `ctx.race` branch lost (aborted signal): ineligible; the parent moved on.
 * - the parent's view already settled: ineligible; the parent is no longer awaiting this child.
 * - claim lost to a successor (`workflow-lease`): ineligible; the successor replays the parent.
 * - ownership read failed or could not be made (`workflow-lease`): ineligible; the settle paths
 *   proceed on a thrown read because a durable fenced write backstops them, but abandonment has
 *   no backstop and must not act on an inconclusive answer.
 * - no claim registry (`ownership: 'none'` / `'lease'`): the ownership condition is vacuous.
 * - update handlers, queries, and signals pending on the parent: no interaction; abandonment
 *   neither reads nor settles them, and the parent stays unresolved exactly like any abandoned
 *   generation.
 * - pause and continue-as-new: this engine has neither state.
 */
export type ParentAbandonmentEligibilityInput = {
  readonly parentWorkflowId: string;
  /** The attempt the parent held when it began awaiting, captured before any await. */
  readonly parkedAttempt: ExecutionAttempt | undefined;
  /** Aborted when a `ctx.race` branch awaiting the child loses. */
  readonly signal: AbortSignal | undefined;
  /** Whether the parent's view of the child is still unsettled. */
  readonly stillAwaiting: boolean;
  /** Result of {@link confirmParentOwnership}, read before the last await this is judged after. */
  readonly ownershipConfirmed: boolean;
};

export function parentEligibleForChildConflictAbandonment(
  internals: EngineInternals,
  input: ParentAbandonmentEligibilityInput,
): boolean {
  const { parentWorkflowId, parkedAttempt } = input;
  if (parkedAttempt === undefined) return false;
  const current = currentExecutionAttempt(internals, parentWorkflowId);
  return (
    current === parkedAttempt &&
    !current.abandoned &&
    internals.checkpoints.has(parentWorkflowId) &&
    !internals.terminalizingWorkflows.has(parentWorkflowId) &&
    input.signal?.aborted !== true &&
    input.stillAwaiting &&
    (internals.workflowClaimRegistry === null || input.ownershipConfirmed)
  );
}

/**
 * Whether this engine still holds the parent's ownership claim, by a read that succeeded. Unlike
 * `confirmWakeOwnership`, a thrown read answers `false`, not "proceed". Vacuously `true` when there
 * is no claim registry.
 */
export async function confirmParentOwnership(
  internals: EngineInternals,
  parentWorkflowId: string,
): Promise<boolean> {
  const registry = internals.workflowClaimRegistry;
  if (registry === null) return true;
  const expectedEpoch = registry.currentEpoch(parentWorkflowId);
  if (expectedEpoch === null) return false;
  try {
    const result = await wakeOwnershipCheck({
      storage: internals.storage,
      workflowId: parentWorkflowId,
      wakeKind: 'child-completion',
      expectedEngineId: registry.engineId,
      expectedEpoch,
    });
    return result.status === 'match';
  } catch {
    return false;
  }
}
