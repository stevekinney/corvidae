import type { Bureau, TaskHandle } from '@lostgradient/bureau';

/**
 * Starts a task of `agentName` over `input` and waits for its result, for a test that reads only
 * the outcome of one task.
 */
export async function runTask(
  bureau: Pick<Bureau, 'tasks'>,
  agentName: string,
  input: string,
): ReturnType<TaskHandle['result']> {
  const task = await bureau.tasks.start(agentName, input);
  return task.result();
}
