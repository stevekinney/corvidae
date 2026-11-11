import { AbortAgentRunError } from '@lostgradient/operative';
import { type WorkflowState } from '@lostgradient/weft';
import type { CancelDurableRunOutcome } from './types';
import { BureauError } from './bureau-errors';

/**
 * How long `shutdown({ policy: 'abort' })` waits for the runs it aborted to
 * reach a terminal event before it stops waiting and tears storage down. A
 * run that honors its `AbortSignal` settles within a few ticks; this bound
 * exists only so a run that ignores it cannot hold shutdown open.
 */
export const ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS = 1_000;

export const DURABLE_FORCIBLY_TERMINABLE_STATUSES = new Set<string>([
  'pending',
  'running',
  'suspended',
]);

/**
 * Whether a durable run's status is one it has not settled from: Bureau's own
 * non-terminal set ({@link DURABLE_FORCIBLY_TERMINABLE_STATUSES}), read by the
 * AG-UI mount's busy decision so it cannot drift from what `waitForDurableRun` and
 * `cancelDurableRun` call unsettled. `pending` counts: `createRun` returns once the
 * durable record commits, and Weft reports the workflow `pending` until its inline
 * launch runs.
 */
export function isDurableRunUnsettled(status: string): boolean {
  return DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(status);
}

/**
 * Dependencies {@link resolveCancelDurableRun} needs, factored out for
 * direct dependency injection in tests (AB-205) — in particular the
 * "resolves `already-terminal`, never `requested`" race fixture, which needs
 * to observe/control exactly when `cancel` resolves relative to a workflow
 * completing normally, something a real Weft engine cannot be made to do
 * deterministically.
 */
export interface CancelDurableRunDependencies {
  getDurableRun: (runId: string) => Promise<WorkflowState | null | undefined>;
  cancel: (runId: string) => Promise<unknown>;
}

/** What {@link resolveWaitForDurableRun} needs from the durable engine and the bureau's options. */
export interface WaitForDurableRunDependencies {
  getDurableRun: (runId: string) => Promise<WorkflowState | null | undefined>;
  /** Weft's result waiter for the run: resolves, or rejects with the run's own failure or another error. */
  awaitResult: (runId: string) => Promise<void>;
  /** `maintenance: 'manual'`, where Weft installs no cross-engine poll. */
  manualBackgroundTasks: boolean;
}

/**
 * The resolution algorithm behind {@link BureauTasks.wait}, independent of a real
 * `runtime.durable.engine`. A rejection of the result waiter is accepted only when the store then
 * confirms the run is terminal (a failed, cancelled or timed-out run rejects its own result);
 * any other rejection says nothing about the run and propagates.
 */
export async function resolveWaitForDurableRun(
  runId: string,
  dependencies: WaitForDurableRunDependencies,
): Promise<WorkflowState | null | undefined> {
  const isTerminal = (state: WorkflowState) =>
    !DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(state.status);
  const current = await dependencies.getDurableRun(runId);
  if (current === undefined || current === null) return current;
  if (isTerminal(current)) return current;
  // Weft's result waiter rechecks the store only inside `runMaintenance()` under
  // `backgroundTasks: 'manual'`, so a wait nothing re-drives could pend forever for a run another
  // bureau completes. Refuse it plainly instead of hanging.
  if (dependencies.manualBackgroundTasks) {
    throw new BureauError(
      `waitForDurableRun("${runId}") cannot wait under maintenance: 'manual', ` +
        `where nothing re-reads the durable store between maintenance passes; call ` +
        `maintain() and then getDurableRun() instead`,
      'UNSUPPORTED_CAPABILITY',
    );
  }
  let rejection: unknown;
  try {
    await dependencies.awaitResult(runId);
  } catch (error) {
    rejection = error;
  }
  const settled = await dependencies.getDurableRun(runId);
  if (settled === undefined || settled === null) return settled;
  if (isTerminal(settled)) return settled;
  throw rejection ?? new Error(`Durable run "${runId}" settled without reaching a terminal state`);
}

