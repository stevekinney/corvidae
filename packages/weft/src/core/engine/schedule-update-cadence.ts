/**
 * What an update of a schedule's cadence leaves of its next run and of a skip a person asked for
 * (COR-1985).
 */

import type { ScheduleState } from '../types.ts';
import { findFiringScheduleOccurrence } from './schedule-occurrence.ts';

/**
 * The next wake-up an update leaves the schedule at (COR-1985): none for a cancelled schedule, the
 * run an active schedule was already waiting for when the update keeps its interval grid, and the
 * first occurrence after the update otherwise.
 */
export function updatedNextFireAt(
  state: ScheduleState,
  keepsIntervalGrid: boolean,
  computeFromNow: () => number,
): number | null {
  if (state.status === 'cancelled') return null;
  if (keepsIntervalGrid && state.status === 'active' && state.nextFireAt !== null) {
    return state.nextFireAt;
  }
  return computeFromNow();
}

/**
 * The skip `state` carries, when `updated` still has it as the next run that starts something
 * (COR-1985). A skip names one occurrence, so an update that leaves that occurrence next (a new
 * description, an overlap policy, a cron expression whose next run is the same one) does not
 * restore it, and one that moves the next run, or the zone it is read in, ends it. The firing
 * occurrence is compared, not `nextFireAt`, because in a time zone `nextFireAt` can be the end of a
 * daylight-saving gap that starts nothing.
 */
export function survivingSkip(state: ScheduleState, updated: ScheduleState): number | undefined {
  if (state.skipUntil === undefined || updated.nextFireAt === null) return undefined;
  return findFiringScheduleOccurrence(updated, updated.nextFireAt) === state.skipUntil
    ? state.skipUntil
    : undefined;
}
