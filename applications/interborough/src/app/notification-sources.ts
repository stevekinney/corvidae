/**
 * The reads the bell makes beyond the Bureau's reviews, tasks and notifications: the chats the
 * Bureau lists, with the title of each, which none of them carries, and the name of the schedule a
 * failed run's notification names (`subject.scheduleId`).
 */
import { listContexts } from '../lib/bureau-client.ts';
import { listBureauSchedules } from '../lib/bureau-schedules.ts';
import type { ScheduleName } from './notification-items.ts';

/** How many chats the bell looks up: the most recently changed. */
export const TITLE_LOOKUP_LIMIT = 100;

type Options = { readonly signal?: AbortSignal };

/** Every chat the Bureau lists, by session, with its title (`null` for a chat that has none). */
export async function loadChats(options?: Options): Promise<ReadonlyMap<string, string | null>> {
  const page = await listContexts({ limit: TITLE_LOOKUP_LIMIT }, options);
  return new Map(page.contexts.map((context) => [context.id, context.title]));
}

/**
 * The name of each schedule a notification names (`subject.scheduleId`): its description, or the
 * agent it runs. A schedule that is gone has no entry, and its notification is worded as a failed
 * run of its agent.
 */
export async function loadScheduleNames(
  scheduleIds: readonly string[],
  options?: Options,
): Promise<ReadonlyMap<string, ScheduleName>> {
  const names = new Map<string, ScheduleName>();
  if (scheduleIds.length === 0) return names;
  const wanted = new Set(scheduleIds);
  for (const schedule of await listBureauSchedules(options)) {
    if (!wanted.has(schedule.id)) continue;
    // A description is prose; the agent's name stands in for it only when there is none.
    if (schedule.description != null) {
      names.set(schedule.id, { name: schedule.description, identifier: false });
    } else if (schedule.agentName != null) {
      names.set(schedule.id, { name: schedule.agentName, identifier: true });
    }
  }
  return names;
}
