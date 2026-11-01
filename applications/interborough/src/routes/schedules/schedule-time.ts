/**
 * When a schedule fires, said in the zone it is read in. A cron schedule is read in its own IANA
 * zone (`UTC` when it was made without one), so "every day at 09:00" in `America/Los_Angeles` fires
 * at 09:00 there, and its next runs are shown in that zone with the zone named. An interval counts
 * elapsed time and has no zone of its own, so its runs are shown in the zone the browser is in,
 * named the same way.
 */
import { CronExpressionParser } from 'cron-parser';

import { browserTimeZone } from './cadence.ts';

/** The fields of a schedule that say when it fires. */
export type ScheduleTiming = {
  readonly status: 'active' | 'paused' | 'cancelled';
  readonly cronExpression?: string | undefined;
  readonly intervalMs?: number | undefined;
  readonly timeZone?: string | undefined;
  /** When the engine will wake for it next, in milliseconds. */
  readonly nextFireAt?: number | null | undefined;
  /** The most recent occurrence that started a run, in milliseconds. */
  readonly lastFireAt?: number | undefined;
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

const MINUTE_MS = 60_000;

/** The wall clock of an instant in a zone, read as UTC, so a cron can be matched against it. */
function wallClockAsUtc(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
}

/**
 * Whether the expression matches the wall clock the zone shows at `at`. The engine fires an
 * instant only when it does (`ScheduleTick.fires`): the instant a daylight-saving gap ends is a
 * tick that fires nothing when the expression named a time inside the gap, though a cron reader
 * that shifts such a time forward lands on it.
 */
function firesAt(expression: string, zone: string, at: number): boolean {
  const local = wallClockAsUtc(at, zone);
  const next = CronExpressionParser.parse(expression, {
    currentDate: new Date(local - MINUTE_MS),
    tz: 'UTC',
  }).next();
  return next.toDate().getTime() === local;
}

/** The instants a cron fires at from `from` on (`from` itself too when `inclusive`), soonest first. */
function cronFires(
  timing: ScheduleTiming,
  from: number,
  inclusive: boolean,
  count: number,
): number[] {
  const expression = timing.cronExpression ?? '';
  const zone = timing.timeZone ?? 'UTC';
  const times: number[] = [];
  if (inclusive && firesAt(expression, zone, from)) times.push(from);
  const parser = CronExpressionParser.parse(expression, { currentDate: new Date(from), tz: zone });
  // A gap leaves out one match at a time, so a bounded walk finds `count` fires and ends on an
  // expression that stops matching.
  for (let walked = 0; times.length < count && walked < count * 4 + 16; walked += 1) {
    if (!parser.hasNext()) break;
    const at = parser.next().toDate().getTime();
    if (firesAt(expression, zone, at)) times.push(at);
  }
  return times.slice(0, count);
}

/**
 * Where the engine's next occurrence is, from the schedule alone and never the clock of the page.
 * A run that is due but waits out its jitter keeps its `nextFireAt` until it starts, and that is
 * the run "Skip the next one" skips; the page's own clock would have moved past it. While a
 * backfill is catching up, `lastFireAt` is at or past `nextFireAt` and the next is strictly after
 * `lastFireAt`.
 */
function occurrenceAnchor(
  timing: ScheduleTiming,
): { readonly from: number; readonly inclusive: boolean } | null {
  const next = timing.nextFireAt;
  if (next == null) return null;
  const last = timing.lastFireAt;
  return last !== undefined && last >= next
    ? { from: last, inclusive: false }
    : { from: next, inclusive: true };
}

/**
 * The next `count` runs of an active schedule, soonest first, counted from the engine's
 * `nextFireAt` (a cron's are the expression read in its zone after it, an interval's are each
 * interval after it) so the list changes only when the schedule does. A time the engine does not
 * fire at, such as one inside a daylight-saving gap, is left out. Only the run at `skipUntil` is
 * marked skipped. A paused or cancelled schedule has none, and an expression that cannot be read
 * has none either. `now` stands in for `nextFireAt` only when the schedule carries none.
 */
export function upcomingFires(
  timing: ScheduleTiming,
  count: number,
  now: number = Date.now(),
): readonly UpcomingFire[] {
  if (timing.status !== 'active') return [];
  const anchor = occurrenceAnchor(timing);
  let times: number[] = [];
  if (timing.cronExpression !== undefined) {
    try {
      times = anchor
        ? cronFires(timing, anchor.from, anchor.inclusive, count)
        : cronFires(timing, now, false, count);
    } catch {
      return [];
    }
  } else if (timing.intervalMs !== undefined && anchor !== null) {
    const step = timing.intervalMs;
    // An interval ticks on a grid through `nextFireAt`, so the one after `lastFireAt` is on it.
    const first = anchor.inclusive
      ? anchor.from
      : (timing.nextFireAt ?? 0) +
        (Math.floor((anchor.from - (timing.nextFireAt ?? 0)) / step) + 1) * step;
    times = Array.from({ length: count }, (_, index) => first + index * step);
  }
  const skipUntil = timing.skipUntil;
  return times.map((at) => ({ at, skipped: skipUntil !== undefined && at === skipUntil }));
}
