/**
 * The one status vocabulary of the records pages (Runs, Workflows, Internal workflows, Agents and
 * Goals): seven words, each with one tone, shown as a StatusDot. The Bureau has its own states for a
 * task, a goal and a schedule, and each page maps its own onto these words here, so no page invents
 * a word of its own and the same word is the same colour everywhere.
 *
 * The tone is a StatusDot `status` (`accent` for Running through `offline` for Paused), and
 * {@link STATUS_BADGE_VARIANTS} is the same map for the places that must be a Badge, whose variants
 * have no `pending` or `offline`: Scheduled reads as `info` and Paused as `neutral` there.
 */
import type { BadgeVariant, StatusDotStatus } from '@lostgradient/cinder';

import type { Goal, GoalStatus } from './bureau-goals.ts';
import type { TaskState } from './bureau-tasks.ts';

/** The seven words a status reads as, in the order a person reads them. */
export const STATUS_WORDS = [
  'Running',
  'Waiting on you',
  'Done',
  'Failed',
  'Canceled',
  'Scheduled',
  'Paused',
] as const;

/** One of the seven words. */
export type StatusWord = (typeof STATUS_WORDS)[number];

/** The StatusDot tone of each word. */
export const STATUS_TONES: Readonly<Record<StatusWord, StatusDotStatus>> = {
  Running: 'accent',
  'Waiting on you': 'warning',
  Done: 'success',
  Failed: 'danger',
  Canceled: 'neutral',
  Scheduled: 'pending',
  Paused: 'offline',
};

/** The Badge variant of each word, for the few places that show a status as a Badge. */
export const STATUS_BADGE_VARIANTS: Readonly<Record<StatusWord, BadgeVariant>> = {
  Running: 'accent',
  'Waiting on you': 'warning',
  Done: 'success',
  Failed: 'danger',
  Canceled: 'neutral',
  Scheduled: 'info',
  Paused: 'neutral',
};

const TASK_WORDS: Readonly<Record<TaskState, StatusWord>> = {
  submitted: 'Running',
  working: 'Running',
  'input-required': 'Waiting on you',
  completed: 'Done',
  failed: 'Failed',
  canceled: 'Canceled',
};

/** The word a task's state reads as: a submitted task has not started, which is Running to whoever waits on it. */
export function taskStatusWord(state: TaskState): StatusWord {
  return TASK_WORDS[state];
}

const GOAL_WORDS: Readonly<Record<GoalStatus, StatusWord>> = {
  pending: 'Scheduled',
  running: 'Running',
  evaluating: 'Running',
  retrying: 'Running',
  succeeded: 'Done',
  exhausted: 'Failed',
  failed: 'Failed',
  canceled: 'Canceled',
};

/** The word a goal's status reads as: a goal that spent its attempts without passing has failed. */
export function goalStatusWord(status: GoalStatus): StatusWord {
  return GOAL_WORDS[status];
}

const ATTEMPT_WORDS: Readonly<Record<Goal['attempts'][number]['status'], StatusWord>> = {
  running: 'Running',
  evaluating: 'Running',
  passed: 'Done',
  failed: 'Failed',
  aborted: 'Canceled',
};

/** The word a goal attempt's status reads as: an attempt the goal stopped before it finished was Canceled. */
export function attemptStatusWord(status: Goal['attempts'][number]['status']): StatusWord {
  return ATTEMPT_WORDS[status];
}

/**
 * The word a workflow reads as, from what is known of it: a file the Bureau cannot use, or a source
 * the engine failed to load, has Failed; a paused file is Paused; one with an instance going is
 * Running; one with something that starts it is Scheduled. A workflow with none of those has no
 * status, and `null` says so rather than inventing one.
 */
export function workflowStatusWord(workflow: {
  readonly invalid: boolean;
  readonly failed: boolean;
  readonly paused: boolean;
  readonly running: number;
  readonly started: boolean;
}): StatusWord | null {
  if (workflow.invalid || workflow.failed) return 'Failed';
  if (workflow.paused) return 'Paused';
  if (workflow.running > 0) return 'Running';
  return workflow.started ? 'Scheduled' : null;
}
