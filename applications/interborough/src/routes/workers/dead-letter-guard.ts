/**
 * What a dead-letter clear or retry is confirmed against. The dialog asks the person to type the task's
 * identifier, and in the time that takes the fleet moves: the dead letter may already have been
 * cleared (by someone else, or by a second tab), or the task may have been dead-lettered again
 * with a different record. The dead letter as the diagnostics listed it when the dialog opened is
 * compared with the one listed at confirmation, and a clear whose target changed or is gone is
 * refused, so the person sees what is there now before clearing it. A retry is confirmed the same
 * way, and a retry started from a task's own ledger also names the attempt that was dead-lettered,
 * so the server refuses it if the task has been dead-lettered again since.
 */
import { HttpClientError } from '@lostgradient/weft';

import { faultTreatment } from '../../lib/faults.ts';
import type { TaskDiagnosticItem, TaskLedgerDetail } from './worker-catalog-types.ts';

/** The dead letter a clear or retry names, as the diagnostics or the task ledger listed it. */
export interface DeadLetterTarget {
  readonly operationId: string;
  readonly queue: string;
  /** The activity that failed for good; absent when the diagnostics did not name it. */
  readonly activityName: string | undefined;
  /** When the task was dead-lettered, in epoch milliseconds, when the diagnostics say. */
  readonly deadLetteredAt: number | undefined;
  /**
   * Digest of the attempt that was dead-lettered, when the task's own ledger listed it. The
   * diagnostics do not carry it, so a dead letter read from them leaves it out.
   */
  readonly attemptTokenDigest: string | undefined;
}

/** The dead-lettered task `operationId` as `items` list it, or `null` when none does. */
export function deadLetterTarget(
  items: readonly TaskDiagnosticItem[],
  operationId: string,
): DeadLetterTarget | null {
  const item = items.find(
    (candidate) => candidate.kind === 'dead-lettered' && candidate.operationId === operationId,
  );
  if (item === undefined || item.queue === undefined) return null;
  return {
    operationId,
    queue: item.queue,
    activityName: 'activityName' in item ? item.activityName : undefined,
    deadLetteredAt: 'deadLetteredAt' in item ? item.deadLetteredAt : undefined,
    attemptTokenDigest: undefined,
  };
}

/**
 * The dead letter a task's own ledger shows, or `null` when the task is not dead-lettered. This is
 * the way to a dead letter the diagnostics do not list: one on a queue the queue list omits, or
 * beyond the diagnostics' page size.
 */
export function deadLetterTargetFromDetail(task: TaskLedgerDetail): DeadLetterTarget | null {
  if (task.state !== 'deadLettered') return null;
  const deadLettered = task.attempts.find(
    (attempt) => attempt.disposition === 'deadLettered' && attempt.attempt === task.attempt,
  );
  return {
    operationId: task.operationId,
    queue: task.queue,
    activityName: task.activityName,
    deadLetteredAt: task.deadLetteredAt,
    attemptTokenDigest: deadLettered?.attemptTokenDigest,
  };
}

/** Whether two reads of the diagnostics list the same dead letter: same task, queue, and moment. */
export function sameDeadLetter(
  observed: DeadLetterTarget | null,
  current: DeadLetterTarget | null,
): boolean {
  return (
    observed !== null &&
    current !== null &&
    observed.operationId === current.operationId &&
    observed.queue === current.queue &&
    observed.deadLetteredAt === current.deadLetteredAt &&
    observed.attemptTokenDigest === current.attemptTokenDigest
  );
}

const NOTHING_RETRIED = 'nothing was retried';

const UNKNOWN_OUTCOME =
  'The retry may or may not have happened: the answer did not arrive, so the outcome is unknown. Check the refreshed task ledger before you retry again.';

/** Why the server refused a retry, by the reason its Conflict named; each ends by saying nothing ran. */
const CONFLICT_REASON_MESSAGE: Readonly<Record<string, string>> = {
  'not-dead-lettered': `That task is no longer a dead letter, so ${NOTHING_RETRIED}. Check how it is now.`,
  'dead-letter-changed': `That task was dead-lettered again since you read it, so ${NOTHING_RETRIED}. Check how it is now, then retry it again if you still mean to.`,
  'workflow-finished': `The workflow that owns that task has finished, so ${NOTHING_RETRIED}. A finished workflow would drop the result.`,
  'concurrent-change': `Someone changed that task at the same time, so ${NOTHING_RETRIED}. Check how it is now, then retry it again if you still mean to.`,
};

/**
 * What the person is told when a retry did not end in an accepted answer. Only an explicit refusal
 * (a Conflict with a reason the server names, NotFound, or Forbidden) says nothing was retried,
 * because only then is it known. Anything else, such as a lost connection, a lost response or a
 * server fault, may have happened on the server before the answer was lost, so the message says
 * the outcome is unknown and sends the person to the refreshed ledger.
 */
export function retryRefusalMessage(error: unknown): string {
  const treatment = faultTreatment(error);
  if (treatment.kind === 'conflict') {
    const reason = error instanceof HttpClientError ? error.data?.['reason'] : undefined;
    if (typeof reason === 'string' && Object.hasOwn(CONFLICT_REASON_MESSAGE, reason)) {
      return CONFLICT_REASON_MESSAGE[reason] ?? UNKNOWN_OUTCOME;
    }
  }
  if (treatment.kind === 'not-found') {
    return `The server no longer holds that dead letter, so ${NOTHING_RETRIED}. It may have been cleared.`;
  }
  if (treatment.kind === 'unauthorized' && treatment.mode === 'forbidden') {
    return `Retrying a dead letter needs the system:admin scope, so ${NOTHING_RETRIED}.`;
  }
  return UNKNOWN_OUTCOME;
}
