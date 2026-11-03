/**
 * The one status vocabulary of the records pages (Runs, Workflows, Internal workflows, Agents and
 * Goals): seven words shown as a StatusDot. The Bureau has its own states for a task, a goal and a
 * schedule, and each page maps its own onto these words here, so no page invents a word of its own.
 *
 * The tone of a word is not decided here: Cinder's StatusDot owns the word-to-tone table, and
 * {@link StatusLabel} hands it the word, so the same word is the same colour everywhere (Running is
 * the blue `info` dot, Scheduled the hollow ring, Paused and Canceled neutral).
 * {@link STATUS_BADGE_VARIANTS} is the map for the places that must be a Badge, whose variants have
 * no `pending`: Scheduled reads as `info` and Paused as `neutral` there.
 */
import type { BadgeVariant } from '@lostgradient/cinder';

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

const WORKFLOW_RUN_WORDS: Readonly<
  Record<
    'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'suspended',
    StatusWord
  >
> = {
  pending: 'Scheduled',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Canceled',
  'timed-out': 'Failed',
  suspended: 'Paused',
};

/** The word an instance of a workflow reads as: one that timed out did not finish, so it has Failed. */
export function workflowRunStatusWord(status: keyof typeof WORKFLOW_RUN_WORDS): StatusWord {
  return WORKFLOW_RUN_WORDS[status];
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

const SCHEDULE_WORDS: Readonly<Record<'active' | 'paused' | 'cancelled', StatusWord>> = {
  active: 'Scheduled',
  paused: 'Paused',
  cancelled: 'Canceled',
};

/** The word a schedule reads as: an active one is Scheduled, because it is waiting for its next fire. */
export function scheduleStatusWord(status: keyof typeof SCHEDULE_WORDS): StatusWord {
  return SCHEDULE_WORDS[status];
}
