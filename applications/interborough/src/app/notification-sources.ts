/**
 * The reads the bell makes beyond the Bureau's reviews, tasks and notifications: the chats the
 * Bureau lists, with the title of each, which none of them carries, and the name of the schedule a
 * failed run's notification names (`subject.scheduleId`), and the fires a schedule missed.
 */
import { listContexts } from '../lib/bureau-client.ts';
import {
  listAgentScheduleMissed,
  listBureauSchedules,
  type BureauSchedule,
  type MissedFire,
} from '../lib/bureau-schedules.ts';
import type { ScheduleName } from './notification-items.ts';

/** How many chats the bell looks up: the most recently changed. */
export const TITLE_LOOKUP_LIMIT = 100;

type Options = { readonly signal?: AbortSignal };

/** Every chat the Bureau lists, by session, with its title (`null` for a chat that has none). */
export async function loadChats(options?: Options): Promise<ReadonlyMap<string, string | null>> {
  const page = await listContexts({ limit: TITLE_LOOKUP_LIMIT }, options);
  return new Map(page.contexts.map((context) => [context.id, context.title]));
}

/** What a schedule is called: its description, else the agent it runs, else the workflow it starts. */
function nameOf(schedule: BureauSchedule): ScheduleName {
  // A description is prose; the agent's or the workflow's name stands in for it only when there is none.
  if (schedule.description != null) return { name: schedule.description, identifier: false };
  return { name: schedule.agentName ?? schedule.workflowType, identifier: true };
}

/** How many schedules the bell looks up the missed fires of: the most recently changed. */
export const MISSED_SCHEDULE_LOOKUP_LIMIT = 10;

/** The newest fire one schedule missed. */
export interface MissedFireSource {
  readonly scheduleId: string;
  readonly name: ScheduleName;
  readonly missed: MissedFire;
}

/**
 * The newest fire missed by each schedule that has missed any (`missedFireCount`), for the
 * {@link MISSED_SCHEDULE_LOOKUP_LIMIT} most recently changed. A read that fails fails the whole
 * lookup, so the bell says it could not look rather than listing some of the misses.
 */
export async function loadMissedFires(options?: Options): Promise<readonly MissedFireSource[]> {
  const schedules = await listBureauSchedules(options);
  const missing = schedules
    .filter((schedule) => schedule.missedFireCount > 0 && schedule.status !== 'cancelled')
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MISSED_SCHEDULE_LOOKUP_LIMIT);
  const newest = await Promise.all(
    missing.map(async (schedule) => {
      const fires = await listAgentScheduleMissed(schedule.id, options);
      return { schedule, missed: fires[0] };
    }),
  );
  return newest.flatMap(({ schedule, missed }) =>
    missed === undefined ? [] : [{ scheduleId: schedule.id, name: nameOf(schedule), missed }],
  );
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
