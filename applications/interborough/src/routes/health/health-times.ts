/**
 * How the Health page words a moment: one 12-hour clock in the viewer's zone, which the sample
 * world and the page's own "Central time" label agree is Central (shared row 03p).
 */
import { formatDate, formatDateTime, formatTimeOfDay } from '@lostgradient/cinder';

/** A calendar day without a year, such as "Oct 30". */
export function dayLabel(at: number): string {
  return formatDate(at, 'en-US', { month: 'short', day: 'numeric' });
}

/** The clock time of a moment, such as "10:45 AM". */
export function clockTime(at: number): string {
  return formatTimeOfDay(at);
}

/**
 * The time at the end of an activity line: the clock time for today, "Yesterday, 4:12 PM" for the
 * day before, and the calendar day ("Oct 29") for anything older.
 */
export function activityTime(at: number, now: number): string {
  const label = formatDateTime(at, { now, dayWords: true });
  if (label.startsWith('Today, ')) return clockTime(at);
  if (label.startsWith('Yesterday, ')) return label;
  return dayLabel(at);
}

/** Joins words the way a sentence lists them: "Oct 30, Oct 31, Nov 1 and Nov 2". */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}
