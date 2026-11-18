/**
 * The other runs that came from the same chat, for the Details rail of a run the Bureau holds as a
 * task: every task of the chat's session but this one, the most recently started first, a few of
 * them. Plain functions over the task list, so the rule is tested without a page.
 */
import type { TaskView } from '../../../lib/bureau-tasks.ts';

/** How many related runs the rail lists. */
export const CHAT_RELATED_LIMIT = 5;

/**
 * The runs of `runId`'s own piece of work (COR-2423): it, the runs that continue it after their
 * approvals were decided, and the runs it continues, followed both ways. Runs lists them as one
 * row, so none is another run of the chat.
 */
function sameWork(runId: string, tasks: readonly TaskView[]): Set<string> {
  const work = new Set<string>([runId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) {
      const continues = task.continues ?? null;
      if (continues === null) continue;
      if (work.has(continues) && !work.has(task.id)) {
        work.add(task.id);
        grew = true;
      }
      if (work.has(task.id) && !work.has(continues)) {
        work.add(continues);
        grew = true;
      }
    }
  }
  return work;
}

/**
 * The tasks of the same chat as `runId`, without it and without the runs of its own piece of work
 * (a continuation and the run it continues are one row on Runs), the most recently started first.
 */
export function otherRunsOfChat(
  runId: string,
  tasks: readonly TaskView[],
  limit: number = CHAT_RELATED_LIMIT,
): TaskView[] {
  const own = sameWork(runId, tasks);
  return tasks
    .filter((task) => !own.has(task.id))
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, limit);
}
