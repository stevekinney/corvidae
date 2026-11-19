import type { TaskWorkflow } from './task-workflow';

/** The workflow of an ordinary run (a chat's, with no schedule), for a test's hand-built task view. */
export const PLAIN_TASK_WORKFLOW: TaskWorkflow = {
  type: 'agentRun',
  scheduleId: null,
  scheduleName: null,
  tick: null,
  steps: null,
  awaitingSignal: null,
};
