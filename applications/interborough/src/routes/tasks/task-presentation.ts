/** How a task's state reads: its words are `copy.ts`'s, and this gives each one its badge. */
import type { BadgeVariant } from '@lostgradient/cinder';

import { TASK_COPY } from '../../app/copy.ts';
import type { TaskState } from '../../lib/bureau-tasks.ts';

export type TaskStatePresentation = {
  readonly label: string;
  readonly variant: BadgeVariant;
};

const VARIANTS: Readonly<Record<TaskState, BadgeVariant>> = {
  submitted: 'neutral',
  working: 'info',
  'input-required': 'warning',
  completed: 'success',
  failed: 'danger',
  canceled: 'neutral',
};

export function taskStatePresentation(state: TaskState): TaskStatePresentation {
  return { label: TASK_COPY.states[state], variant: VARIANTS[state] };
}

/** The states a task can be narrowed by, in the order a person reads them. */
export const TASK_STATE_ORDER: readonly TaskState[] = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
];
