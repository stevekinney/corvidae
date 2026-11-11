/**
 * The other runs that came from the same chat, for the Details rail of a run the Bureau holds as a
 * task: every task of the chat's session but this one, the most recently started first, a few of
 * them. Plain functions over the task list, so the rule is tested without a page.
 */
import type { TaskView } from '../../../lib/bureau-tasks.ts';

/** How many related runs the rail lists. */
export const CHAT_RELATED_LIMIT = 5;

/** The tasks of the same chat as `runId`, without it, the most recently started first. */
export function otherRunsOfChat(
  runId: string,
  tasks: readonly TaskView[],
  limit: number = CHAT_RELATED_LIMIT,
): TaskView[] {
  return tasks
    .filter((task) => task.id !== runId)
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, limit);
}
