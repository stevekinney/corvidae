import { collectDueCronTicks, getNextCronTick, type CronTick } from '../schedule.ts';
import {
  collectDueIntervalOccurrences,
  getNextIntervalOccurrence,
} from '../schedule/interval-occurrence.ts';
import type { ScheduleState } from '../types.ts';

/**
 * The recurrence cadence of a schedule, decoded from persisted state into a
 * single discriminated value so occurrence computation never has to inspect
 * both `cronExpression` and `intervalMs` at every call site.
 */
export type ScheduleCadence =
  | { kind: 'cron'; cronExpression: string; timeZone: string }
  | { kind: 'interval'; intervalMs: number; anchor: number };

/**
 * One instant a schedule wakes at: whether a run starts there, and how many wall-clock times the
 * daylight-saving gap that ends there swallowed. Every tick of an interval schedule, and of a cron
 * schedule in UTC, fires and swallows nothing.
 */
export type ScheduleTick = CronTick;

/**
 * What a cadence needs of a schedule. The time zone is required, not defaulted, so a source built
 * by hand cannot compute a cron occurrence in UTC for a schedule that is read in another zone.
 */
type CadenceSource = Pick<
  ScheduleState,
  'cronExpression' | 'intervalMs' | 'createdAt' | 'timeZone'
>;

/**
 * Resolve the cadence of a schedule from its persisted state. Interval schedules
 * are anchored at `createdAt`. Throws if the state carries neither a cron
 * expression nor an interval, which should never happen for a record that passed
 * decode validation.
 */
export function resolveScheduleCadence(state: CadenceSource): ScheduleCadence {
  if (state.intervalMs !== undefined) {
    return { kind: 'interval', intervalMs: state.intervalMs, anchor: state.createdAt };
  }
  if (state.cronExpression !== undefined) {
    return { kind: 'cron', cronExpression: state.cronExpression, timeZone: state.timeZone };
  }
  throw new Error('Schedule state must define either a cron expression or an interval');
}

/**
 * Compute the next instant strictly after `afterTimestamp` that a schedule wakes at, dispatching on
 * cadence kind. Cron schedules defer to the cron engine in the schedule's time zone; interval
 * schedules step forward one period anchored at creation time. A cron schedule's next instant may be
 * the end of a daylight-saving gap that swallowed one of its wall-clock times, where it records the
 * miss and fires only if the expression also matches (see {@link ScheduleTick}).
 */
export function getNextScheduleOccurrence(state: CadenceSource, afterTimestamp: number): number {
  const cadence = resolveScheduleCadence(state);
  if (cadence.kind === 'interval') {
    return getNextIntervalOccurrence(cadence.anchor, cadence.intervalMs, afterTimestamp);
  }
  return getNextCronTick(cadence.cronExpression, afterTimestamp, {
    timeZone: cadence.timeZone,
  }).at;
}

/**
 * Collect every tick in the inclusive window `[firstDueAt, throughTimestamp]` for a schedule,
 * dispatching on cadence kind. `maxOccurrences` bounds the result so a long backfill window cannot
 * produce an unbounded list. `firstDueAt` is a bare stored instant, so a cron tick's `fires` and
 * `dstGapSkipped` are re-derived from it.
 */
export function collectDueScheduleTicks(
  state: CadenceSource,
  firstDueAt: number,
  throughTimestamp: number,
  maxOccurrences: number,
): ScheduleTick[] {
  const cadence = resolveScheduleCadence(state);
  if (cadence.kind === 'interval') {
    return collectDueIntervalOccurrences(
      cadence.anchor,
      cadence.intervalMs,
      firstDueAt,
      throughTimestamp,
      { maxOccurrences },
    ).map((at) => ({ at, fires: true, dstGapSkipped: 0 }));
  }
  return collectDueCronTicks(cadence.cronExpression, firstDueAt, throughTimestamp, {
    timeZone: cadence.timeZone,
    maxOccurrences,
  });
}
