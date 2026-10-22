/**
 * Every exit from a terminal message ends the run's waiter.
 *
 * A `completed` or `failed` message from the strategy ends in the engine's terminal write. The write
 * can end in a committed record, a refusal, a record another writer changed, or an error nobody
 * classified, and the strategy contains whatever the handler throws, so an exit that settles nothing
 * leaves the run `running` with `result()` pending until the next boot. This module is the one place
 * that closes that class: whatever the terminal write did, the run's waiter ends here.
 *
 * @module core/engine/terminal-run-exit
 */
import type { WorkerOutboundMessage } from '../types.ts';
import type { RefusedStorageWrite } from './checkpoint-commit-failed-error.ts';
import { CheckpointCommitFailedError } from './checkpoint-commit-failed-error.ts';
import { abandonWorkflowAfterCheckpointConflict } from './checkpoint-conflict-abandon.ts';
import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import { CheckpointEncodingError } from './checkpoint-encoding-error.ts';
import { EngineDisposedError } from './errors.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';
import { EngineDeposedError } from './lease-errors.ts';
import { failWorkflow, type TerminationCallbacks } from './termination.ts';
import {
  captureTerminatedRun,
  settleRunFromStoredRecord,
  type TerminatedRun,
  waiterForRun,
} from './termination/settle-refused-terminal.ts';

/** What the terminal path needs of the engine's callbacks. */
type TerminationSource = { readonly createTerminationCallbacks: () => TerminationCallbacks };

/** The terminal write a message ends in, or `undefined` for a message that is not terminal. */
export function terminalWriteOf(
  message: WorkerOutboundMessage,
): Extract<RefusedStorageWrite, 'completion' | 'failure'> | undefined {
  if (message.type === 'completed') return 'completion';
  return message.type === 'failed' ? 'failure' : undefined;
}

/** Whether `error` says the engine itself stopped, which no terminal path may write through. */
export function isEngineStopped(error: unknown): boolean {
  return error instanceof EngineDisposedError || error instanceof EngineDeposedError;
}

/**
 * A terminal message returned without an error. `run` is the run as captured before the message
 * was handled, since the terminal commit releases what identifies it. When its waiter is still registered, the
 * write did not settle it (the record was already terminal, or another writer ended the run), so
 * settle it from the stored record. A record that is still `running` is left alone: the run's own
 * transition, or the writer that holds it, ends it.
 */
export async function settleUnsettledTerminalMessage(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationSource,
  run: TerminatedRun,
): Promise<void> {
  await settleRunFromStoredRecord(
    internals,
    workflowId,
    callbacks.createTerminationCallbacks(),
    run,
  );
}

/**
 * Whether `run`'s result waiter is still registered, which a settled run's is not. Synchronous, so
 * the completion path, whose waiter is settled and gone by now, pays no promise turn to ask.
 */
export function isTerminalWaiterPending(
  internals: EngineInternals,
  workflowId: string,
  run: TerminatedRun,
): boolean {
  const waiter = waiterForRun(internals, workflowId, run);
  return waiter !== undefined && internals.resultResolvers.get(workflowId) === waiter;
}

/**
 * Whether the engine already released everything it held for `run`, which only the run's own
 * terminal commit does: the error came after the commit, from the events or the cleanup that follow
 * it, and the waiter was settled by then. Nothing is left to settle, release or write.
 */
function terminalBookkeepingDone(
  internals: EngineInternals,
  workflowId: string,
  run: TerminatedRun,
): boolean {
  const holding = currentExecutionAttempt(internals, workflowId)?.workflowExecutionToken;
  return run.held && holding !== run.workflowExecutionToken;
}

/** The error a run ends with when a write failed: the typed error itself, or one wrapping `cause`. */
function commitFailureOf(
  workflowId: string,
  write: RefusedStorageWrite,
  cause: unknown,
  run: TerminatedRun,
): CheckpointCommitFailedError {
  return cause instanceof CheckpointCommitFailedError
    ? cause
    : new CheckpointCommitFailedError(workflowId, {
        write,
        cause,
        workflowExecutionToken: run.workflowExecutionToken,
      });
}

/**
 * Stop driving the generation and reject its waiter with `failure`: nothing durable can be written,
 * so the record stays `running` and the next boot recovers the run from its last committed
 * checkpoint. A waiter the abandonment did not reach (the engine holds no attempt for the run) is
 * rejected directly, so no exit leaves it pending.
 */
