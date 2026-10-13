import { abandonParentAfterChildCheckpointConflict } from './checkpoint-conflict-abandon.ts';
import { isCheckpointConflictFor } from './checkpoint-conflict-error.ts';
import { currentExecutionAttempt, type ExecutionAttempt } from './execution-attempts.ts';
import { getWorkflowResultPromise } from './handle-result.ts';
import type { EngineInternals } from './internals.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';

/**
 * Result promise for a parent generator parked on `ctx.startChild()`'s
 * default `parentClosePolicy: 'await'` — the ONLY intended caller (see
 * `child-workflow.ts`'s `executeChildWorkflow`, which must call this instead
 * of the plain `childHandle.result()` / `handle.result()` path). Identical to
 * {@link getWorkflowResultPromise} except the waiter this settles is marked
 * generator-owned for `parentWorkflowId`: under `ownership: 'workflow-lease'`
 * a settle attempt first confirms `parentWorkflowId` still holds the claim
 * generation it parked under (`confirmWakeOwnership`, `'child-completion'`),
 * fencing duplicate generator advancement (WFT-79 F1) — see
 * `bootstrapWorkflowResultResolver` (`handle-result.ts`). Top-level, non-generator callers
 * must keep using {@link getWorkflowResultPromise}, which stays unfenced by
 * design: cross-engine `handle.result()` polling has no generator to
 * duplicate and must remain settleable from durable state alone.
 *
 * If `internals.resultResolvers` already holds a waiter for `workflowId` —
 * e.g. an observational `handle.result()` caller got there first — that
 * SHARED waiter is untouched: {@link fenceResultOnParentGeneration} wraps
 * only THIS caller's derived promise, so the observational caller's own
 * promise settles normally from the shared waiter regardless of the parent's
 * claim generation. See that function's doc for why fencing lives on the
 * parent's view instead of the shared waiter itself.
 */
export function getGeneratorOwnedWorkflowResultPromise(
  internals: EngineInternals,
  workflowId: string,
  parentWorkflowId: string,
  signal?: AbortSignal,
  // Captured by the caller before it awaited anything on the parent's behalf (child startup reads
  // storage and dispatches the start first), so a relaunch during that window is not mistaken for
  // the run that began awaiting. Defaults to the attempt held at this call.
  parentAttempt: ExecutionAttempt | undefined = currentExecutionAttempt(
    internals,
    parentWorkflowId,
  ),
): Promise<unknown> {
  return fenceResultOnParentGeneration(
    internals,
    parentWorkflowId,
    getWorkflowResultPromise(internals, workflowId),
    workflowId,
    parentAttempt,
    signal,
  );
}

/**
 * Withhold a settled child result from a parent generator that no longer holds
 * the claim generation it parked under.
 *
 * This wraps the SHARED waiter's promise rather than marking the waiter itself.
 * `internals.resultResolvers` dedupes to one waiter per workflow id, so an
 * observational `handle.result()` caller and a parked parent can attach to the
 * same waiter in either order. Marking that shared entry applied the parent's
 * fence to the observer too, and a deposed parent then starved an unrelated
 * caller of a result that was already durable — so the fence lives on the
 * parent's view, and the shared waiter settles normally for everyone else.
 *
 * A discarded parent's promise never settles, matching every other discarded
 * claim-requiring wake: the successor engine replays that parent, and this
 * engine's copy must not advance. Inert under `ownership: 'none'`/`'lease'`,
 * where `confirmWakeOwnership` always proceeds.
 */
function fenceResultOnParentGeneration(
  internals: EngineInternals,
  parentWorkflowId: string,
  promise: Promise<unknown>,
  childWorkflowId: string,
  parentAttempt: ExecutionAttempt | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const gate = Promise.withResolvers<unknown>();
  void promise.then(
    async (value) => {
      if (await parentStillOwnsGeneration(internals, parentWorkflowId)) gate.resolve(value);
      return undefined;
    },
    async (error: unknown) => {
      // A child abandoned after a lost checkpoint race is healthy under its winner, so this must
      // not become a failure of the child. Nothing on this engine can settle the parent's view of
      // it either, and the winner may have resumed only the child, so the parent gives up the
      // same way the child did (see `abandonParentAfterChildCheckpointConflict`).
      if (isCheckpointConflictFor(error, childWorkflowId)) {
        // A losing `ctx.race` branch aborted this await: the parent moved on, so a late conflict
        // of that child concerns nobody. Otherwise abandon only a parent this engine still owns
        // (the claim-generation check the other branches make), judged again, synchronously, by
        // the attempt comparison inside the abandonment.
        // The signal is read again after the ownership await: a branch can lose during it.
        const ownsParent =
          signal?.aborted !== true &&
          (await parentStillOwnsGeneration(internals, parentWorkflowId));
        if (ownsParent && signal?.aborted !== true) {
          abandonParentAfterChildCheckpointConflict(
            internals,
            parentWorkflowId,
            parentAttempt,
            error,
          );
        }
        return undefined;
      }
      if (await parentStillOwnsGeneration(internals, parentWorkflowId)) gate.reject(error);
      return undefined;
    },
  );
  return gate.promise;
}

async function parentStillOwnsGeneration(
  internals: EngineInternals,
  parentWorkflowId: string,
): Promise<boolean> {
  try {
    return (
      (await confirmWakeOwnership(internals, parentWorkflowId, 'child-completion')) === 'proceed'
    );
  } catch {
    // A thrown pre-check is not a confirmed loss of the claim, and this fence
    // is only a cheap guard — the epoch-conditioned durable write the parent
    // makes next is the real backstop. Proceeding matches
    // `confirmWakeOwnership`'s own documented thrown-read policy; swallowing
    // the throw into a withheld result would strand the parent permanently on
    // a transient blip.
    return true;
  }
}
