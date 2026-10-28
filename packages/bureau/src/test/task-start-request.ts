import type { Bureau, StartTaskOptions, TaskHandle, TaskInput } from '../types.ts';

/**
 * One `bureau.tasks.start` call written as a single object, so a test can vary a start field by
 * field (`{ ...REQUEST, principal: 'bob' }`) the way a table of cases does.
 */
export type TaskStartRequest = StartTaskOptions & {
  readonly agentName: string;
  readonly input: TaskInput;
};

/** Starts the task `request` describes: `bureau.tasks.start(agentName, input, options)`. */
export function startTaskFrom(
  bureau: Pick<Bureau, 'tasks'>,
  { agentName, input, ...options }: TaskStartRequest,
): Promise<TaskHandle> {
  return bureau.tasks.start(agentName, input, options);
}
