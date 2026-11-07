/**
 * The order a person reads a run's states in, and which of them mean a run is over. The words each
 * state is shown with are `copy.ts`'s `TASK_COPY.states`.
 */
import type { TaskState } from './bureau-tasks.ts';

/** The states a run can be narrowed by, in the order a person reads them. */
export const TASK_STATE_ORDER: readonly TaskState[] = [
  'input-required',
  'working',
  'completed',
  'failed',
  'canceled',
];

/** Whether a task in `state` is over, so nothing more will happen to it. */
export function isTaskOver(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled';
}
