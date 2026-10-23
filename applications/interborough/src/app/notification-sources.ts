/**
 * The reads the bell makes beyond the Bureau's reviews and tasks: the chats the Bureau lists, with
 * the title of each, which neither carries, and the name of the schedule behind a task it started, which a task does not
 * carry either (the audit trail's `schedule.fired` record does).
 */
import { queryAudit } from '../lib/bureau-audit.ts';
import { listContexts } from '../lib/bureau-client.ts';
import { listBureauSchedules } from '../lib/bureau-schedules.ts';
import type { TaskView } from '../lib/bureau-tasks.ts';
import type { ScheduleName } from './notification-items.ts';

/** How many chats the bell looks up: the most recently changed. */
export const TITLE_LOOKUP_LIMIT = 100;

type Options = { readonly signal?: AbortSignal };

/** Every chat the Bureau lists, by session, with its title (`null` for a chat that has none). */
export async function loadChats(options?: Options): Promise<ReadonlyMap<string, string | null>> {
  const page = await listContexts({ limit: TITLE_LOOKUP_LIMIT }, options);
  return new Map(page.contexts.map((context) => [context.id, context.title]));
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
): Promise<ReadonlyMap<string, ScheduleName>> {
  const scheduled = tasks.filter(isScheduledFailure);
  const names = new Map<string, ScheduleName>();
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
      // A description is prose; the agent's name stands in for it only when there is none.
      if (schedule?.description != null) {
        names.set(task.id, { name: schedule.description, identifier: false });
      } else if (schedule?.agentName != null) {
        names.set(task.id, { name: schedule.agentName, identifier: true });
      }
    }),
  );
  return names;
}
