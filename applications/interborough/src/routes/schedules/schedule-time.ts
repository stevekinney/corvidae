/**
 * When a schedule fires, said in the zone it is read in. A cron schedule is read in its own IANA
 * zone (`UTC` when it was made without one), so "every day at 09:00" in `America/Los_Angeles` fires
 * at 09:00 there, and its next runs are shown in that zone with the zone named. An interval counts
 * elapsed time and has no zone of its own, so its runs are shown in the zone the browser is in,
 * named the same way.
 */
import { computeNextFires } from '../../lib/format/cron-preview.ts';
import { browserTimeZone, cadenceToScheduleValue } from './cadence.ts';

/** The fields of a schedule that say when it fires. */
export type ScheduleTiming = {
  readonly status: 'active' | 'paused' | 'cancelled';
  readonly cronExpression?: string | undefined;
  readonly intervalMs?: number | undefined;
  readonly timeZone?: string | undefined;
  /** When the engine will wake for it next, in milliseconds. */
  readonly nextFireAt?: number | null | undefined;
  /** The fire a person asked to skip, in milliseconds. */
  readonly skipUntil?: number | undefined;
};

/** One run the schedule has coming: when, and whether a person asked to skip it. */
export type UpcomingFire = {
  readonly at: number;
  readonly skipped: boolean;
};

/** The zone a schedule's times are shown in: its own for a cron, the browser's for an interval. */
export function scheduleZone(timing: Pick<ScheduleTiming, 'cronExpression' | 'timeZone'>): string {
  return timing.cronExpression !== undefined ? (timing.timeZone ?? 'UTC') : browserTimeZone();
}

/** A zone as a person reads it: the IANA name, with the underscores a city's name has in it spaced out. */
export function zoneLabel(zone: string): string {
  return zone.replaceAll('_', ' ');
}

/** The zone a cron schedule's sentence names ("America/Los Angeles"), and `null` for an interval, which has none. */
export function sentenceZone(
  timing: Pick<ScheduleTiming, 'cronExpression' | 'timeZone'>,
): string | null {
  return timing.cronExpression !== undefined ? zoneLabel(timing.timeZone ?? 'UTC') : null;
}

function formatterFor(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: zone,
  });
}

/** A moment in a zone, with the zone's own short name after it: "Mon, Nov 2, 9:00 AM PST". */
export function formatInZone(at: number, zone: string): string {
  try {
    return formatterFor(zone).format(at);
  } catch {
    // A zone this browser does not know is shown in UTC rather than not at all.
    return formatterFor('UTC').format(at);
  }
}

/**
 * The next `count` runs of an active schedule, soonest first. A cron's are the expression read in
 * its zone from `now`; an interval's are `nextFireAt` and each interval after it. A run at or before
 * the one a person asked to skip is marked skipped. A paused or cancelled schedule has none, and an
 * expression that cannot be read has none either.
 */
export function upcomingFires(
  timing: ScheduleTiming,
  count: number,
  now: number = Date.now(),
): readonly UpcomingFire[] {
  if (timing.status !== 'active') return [];
  let times: number[] = [];
  if (timing.cronExpression !== undefined) {
    try {
      times = computeNextFires(
        cadenceToScheduleValue({
          cronExpression: timing.cronExpression,
          ...(timing.timeZone !== undefined ? { timeZone: timing.timeZone } : {}),
        }),
        count,
        new Date(now),
      ).map((fire) => Date.parse(fire.id));
    } catch {
      return [];
    }
  } else if (timing.intervalMs !== undefined && timing.nextFireAt != null) {
    const step = timing.intervalMs;
    times = Array.from({ length: count }, (_, index) => (timing.nextFireAt ?? 0) + index * step);
  }
  const skipUntil = timing.skipUntil;
  return times.map((at) => ({ at, skipped: skipUntil !== undefined && at <= skipUntil }));
}
