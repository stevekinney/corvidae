import type { RunResult } from '@lostgradient/operative';

import type { Bureau, StartTaskOptions, TaskHandle, TaskInput } from '../types.ts';

/**
 * Starts a task of `agentName` and waits for its result, the shape a test that reads only the
 * outcome of one task takes. A test fixture over {@link BureauTasks.start} and
 * {@link TaskHandle.result}.
 */
export async function runTask(
  bureau: { readonly tasks: Pick<Bureau['tasks'], 'start'> },
  agentName: string,
  input: TaskInput,
  options?: StartTaskOptions,
): Promise<RunResult<unknown>> {
  const task = await bureau.tasks.start(agentName, input, options);
  return task.result();
}

/** The text a task settled with, once it has ended. */
export async function taskContent(task: Pick<TaskHandle, 'result'>): Promise<string> {
  const result = await task.result();
  return result.content;
}
