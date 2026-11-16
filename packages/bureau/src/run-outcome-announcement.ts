/**
 * The events a settled run announces: one outcome event (`run.completed`, `run.error` or
 * `run.aborted`), then `run.settled`.
 *
 * Every run reaches this the same way. A chat run, a goal attempt, a workflow step, a child, a
 * schedule fire and a task settled at boot all settle through the task registry, which calls its
 * `onSettled` once for the settlement that stands (COR-1868, `catalog-task-settlement.ts`), so
 * this is the one seam that publishes the outcome and a run is announced exactly once. A run whose
 * `owner-lost` inference is later replaced by its owner's real settlement is announced again, as
 * `run.settled` always was: the second settlement is a committed change, on the owner's feed.
 *
 * @module run-outcome-announcement
 */

import {
  RunAbortedOutcomeEvent,
  RunCompletedOutcomeEvent,
  RunFailedOutcomeEvent,
  RunSettledEvent,
} from './events.ts';
import type { RunOutcomeDetails } from './run-outcome-details.ts';
import type { TaskRecord } from './task-registry.ts';

/** What `finishReason` a failed run reports when its settlement recorded none. */
const FAILURE_WITHOUT_FINISH_REASON = 'error';

/** What an announcement reads and where it sends the events. */
export interface RunOutcomeAnnouncement {
  /** What each failed run's live `RunErrorEvent` said. */
  readonly details: Pick<RunOutcomeDetails, 'take'>;
  /** Sends one event, in order, to the Bureau's emitter. */
  readonly dispatch: (
    event:
      RunAbortedOutcomeEvent | RunCompletedOutcomeEvent | RunFailedOutcomeEvent | RunSettledEvent,
  ) => void;
}

/**
 * Announces the settlement `record` holds: the outcome event for its status, then `run.settled`
 * with the status and finish reason. A record that is not settled announces nothing.
 */
export function announceRunOutcome(
  record: Pick<TaskRecord, 'taskId' | 'settled'>,
  { details, dispatch }: RunOutcomeAnnouncement,
): void {
  const settled = record.settled;
  // Taken whatever the status, so an entry for a run that did not fail is never left behind.
  const failure = details.take(record.taskId);
  if (settled === undefined) return;
  const finishReason = settled.finishReason ?? undefined;
  switch (settled.status) {
    case 'completed':
      dispatch(new RunCompletedOutcomeEvent(record.taskId, finishReason));
      break;
    case 'canceled':
      dispatch(new RunAbortedOutcomeEvent(record.taskId, finishReason));
      break;
    case 'failed':
      // No error text: the settlement's message is read through the authorized task read.
      dispatch(
        new RunFailedOutcomeEvent(
          record.taskId,
          finishReason ?? FAILURE_WITHOUT_FINISH_REASON,
          failure,
        ),
      );
      break;
  }
  dispatch(new RunSettledEvent(record.taskId, settled.status, finishReason));
}
