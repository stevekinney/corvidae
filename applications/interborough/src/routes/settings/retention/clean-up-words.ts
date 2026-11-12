/**
 * How the Clean-up row words what the host reports (board PageSettingsSections, "Data and
 * retention"; rows 50h and 50j): the hour of the night in the host's zone, and the clean-up that
 * last ran or the night that was skipped.
 */
import { formatDateTime, formatTimeZoneLabel } from '@lostgradient/cinder';

import { DATA_RETENTION_COPY } from '../../../app/copy/settings.ts';
import type { HostCleanUpRun, HostCleanUpStanding } from '../../../lib/host-clean-up.ts';

const copy = DATA_RETENTION_COPY.cleanUp;

/** The hour and minute on a 12-hour clock: `3:00 AM`. */
export function nightlyTime(hour: number, minute: number): string {
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(twelve)}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** The calendar day of an instant in a zone, such as `2026-11-01`. */
function dayIn(instant: Date | number | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(instant));
}

/** A moment in the host's zone, with the day named only when it is today: `today, 3:00 AM`, `Sun Nov 1, 3:00 AM`. */
function momentIn(at: string, timeZone: string, now: number): string {
  const label = formatDateTime(at, { timeZone, now, dayWords: 'today' });
  return label.replace(/^Today/, 'today');
}

/** The part of the description that does not change: when the host cleans up each night. */
export function scheduleWords(standing: HostCleanUpStanding): string {
  const { hour, minute, timeZone } = standing.schedule;
  const zone = formatTimeZoneLabel(standing.nextAt, { timeZone, style: 'long' });
  return copy.schedule(nightlyTime(hour, minute), zone);
}

/**
 * The whole description: the schedule, then the last clean-up, then the night the host skipped.
 * `now` is when the page reads it (epoch milliseconds).
 */
export function descriptionWords(standing: HostCleanUpStanding, now: number): string {
  const { timeZone } = standing.schedule;
  const parts = [scheduleWords(standing)];
  if (standing.last !== null) parts.push(copy.last(momentIn(standing.last.at, timeZone, now)));
  if (standing.skipped !== null) {
    const sameDay = dayIn(standing.skipped.at, timeZone) === dayIn(now, timeZone);
    parts.push(
      copy.skipped(
        sameDay ? 'today' : formatDateTime(standing.skipped.at, { timeZone, now, dayWords: false }),
      ),
    );
  }
  return parts.join(' ');
}

/** What a finished clean-up says on its row, and whether it is a failure the row should show as one. */
export function resultWords(run: HostCleanUpRun): { text: string; failed: boolean } {
  if (run.failed.length === 0) return { text: copy.done(run.removed), failed: false };
  const kinds = run.failed
    .map((kind) => (Object.hasOwn(copy.kinds, kind) ? (copy.kinds[kind] ?? kind) : kind))
    .join(', ');
  return { text: copy.partial(run.removed, kinds), failed: true };
}
