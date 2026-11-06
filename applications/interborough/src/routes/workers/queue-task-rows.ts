/**
 * How a task on a queue reads as a row of the Workers page (COR-2018, rows 78o, 79b, 79d): its
 * status word, the activity it runs in monospace, the workflow run it is for, line two, and the
 * moment at the right. A failed task says how many tries it took and why; a waiting one says what
 * it waits for, or, once it was put back, that it is back and which try it is.
 */
import { activityTime, dayLabel } from '../health/health-times.ts';
import type { QueueTask } from './queue-tasks-data.ts';
import { WORKER_COPY } from './worker-copy.ts';
import { humanizeWorkflowType } from './worker-model.ts';

/** One row of the tasks list. */
export interface QueueTaskRow {
  /** The task's operation id. */
  readonly id: string;
  /** The status word: red for a task that failed for good, the hollow ring for one that waits. */
  readonly word: 'Failed for good' | 'Waiting';
  /** The activity the task runs, which is the name an operator knows it by. */
  readonly name: string;
  /** The run the task is for, when it names one: its id and the workflow as a person reads it. */
  readonly run: { readonly id: string; readonly label: string } | undefined;
  /** Line two. */
  readonly line: string;
  /** The moment at the right: the day it failed, or the clock time it queued. */
  readonly time: string;
  /** Whether the task is a failed one an operator can retry, clear, and read the payload of. */
  readonly failed: boolean;
}

/** A sentence's cause, ended with one full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The rows of `tasks` for the queue `queue`. A failed task in `retrying` is already on its way back
 * (Retry puts it in the queue at once), so it reads as waiting again, on its next try, with the day
 * it failed still at the right.
 */
export function queueTaskRows(
  tasks: readonly QueueTask[],
  queue: string,
  retrying: ReadonlySet<string>,
  now: number,
): QueueTaskRow[] {
  const copy = WORKER_COPY.tasks;
  return tasks.map((task) => {
    const run =
      task.workflowId === undefined
        ? undefined
        : { id: task.workflowId, label: copy.runLink(humanizeWorkflowType(task.workflowType)) };
    if (task.status === 'failed' && !retrying.has(task.operationId)) {
      const cause = task.error ?? copy.unknownCause;
      return {
        id: task.operationId,
        word: 'Failed for good',
        name: task.activityName,
        run,
        line: sentence(copy.failedLine(task.attempt, cause)),
        time: dayLabel(task.at),
        failed: true,
      };
    }
    const putBack = task.status === 'failed' || task.attempt > 1;
    return {
      id: task.operationId,
      word: 'Waiting',
      name: task.activityName,
      run,
      line: putBack
        ? copy.backLine(task.status === 'failed' ? task.attempt + 1 : task.attempt)
        : copy.waitingLine(queue),
      time: task.status === 'failed' ? dayLabel(task.at) : activityTime(task.at, now),
      failed: false,
    };
  });
}
