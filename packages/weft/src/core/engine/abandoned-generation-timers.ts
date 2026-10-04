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
 * engine that never drives it. Deadline records carry no generation, so the
 * stored workflow state decides: only a deadline recorded for the generation this
 * engine abandoned is left for the winner.
 */
export function fireExecutionDeadline(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: {
    loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
    timeout: (workflowId: string) => Promise<void>;
  },
): Promise<void> {
  if (!isCurrentCheckpointGenerationAbandoned(internals, entry.workflowId)) {
    return callbacks.timeout(entry.workflowId);
  }
  return fireDeadlineBesideAbandonedGeneration(internals, entry, callbacks);
}

async function fireDeadlineBesideAbandonedGeneration(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: {
    loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
    timeout: (workflowId: string) => Promise<void>;
  },
): Promise<void> {
  const state = await callbacks.loadWorkflowState(entry.workflowId);
  if (
    state !== null &&
    !isCheckpointGenerationAbandoned(internals, entry.workflowId, state.workflowExecutionToken)
  ) {
    await callbacks.timeout(entry.workflowId);
    return;
  }
  await retainDiscardedDurableTimer(entry.id, entry.workflowId, () => Promise.resolve(state));
}
