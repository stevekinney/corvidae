/**
 * Where an engine status opens on `/runs`. `/runs` is the Bureau's task list, which has five words
 * for a run's state, and the engine has seven: a run the engine holds as pending, running, or
 * suspended is still going, which is Working to the person waiting on it; a run that timed out
 * failed; the engine spells cancelled with two l's and a task with one. Each engine status opens the
 * list on the state it reads as, so the filter the link names is one the list has.
 */
import type { WorkflowStatus } from '@lostgradient/weft';

import type { TaskState } from '../../lib/bureau-tasks.ts';

const TASK_STATE_OF_STATUS = {
  pending: 'working',
  running: 'working',
  suspended: 'working',
  completed: 'completed',
  cancelled: 'canceled',
  failed: 'failed',
  'timed-out': 'failed',
} as const satisfies Record<WorkflowStatus, TaskState>;

/** The address of the runs list narrowed to the state `status` reads as. */
export function runsPathForStatus(status: WorkflowStatus): string {
  return `/runs?status=${TASK_STATE_OF_STATUS[status]}`;
}
