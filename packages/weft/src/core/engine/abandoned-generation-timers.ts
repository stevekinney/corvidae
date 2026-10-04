import type { TimerEntry, WorkflowState } from '../types.ts';
import {
  isCheckpointGenerationAbandoned,
  isCurrentCheckpointGenerationAbandoned,
} from './abandoned-checkpoint-generations.ts';
import type { EngineInternals } from './internals.ts';
import { retainDiscardedDurableTimer } from './sleep-timer-acknowledgements.ts';

/**
 * A generation this engine abandoned after losing a checkpoint compare-and-swap
 * race belongs to the winning engine, so a timer that needs that run's in-memory
 * state (a review's escalation or timeout handler) is the winner's to fire.
 * Returns the retention promise (which throws, so the scheduler retries and keeps
 * the durable record) for such a timer, and `undefined` while this engine holds
 * no abandoned generation for the workflow. It holds the abandoned one for as
 * long as nothing replaces it, so a replacement generation's review timers are
 * retained too, deliberately: this engine has no handler for them, and processing
 * one would only consume the record the engine driving that generation needs.
 * Deliberately not `async`: a healthy timer fire takes the path it always did.
 */
export function retainTimerOfAbandonedGeneration(
  internals: EngineInternals,
  entry: TimerEntry,
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>,
): Promise<void> | undefined {
  if (!isCurrentCheckpointGenerationAbandoned(internals, entry.workflowId)) return undefined;
  return retainDiscardedDurableTimer(entry.id, entry.workflowId, loadWorkflowState);
}

/**
 * Fire an execution-deadline timer, unless it belongs to an abandoned generation.
 * Not `async`: see above.
 *
 * Unlike a sleep, condition, or review timer, a deadline needs nothing in this
 * engine's memory: `timeout` is an external terminal transition that any engine
 * sharing the store may commit. So an engine whose in-memory generation was
 * abandoned must not treat every deadline for the id as the abandoned run's.
 * Another engine may have finished that run and started a replacement under the
 * same id, and the replacement's deadline would then be retained forever by an
 * engine that never drives it. Deadline records carry no generation, so the stored
 * workflow state decides, and it must agree with the record twice. The stored
 * generation must not be the abandoned one, which is left for the winner. And the
 * stored deadline must have been reached by the record, because a record armed for
 * an earlier generation can reach the loser after a replacement started (the
 * scheduler scans first and loads state afterwards), and timing the replacement out
 * with it would kill a healthy run: only a stored deadline at or before the
 * record's `fireAt` has certainly passed, since the scheduler fires nothing early.
 * Anything else is retained for the engine that owns the stored generation, whose
 * own deadline record is the same durable key.
 *
 * Both conditions are checked again by the terminal write itself, against the state it
 * replaces: a replacement may land between the first check and that write, and the
 * write must not follow the stale validation onto it.
 */
export function fireExecutionDeadline(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: ExecutionDeadlineCallbacks,
): Promise<void> {
  if (!isCurrentCheckpointGenerationAbandoned(internals, entry.workflowId)) {
    return callbacks.timeout(entry.workflowId);
  }
  return fireDeadlineBesideAbandonedGeneration(internals, entry, callbacks);
}

type ExecutionDeadlineCallbacks = {
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  timeout: (workflowId: string, skipCommitIf?: (state: WorkflowState) => boolean) => Promise<void>;
};

async function fireDeadlineBesideAbandonedGeneration(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: ExecutionDeadlineCallbacks,
): Promise<void> {
  const reachedByRecord = (stored: WorkflowState): boolean =>
    !isCheckpointGenerationAbandoned(internals, entry.workflowId, stored.workflowExecutionToken) &&
    stored.executionDeadline !== undefined &&
    stored.executionDeadline <= entry.fireAt;

  const state = await callbacks.loadWorkflowState(entry.workflowId);
  if (state === null || !reachedByRecord(state)) {
    await retainDiscardedDurableTimer(entry.id, entry.workflowId, () => Promise.resolve(state));
    return;
  }

  // The read above and the terminal write are separated by the awaits `timeout` makes
  // before it commits, and another engine may finish the validated generation and start
  // a replacement under the same id in that window. So the rule is enforced again, against
  // the state the write is about to replace, and a write that no longer qualifies is refused.
  let refused = false;
  await callbacks.timeout(entry.workflowId, (stored) => {
    refused = !reachedByRecord(stored);
    return refused;
  });
  if (!refused) return;
  // Refusing the write is not processing the record: it now belongs to the replacement
  // that shares the durable `deadline:{id}` key, and the scheduler deletes that key
  // whenever a callback returns normally. So retain it, judged by the state as it stands.
  await retainDiscardedDurableTimer(entry.id, entry.workflowId, callbacks.loadWorkflowState);
}
