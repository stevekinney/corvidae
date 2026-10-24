/**
 * The Bureau's most recently changed tasks, and what they say about each chat: the one read the
 * notification bell and the chat list share, so the two cannot disagree about whether a chat's
 * latest run failed. A chat's latest run stands for all its earlier ones; and because the listing
 * is newest first, a chat with any run in it has its latest run in it too.
 */
import { listTasks, type TaskView } from './bureau-tasks.ts';

/** How many of the Bureau's most recently changed tasks are looked at. */
export const RECENT_TASK_LIMIT = 50;

/** The query that reads them. Each reader adds its own refetch policy. */
export function recentTasksQuery(): {
  readonly queryKey: readonly ['bureau-tasks', 'recent'];
  readonly queryFn: (context: { signal: AbortSignal }) => ReturnType<typeof listTasks>;
} {
  return {
    queryKey: ['bureau-tasks', 'recent'],
    queryFn: ({ signal }) => listTasks({ limit: RECENT_TASK_LIMIT }, { signal }),
  };
}

/** The latest run of each chat, by session: the task changed last. */
export function latestRunByChat(tasks: readonly TaskView[]): Map<string, TaskView> {
  const latest = new Map<string, TaskView>();
  for (const task of tasks) {
    const seen = latest.get(task.contextId);
    if (seen === undefined || Date.parse(task.updatedAt) > Date.parse(seen.updatedAt)) {
      latest.set(task.contextId, task);
    }
  }
  return latest;
}

/** The chats whose latest run failed, by session. */
export function chatsWithFailedRun(tasks: readonly TaskView[]): ReadonlySet<string> {
  const failed = new Set<string>();
  for (const [contextId, task] of latestRunByChat(tasks)) {
    if (task.status === 'failed') failed.add(contextId);
  }
  return failed;
}
