/**
 * A schedule's cadence as a sentence a row of the Schedules list can carry: "Every day at 3:00 AM
 * (9:00 AM UTC)", "Every Monday at 11:00 AM", "Weekdays at 9:00 AM". The clock time is the
 * viewer's reading of the next time the cron fires, with the schedule's own reading in parentheses
 * where it differs (Cinder's `formatScheduleTime`), so a schedule in UTC and a viewer in Central
 * time read "3:00 AM (9:00 AM UTC)" and a schedule in the viewer's own zone reads "11:00 AM". A
 * phone's third line has less room: it says the same thing in lower case and without the second
 * reading ("every day at 3:00 AM", "Mondays at 11:00 AM"). A schedule whose line says it is defined in
 * a workflow file words its cadence the way the file does ("every Friday at 11:00 AM").
 *
 * The shapes with a clock time are the ones the schedule builder makes (every day, one weekday,
 * weekdays, one day of the month); every other cadence is `describeCadence`'s words, which have no
 * clock time to put in the viewer's zone.
 */
import { CronExpressionParser } from 'cron-parser';

import { formatScheduleTime, formatTimeOfDay } from '@lostgradient/cinder';

import { describeCadence, type ScheduleCadence } from './cadence.ts';

/** A cadence in the two forms a row says it in. */
export type CadenceText = {
  /** The form of a tablet or desktop row: "Every day at 3:00 AM (9:00 AM UTC)". */
  readonly full: string;
  /** The form of a phone's third line: "every day at 3:00 AM". */
  readonly phone: string;
  /** The form of a phone's third line for a schedule defined in a workflow file: "every Friday at 11:00 AM". */
  readonly file: string;
};

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** The viewer's own weekday of an instant, as a number (0 is Sunday). */
function viewerWeekday(at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(at);
  return Math.max(
    0,
    WEEKDAY_NAMES.findIndex((weekday) => weekday === name),
  );
}

type ClockShape =
  | { readonly kind: 'daily' }
  | { readonly kind: 'weekly'; readonly weekday: number }
  | { readonly kind: 'weekdays' }
  | { readonly kind: 'monthly'; readonly day: number };

/** The clock shape of a cron, or `undefined` for one with no single time of day to show. */
function clockShape(expression: string): ClockShape | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (!/^\d+$/.test(minute ?? '') || !/^\d+$/.test(hour ?? '')) return undefined;
  if (month !== '*') return undefined;
  if (dayOfMonth === '*' && dayOfWeek === '*') return { kind: 'daily' };
  if (dayOfMonth === '*' && dayOfWeek === '1-5') return { kind: 'weekdays' };
  if (dayOfMonth === '*' && /^[0-7]$/.test(dayOfWeek ?? '')) {
    return { kind: 'weekly', weekday: Number(dayOfWeek) % 7 };
  }
  if (/^\d+$/.test(dayOfMonth ?? '') && dayOfWeek === '*') {
    return { kind: 'monthly', day: Number(dayOfMonth) };
  }
  return undefined;
}

/** The next instant the cron fires after `now`, or `undefined` when it cannot be read. */
function nextFire(expression: string, zone: string, now: number): Date | undefined {
  try {
    return CronExpressionParser.parse(expression, { currentDate: new Date(now), tz: zone })
      .next()
      .toDate();
  } catch {
    return undefined;
  }
}

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/**
 * The cadence of a schedule as a row says it. `now` stands in for the clock the next fire is
 * counted from, so a test can fix it.
 */
export function cadenceText(cadence: ScheduleCadence, now: number = Date.now()): CadenceText {
  const words = describeCadence(cadence);
  const plain: CadenceText = { full: words, phone: lowerFirst(words), file: lowerFirst(words) };
  const expression = cadence.cronExpression;
  if (expression === undefined) return plain;
  const shape = clockShape(expression);
  if (shape === undefined) return plain;
  const zone = cadence.timeZone ?? 'UTC';
  const at = nextFire(expression, zone, now);
  if (at === undefined) return plain;
  const time = formatScheduleTime(at, zone);
  const phoneTime = formatTimeOfDay(at);
  switch (shape.kind) {
    case 'daily':
      return {
        full: `Every day at ${time}`,
        phone: `every day at ${phoneTime}`,
        file: `every day at ${phoneTime}`,
      };
    case 'weekdays':
      return {
        full: `Weekdays at ${time}`,
        phone: `weekdays at ${phoneTime}`,
        file: `weekdays at ${phoneTime}`,
      };
    case 'weekly': {
      const weekday = WEEKDAY_NAMES[viewerWeekday(at)] ?? WEEKDAY_NAMES[shape.weekday] ?? 'Sunday';
      return {
        full: `Every ${weekday} at ${time}`,
        phone: `${weekday}s at ${phoneTime}`,
        file: `every ${weekday} at ${phoneTime}`,
      };
    }
    case 'monthly':
      return {
        full: `Monthly on day ${String(shape.day)} at ${time}`,
        phone: `monthly on day ${String(shape.day)} at ${phoneTime}`,
        file: `monthly on day ${String(shape.day)} at ${phoneTime}`,
      };
  }
}
