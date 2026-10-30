/**
 * `computeNextFires` — the callback injected into Cinder's `ScheduleBuilder`
 * (plan §7.1/§7.2 C3, `design/README.md` "ScheduleBuilder"). Split out of
 * `./index.ts` (T1.6 integration fix, reported per PROJECT-BRIEF's "small
 * integration bugs in `src/lib/**`" allowance): `./index.ts`'s generic
 * formatters (`truncateId`/`formatDuration`/`formatBytes`/
 * `formatRelativeTime`) are imported eagerly by the shell chrome
 * (`src/app/shell/notification-bell.svelte`'s relative-time column), and
 * bundling `cron-parser` into that same file pulled the whole cron-parsing
 * dependency into the app's eager entry chunk for every consumer of any
 * formatter, not just Schedule-domain ones — a measured +31 KB gzip
 * (77.7→108.6 KB) on the production entry bundle. Import `computeNextFires`
 * from this module directly; `./index.ts` no longer re-exports it, so that
 * coupling can't reappear silently.
 */
import { CronExpressionParser } from 'cron-parser';

import type { ScheduleFire, ScheduleIntervalUnit, ScheduleValue } from '@lostgradient/cinder';

const MINUTE_MS = 60_000;

/**
 * The next `count` fires of a 5-field cron expression (minute hour
 * day-of-month month day-of-week — the field order `ScheduleValue`'s `cron`
 * mode documents), strictly after `from`. Delegates to `cron-parser`
 * (`CronExpressionParser`) rather than hand-rolling field/range/alias
 * parsing: it already handles month/day-of-week name aliases (`MON`,
 * `JAN-MAR`, …), step/range/list syntax, and POSIX day-of-month ×
 * day-of-week OR semantics correctly. A 5-field expression is accepted
 * as-is — `cron-parser` defaults the (unused) seconds field to `0`.
 * Malformed expressions or out-of-range field values throw synchronously
 * from `CronExpressionParser.parse`; that throw is intentionally left to
 * propagate rather than swallowed, so an invalid schedule fails loudly
 * instead of silently previewing zero fires.
 */
function nextCronFires(
  expression: string,
  timeZone: string,
  count: number,
  from: Date,
): readonly Date[] {
  const interval = CronExpressionParser.parse(expression, { currentDate: from, tz: timeZone });
  return interval.take(count).map((cronDate) => cronDate.toDate());
}

function nextIntervalFires(
  every: number,
  unit: ScheduleIntervalUnit,
  count: number,
  from: Date,
): readonly Date[] {
  const unitMs: Record<ScheduleIntervalUnit, number> = {
    minutes: MINUTE_MS,
    hours: 60 * MINUTE_MS,
  };
  const stepMs = every * unitMs[unit];

  const fires: Date[] = [];
  let next = from.getTime() + stepMs;
  for (let index = 0; index < count; index += 1) {
    fires.push(new Date(next));
    next += stepMs;
  }
  return fires;
}

/** Formats a fire in the schedule's own zone, so "Weekdays at 9:00 AM Pacific Time" previews 9:00 AM. */
function fireLabelFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

/**
 * The `computeNextFires` callback injected into Cinder's `ScheduleBuilder`
 * (plan §7.1/§7.2 C3). Signature takes an optional `from` (defaulting to
 * `new Date()`) so it can be passed straight through as
 * `ScheduleBuilderProps['computeNextFires']`, which only ever calls it with
 * `(value, count)`. A cron's field parsing and time zone handling are
 * `cron-parser`'s, in the value's `timeZone`, and it throws on a malformed
 * expression or an out-of-range field; an interval is a plain fixed-step walk
 * and trusts `count` to be the positive integer `ScheduleValue` documents.
 * Labels are formatted in the value's zone.
 */
export function computeNextFires(
  value: ScheduleValue,
  count: number,
  from: Date = new Date(),
): ScheduleFire[] {
  const dates =
    'cron' in value
      ? nextCronFires(value.cron, value.timeZone, count, from)
      : nextIntervalFires(value.every.count, value.every.unit, count, from);

  const formatter = fireLabelFormatter(value.timeZone);
  return dates.map((date) => ({
    id: date.toISOString(),
    label: formatter.format(date),
  }));
}
