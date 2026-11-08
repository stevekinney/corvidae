/**
 * The wall-clock words a page says about "now" and about when something happened, in the viewer's
 * time zone with the zone named once. Boards read them as "Monday, Nov 2", "Times show in Central
 * time (CST)", "10:42 AM" for a time today and "Yesterday, 4:12 PM" for the day before, so the
 * pages that show them (Home, and the chat list) say them one way.
 *
 * Every function takes the instant and the zone, so a page passes the clock it already reads and a
 * test pins both; the zone defaults to the browser's.
 *
 * @module clock
 */

import { formatCompactAge, formatRelativeTime } from '@lostgradient/cinder';

/** The locale the product's words are written in; a clock reads the same whatever the browser's. */
const LOCALE = 'en-US';

/** The browser's time zone, or `UTC` where it cannot say. */
export function viewerTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/** One part of a date as a zone writes it, such as the zone's own name. */
function partOf(
  at: number,
  zone: string,
  options: Intl.DateTimeFormatOptions,
  type: Intl.DateTimeFormatPartTypes,
): string {
  return (
    new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: zone })
      .formatToParts(at)
      .find((part) => part.type === type)?.value ?? ''
  );
}

/** The day as a person reads it at the top of a page: "Monday, Nov 2". */
export function dateLine(at: number, zone: string = viewerTimeZone()): string {
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  }).format(at);
}

/**
 * The zone's name as a sentence says it, with its short form: "Central time (CST)". A zone with no
 * generic name of its own (UTC reads "GMT+00:00") is said by its short form alone.
 */
export function zoneName(at: number, zone: string = viewerTimeZone()): string {
  const long = partOf(at, zone, { timeZoneName: 'longGeneric' }, 'timeZoneName');
  const short = partOf(at, zone, { timeZoneName: 'short' }, 'timeZoneName');
  if (long === '' || long.startsWith('GMT')) return short === '' ? zone : short;
  const sentence = long.replace(/ Time$/, ' time');
  return short === '' || short.startsWith('GMT') ? sentence : `${sentence} (${short})`;
}

/**
 * The zone's generic name alone, as a day band names the zone its times are in: "Central time". A
 * zone with no generic name of its own is said by its short form.
 */
export function zoneLabel(at: number, zone: string = viewerTimeZone()): string {
  const long = partOf(at, zone, { timeZoneName: 'longGeneric' }, 'timeZoneName');
  if (long === '' || long.startsWith('GMT')) return zoneName(at, zone);
  return long.replace(/ Time$/, ' time');
}

/** The sentence that says which zone every time on a page is in: "Times show in Central time (CST)". */
export function timesShowIn(at: number, zone: string = viewerTimeZone()): string {
  return `Times show in ${zoneName(at, zone)}`;
}

/** The clock of an instant in a zone, on a twelve-hour clock: "10:42 AM". */
export function clockTime(at: number, zone: string = viewerTimeZone()): string {
  return new Intl.DateTimeFormat(LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone,
  }).format(at);
}

/**
 * How long something has waited, for the end of a line that says when it began: "just now" under a
 * minute, "4 min ago" to the nearest minute under an hour, "1 h ago" in whole hours through the
 * day, then the day and clock it began ("Sun Nov 1, 4:12 PM"). The minute rounds as the
 * notification bell's does, so a review asked 3 minutes 40 seconds ago reads "4 min ago" in both.
 */
export function waitedFor(at: number, now: number, zone: string = viewerTimeZone()): string {
  const elapsed = now - at;
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 86_400_000) return `${formatCompactAge(at, { now, timeZone: zone })} ago`;
  return formatRelativeTime(at, { now, timeZone: zone });
}

/**
 * The calendar day of an instant in a zone, as a number that two instants on one day share and that
 * grows by one each day, so the difference of two is the days between them.
 */
export function calendarDay(at: number, zone: string = viewerTimeZone()): number {
  return dayNumber(at, zone);
}

/** The calendar day of an instant in a zone, as a number that two instants on one day share. */
function dayNumber(at: number, zone: string): number {
  const year = Number(partOf(at, zone, { year: 'numeric' }, 'year'));
  const month = Number(partOf(at, zone, { month: 'numeric' }, 'month'));
  const day = Number(partOf(at, zone, { day: 'numeric' }, 'day'));
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * When something happened, for a row that says when it last changed: the clock alone for today
 * ("10:42 AM"), "Yesterday, 4:12 PM" for the day before, and the day and clock for anything older
 * ("Thu, Oct 29, 4:12 PM"). A time in the future is today's.
 */
export function rowTime(at: number, now: number, zone: string = viewerTimeZone()): string {
  const days = dayNumber(now, zone) - dayNumber(at, zone);
  if (days <= 0) return clockTime(at, zone);
  if (days === 1) return `Yesterday, ${clockTime(at, zone)}`;
  const day = new Intl.DateTimeFormat(LOCALE, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  }).format(at);
  return `${day}, ${clockTime(at, zone)}`;
}

/**
 * When something began, for a line that names the day as well as the clock: "Today, 10:30 AM",
 * "Yesterday, 4:12 PM", and "Thu, Oct 29, 11:05 AM" for anything older. It is {@link rowTime} with
 * the day said for today too, since a line of details has no row around it to say "today".
 */
export function dayAndTime(at: number, now: number, zone: string = viewerTimeZone()): string {
  return dayNumber(now, zone) - dayNumber(at, zone) <= 0
    ? `Today, ${clockTime(at, zone)}`
    : rowTime(at, now, zone);
}
