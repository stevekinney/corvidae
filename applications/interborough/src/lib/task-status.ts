/**
 * How a run's state reads, everywhere a person sees one: the chat's task strip, the runs list, and
 * a run's page. The Bureau has six task states and a person needs five words (`copy.ts`'s
 * `TASK_COPY.states`): a task that is submitted has not started, which is Working to anyone
 * waiting on it. This gives each state its words and its badge, so no screen invents its own.
 */
import type { BadgeVariant } from '@lostgradient/cinder';

import { TASK_COPY } from '../app/copy.ts';
import type { TaskState } from './bureau-tasks.ts';

export type TaskStatePresentation = {
  readonly label: string;
  readonly variant: BadgeVariant;
};

const VARIANTS: Readonly<Record<TaskState, BadgeVariant>> = {
  submitted: 'info',
  working: 'info',
  'input-required': 'warning',
  completed: 'success',
  failed: 'danger',
  canceled: 'neutral',
};

export function taskStatePresentation(state: TaskState): TaskStatePresentation {
  return { label: TASK_COPY.states[state], variant: VARIANTS[state] };
}

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
