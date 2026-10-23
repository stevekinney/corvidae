/**
 * The reads the bell makes beyond the Bureau's reviews and tasks: the title of each chat, which
 * neither carries, and the name of the schedule behind a task it started, which a task does not
 * carry either (the audit trail's `schedule.fired` record does).
 */
import { queryAudit } from '../lib/bureau-audit.ts';
import { listContexts } from '../lib/bureau-client.ts';
import { listBureauSchedules } from '../lib/bureau-schedules.ts';
import type { TaskView } from '../lib/bureau-tasks.ts';

/** How many chats the bell looks titles up in: the most recently changed. */
export const TITLE_LOOKUP_LIMIT = 100;

type Options = { readonly signal?: AbortSignal };

/** The title of each chat that has one, by session. */
export async function loadChatTitles(options?: Options): Promise<ReadonlyMap<string, string>> {
  const page = await listContexts({ limit: TITLE_LOOKUP_LIMIT }, options);
  return new Map(
    page.contexts.flatMap((context) =>
      context.title === null ? [] : [[context.id, context.title]],
    ),
  );
}

/** Whether a task was started by a schedule's fire rather than by the person. */
export function isScheduledFailure(task: TaskView): boolean {
  return task.status === 'failed' && task.actor !== null;
}

/**
 * The name of the schedule that started each failed scheduled task: its description, or the agent
 * it runs. A task whose fire the trail does not name, or whose schedule is gone, has no entry and
 * is worded as a failed run of its agent.
 */
export async function loadScheduleNames(
  tasks: readonly TaskView[],
  options?: Options,
): Promise<ReadonlyMap<string, string>> {
  const scheduled = tasks.filter(isScheduledFailure);
  const names = new Map<string, string>();
  if (scheduled.length === 0) return names;
  const schedules = await listBureauSchedules(options);
  const byId = new Map(schedules.map((schedule) => [schedule.id, schedule]));
  await Promise.all(
    scheduled.map(async (task) => {
      const page = await queryAudit({ resource: task.id, type: 'schedule.fired' }, undefined, {
        ...options,
        limit: 1,
      });
      const scheduleId = page.records[0]?.detail?.['scheduleId'];
      const schedule = typeof scheduleId === 'string' ? byId.get(scheduleId) : undefined;
      const name = schedule?.description ?? schedule?.agentName;
      if (name !== undefined && name !== null) names.set(task.id, name);
    }),
  );
  return names;
}