/**
 * The pure resolution algorithm behind {@link Bureau.cancelDurableRun}
 * (AB-37, AB-205), independent of any real `runtime.durable.engine` — see
 * {@link CancelDurableRunDependencies}. Never rejects.
 *
 * Resolution order: `getDurableRun` resolving `undefined` (no durable engine
 * composed) resolves `'unsupported-capability'`; resolving `null` (unknown to
 * the engine) resolves `'not-found'`; a resolved `WorkflowState.status`
 * already outside {@link DURABLE_FORCIBLY_TERMINABLE_STATUSES} resolves
 * `'already-terminal'` WITHOUT calling `cancel`. Otherwise `cancel(runId)` is
 * called — a rejection resolves `'failed'` with the error attached; a
 * resolution triggers a REQUIRED post-cancel re-read via `getDurableRun`,
 * because `cancel` resolving is not proof a cancellation record committed (it
 * can win OR lose a race against the workflow completing on its own): a
 * re-read observing `status === 'cancelled'` resolves `'requested'`; a
 * re-read observing any OTHER status outside
 * {@link DURABLE_FORCIBLY_TERMINABLE_STATUSES} (the race where normal
 * completion won instead) resolves `'already-terminal'`; a re-read
 * observing `null` (the run was purged between the two reads) resolves
 * `'not-found'`; a re-read observing `undefined` (the durable engine
 * vanished between the two reads — not expected in practice, since nothing
 * decomposes a bureau's durable engine mid-call, but never assumed) resolves
 * `'unsupported-capability'`; a re-read still reporting a status WITHIN
 * {@link DURABLE_FORCIBLY_TERMINABLE_STATUSES} means `cancel` resolved
 * without the cancellation actually committing — genuinely unproven, not a
 * success — and resolves `'failed'` rather than being misreported as
 * `'already-terminal'` (a code-review finding on this pull request).
 */
export async function resolveCancelDurableRun(
  runId: string,
  dependencies: CancelDurableRunDependencies,
): Promise<CancelDurableRunOutcome> {
  try {
    const state = await dependencies.getDurableRun(runId);
    if (state === undefined) {
      return { status: 'unsupported-capability' };
    }
    if (state === null) {
      return { status: 'not-found' };
    }
    if (!DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(state.status)) {
      return { status: 'already-terminal' };
    }

    try {
      await dependencies.cancel(runId);
    } catch (error) {
      return { status: 'failed', error };
    }

    const rereadState = await dependencies.getDurableRun(runId);
    if (rereadState === undefined) {
      return { status: 'unsupported-capability' };
    }
    if (rereadState === null) {
      return { status: 'not-found' };
    }
    if (rereadState.status === 'cancelled') {
      return { status: 'requested' };
    }
    if (!DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(rereadState.status)) {
      return { status: 'already-terminal' };
    }
    // `cancel` resolved without rejecting, but the post-cancel re-read still
    // reports a forcibly-terminable status — the cancellation record did not
    // actually commit. Reporting `'already-terminal'` here would be a false
    // positive; reporting `'requested'` would be an unproven claim. Neither
    // is honest, so this resolves `'failed'`.
    return {
      status: 'failed',
      error: new Error(
        `cancelDurableRun("${runId}"): engine.cancel resolved but the post-cancel re-read still ` +
          `reports status "${rereadState.status}" — the cancellation did not commit.`,
      ),
    };
  } catch (error) {
    return { status: 'failed', error };
  }
}

/**
 * COR-1614 — the field that marks a store action ending a run another process ended. Such an
 * action reaches this process's live frames and nothing else that reads the store's actions.
 */
export const COMMITTED_ELSEWHERE = 'committedElsewhere';

export function isCommittedElsewhere(action: { readonly detail: unknown }): boolean {
  const detail = action.detail;
  return typeof detail === 'object' && detail !== null && COMMITTED_ELSEWHERE in detail;
}

/**
 * The end a durable run another process cancelled, timed out, or failed stands for on this
 * process's store; `undefined` for any other state. A completed run is left out: a Bureau run that
 * is cancelled or times out never completes its workflow, and one that completes was driven by an
 * engine that reported it.
 */
export function endedElsewhereAs(
  state: WorkflowState,
): { readonly type: 'run.aborted' | 'run.error'; readonly error: Error } | undefined {
  if (state.status === 'cancelled') {
    return {
      type: 'run.aborted',
      error: new AbortAgentRunError('The run was cancelled by another process'),
    };
  }
  if (state.status === 'timed-out' || state.status === 'failed') {
    return {
      type: 'run.error',
      // Uncoded, so a stream reports it as `RUN_FAILED`, the code a peer streaming the same run
      // reads from its durable status.
      error: new Error(
        state.error ?? (state.status === 'timed-out' ? 'The run timed out' : 'The run failed'),
      ),
    };
  }
  return undefined;
}

/** The action types a run records as it reaches its terminal status. */
const TERMINAL_RUN_ACTION_TYPES: ReadonlySet<string> = new Set([
  'run.completed',
  'run.aborted',
  'run.error',
]);

/**
 * COR-424 — when a run reached its terminal status, by the runtime-clock
 * timestamp of its terminal action; `undefined` until it has recorded one.
 * A run-creation binding's retention window starts here.
 */
export function terminalActionTimestamp(
  actions: readonly { readonly type: string; readonly timestamp: number }[],
): number | undefined {
  return actions.findLast((action) => TERMINAL_RUN_ACTION_TYPES.has(action.type))?.timestamp;
}
