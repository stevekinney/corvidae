/**
 * What a dead-letter clear is confirmed against. The dialog asks the person to type the task's
 * identifier, and in the time that takes the fleet moves: the dead letter may already have been
 * cleared (by someone else, or by a second tab), or the task may have been dead-lettered again
 * with a different record. The dead letter as the diagnostics listed it when the dialog opened is
 * compared with the one listed at confirmation, and a clear whose target changed or is gone is
 * refused, so the person sees what is there now before clearing it.
 */
import type { TaskDiagnosticItem } from './worker-catalog-types.ts';

/** The dead letter a clear names, as the diagnostics listed it. */
export interface DeadLetterTarget {
  readonly operationId: string;
  readonly queue: string;
  /** The activity that failed for good; absent when the diagnostics did not name it. */
  readonly activityName: string | undefined;
  /** When the task was dead-lettered, in epoch milliseconds, when the diagnostics say. */
  readonly deadLetteredAt: number | undefined;
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
    observed.deadLetteredAt === current.deadLetteredAt
  );
}