function abandonRun(
  internals: EngineInternals,
  workflowId: string,
  failure: CheckpointCommitFailedError,
  run: TerminatedRun,
): void {
  abandonWorkflowAfterCheckpointConflict(internals, failure);
  const waiter = internals.resultResolvers.get(workflowId);
  if (waiter !== undefined && waiter === waiterForRun(internals, workflowId, run)) {
    internals.resultResolvers.delete(workflowId);
    waiter.reject(failure);
  }
}

/**
 * End a run whose terminal write, or whose checkpoint, failed with `error`, in this order:
 *
 * 1. The stored record may already have ended the run (its own write landed, or another writer
 *    ended it): settle the waiter from it and release what the run held.
 * 2. Otherwise fail the run as a `system` failure with `failWith`, unless the failure write is what
 *    failed. The failure write retries and re-decides on its own; once it returns, a waiter still
 *    pending is settled from the record.
 * 3. If even that cannot be written, abandon the generation locally and reject the waiter.
 *
 * `capturedRun` is the run as captured before a terminal message was handled; without it the run
 * is captured now. `failWith` is the error the run fails with when it is not the typed commit failure, such as a
 * checkpoint that cannot be encoded. An engine that stopped (disposed, deposed) is never written
 * through: its error is rethrown.
 */
export async function endRunAfterFailedWrite(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationSource,
  error: unknown,
  write: RefusedStorageWrite,
  failWith?: Error,
  capturedRun?: TerminatedRun,
): Promise<void> {
  const run = capturedRun ?? captureTerminatedRun(internals, workflowId);
  if (terminalBookkeepingDone(internals, workflowId, run)) return;
  const termination = callbacks.createTerminationCallbacks();
  const recorded = await settleRunFromStoredRecord(internals, workflowId, termination, run);
  if (recorded === 'settled' || recorded === 'replaced') return;
  const failure = commitFailureOf(workflowId, write, error, run);
  if (write === 'failure') return abandonRun(internals, workflowId, failure, run);
  try {
    await failWorkflow(internals, workflowId, failWith ?? failure, termination, 'system');
    // Only a waiter failing the run left pending: with none registered, failing it already wrote and
    // announced the outcome, and settling again would announce it twice.
    if (isTerminalWaiterPending(internals, workflowId, run)) {
      await settleRunFromStoredRecord(internals, workflowId, termination, run);
    }
  } catch (failureError) {
    if (isEngineStopped(failureError)) throw failureError;
    abandonRun(
      internals,
      workflowId,
      commitFailureOf(workflowId, 'failure', failureError, run),
      run,
    );
  }
}

/** Whether an error out of a checkpoint turn ends the run: an unencodable or uncommittable one. */
function endsRunOnCheckpointError(error: unknown): boolean {
  return error instanceof CheckpointEncodingError || error instanceof CheckpointCommitFailedError;
}

/**
 * What `handleStrategyMessage` does with an error its message handler threw:
 *
 * - A checkpoint commit that lost its compare-and-swap race means another engine over the same
 *   store already advanced this workflow and owns its durable state. `commitCheckpoint` already
 *   abandoned the run where it detected the loss, so all that is left is to write nothing: failing
 *   the workflow here would overwrite the winner.
 * - An engine that stopped is rethrown.
 * - A checkpoint turn's error that is neither unencodable nor uncommittable is rethrown too: it is
 *   the strategy's to report, and this module ends only the runs the storage could not carry.
 * - Anything else ends the run (`endRunAfterFailedWrite`). An error nobody classified out of a
 *   terminal message is still the strategy's to report, so it is rethrown after the run has ended.
 */
export async function endRunAfterStrategyError(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationSource,
  error: unknown,
  terminalWrite: Extract<RefusedStorageWrite, 'completion' | 'failure'> | undefined,
  run: TerminatedRun | undefined,
): Promise<void> {
  if (error instanceof WorkflowCheckpointConflictError) return;
  if (isEngineStopped(error)) throw error;
  if (terminalWrite === undefined && !endsRunOnCheckpointError(error)) throw error;
  await endRunAfterFailedWrite(
    internals,
    workflowId,
    callbacks,
    error,
    terminalWrite ?? 'checkpoint',
    error instanceof CheckpointEncodingError ? error : undefined,
    run,
  );
  if (!endsRunOnCheckpointError(error)) throw error;
}
