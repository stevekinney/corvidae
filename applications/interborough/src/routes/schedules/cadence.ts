/**
 * Cadence formatting + `ScheduleValue` ⇄ wire-spec conversion (Track B, plan
 * §9.3, design "Schedules" screens: "human-readable" cadence, e.g. "Every 5
 * minutes"). Pure logic, no DOM — colocated `bun test` coverage.
 *
 * `describeCadence()` is a bounded cron humanizer covering the recurrence
 * shapes this console's own `ScheduleBuilder` choices produce (every-N,
 * daily, weekly-on-a-day, monthly-on-a-day) plus fixed intervals. It is
 * deliberately not exhaustive — no external cron-humanizer dependency is
 * pulled in for the bundle-size budget (plan §12) — an expression outside
 * the recognized shapes falls back to `Cron · <expression>` rather than
 * guessing.
 */
import type { ScheduleIntervalUnit, ScheduleValue } from '@lostgradient/cinder';

import type { ScheduleSpec } from '@lostgradient/weft';

/** A schedule's persisted cadence, mutually exclusive per `ScheduleSummary`/`ScheduleState`. */
export interface ScheduleCadence {
  readonly cronExpression?: string;
  readonly intervalMs?: number;
  /** The IANA zone a cron cadence is read in; `UTC` for an interval and for a schedule stored without one. */
  readonly timeZone?: string;
}

const WEEKDAY_NAMES = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];
const WEEKDAY_ALIASES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

type CronField =
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'exact'; readonly value: number }
  | { readonly kind: 'step'; readonly step: number }
  | { readonly kind: 'other' };

function parseCronField(raw: string): CronField {
  if (raw === '*') return { kind: 'wildcard' };

  const stepMatch = /^\*\/(\d+)$/.exec(raw);
  if (stepMatch?.[1] !== undefined) return { kind: 'step', step: Number(stepMatch[1]) };

  if (/^\d+$/.test(raw)) return { kind: 'exact', value: Number(raw) };

  const alias = WEEKDAY_ALIASES[raw.toLowerCase()];
  if (alias !== undefined) return { kind: 'exact', value: alias };

  return { kind: 'other' };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `1, 'minute'` → `"minute"`; `5, 'minute'` → `"5 minutes"` — matches the design reference's "Every hour" / "Every 5 minutes" convention (no bare "1" prefix). */
function countedUnit(count: number, unit: string): string {
  return count === 1 ? unit : `${count} ${unit}s`;
}

/** Splits a 5-field cron expression, tolerating extra internal whitespace. */
function splitCronFields(expression: string): readonly string[] | null {
  const fields = expression.trim().split(/\s+/);
  return fields.length === 5 ? fields : null;
}

interface ParsedCronFields {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dom: CronField;
  readonly month: CronField;
  readonly dow: CronField;
}

function describeMinuteStepDaily(minute: CronField, hour: CronField): string | null {
  if (minute.kind !== 'step' || hour.kind !== 'wildcard') return null;
  return `Every ${countedUnit(minute.step, 'minute')}`;
}

function describeHourStepDaily(minute: CronField, hour: CronField): string | null {
  if (hour.kind !== 'step') return null;
  if (minute.kind !== 'exact' || minute.value !== 0) return null;
  return `Every ${countedUnit(hour.step, 'hour')}`;
}

/** Minute pinned, hour wildcard (e.g. `0 * * * *`) — fires once per hour. */
function describeHourlyAtMinute(minute: CronField, hour: CronField): string | null {
  if (minute.kind !== 'exact' || hour.kind !== 'wildcard') return null;
  return minute.value === 0 ? 'Every hour' : `Every hour at :${pad2(minute.value)}`;
}

function describeFixedDailyTime(minute: CronField, hour: CronField): string | null {
  if (minute.kind !== 'exact' || hour.kind !== 'exact') return null;
  return `Every day at ${pad2(hour.value)}:${pad2(minute.value)}`;
}

/** The "fires every day (or every N minutes/hours within a day)" shapes — day-of-month, month, and day-of-week all wildcard. */
function describeDailyShape(fields: ParsedCronFields): string | null {
  const { minute, hour } = fields;
  return (
    describeMinuteStepDaily(minute, hour) ??
    describeHourStepDaily(minute, hour) ??
    describeHourlyAtMinute(minute, hour) ??
    describeFixedDailyTime(minute, hour)
  );
}

/** "Fires on one weekday" — day-of-month and month wildcard, day-of-week pinned to a single 0–6 value. */
function describeWeeklyShape(fields: ParsedCronFields): string | null {
  const { minute, hour, dow } = fields;
  if (dow.kind !== 'exact' || dow.value < 0 || dow.value > 6) return null;
  if (minute.kind !== 'exact' || hour.kind !== 'exact') return null;
  const weekday = WEEKDAY_NAMES[dow.value];
  return `${weekday} at ${pad2(hour.value)}:${pad2(minute.value)}`;
}

/** "Fires on one day-of-month" — month and day-of-week wildcard, day-of-month pinned. */
function describeMonthlyShape(fields: ParsedCronFields): string | null {
  const { minute, hour, dom, month, dow } = fields;
  if (dom.kind !== 'exact' || month.kind !== 'wildcard' || dow.kind !== 'wildcard') return null;
  if (minute.kind !== 'exact' || hour.kind !== 'exact') return null;
  return `Monthly on day ${dom.value} at ${pad2(hour.value)}:${pad2(minute.value)}`;
}

function parseCronFields(fields: readonly string[]): ParsedCronFields {
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields;
  return {
    minute: parseCronField(minuteRaw ?? ''),
    hour: parseCronField(hourRaw ?? ''),
    dom: parseCronField(domRaw ?? ''),
    month: parseCronField(monthRaw ?? ''),
    dow: parseCronField(dowRaw ?? ''),
  };
}

/** Humanizes a cron expression, falling back to `Cron · <expression>` for shapes outside the bounded set (module doc). */
export function describeCronExpression(expression: string): string {
  const rawFields = splitCronFields(expression);
  if (!rawFields) return `Cron · ${expression}`;

  const fields = parseCronFields(rawFields);
  const domAndMonthWildcard = fields.dom.kind === 'wildcard' && fields.month.kind === 'wildcard';

  if (domAndMonthWildcard && fields.dow.kind === 'wildcard') {
    const daily = describeDailyShape(fields);
    if (daily) return daily;
  }

  if (domAndMonthWildcard) {
    const weekly = describeWeeklyShape(fields);
    if (weekly) return weekly;
  }

  const monthly = describeMonthlyShape(fields);
  if (monthly) return monthly;

  return `Cron · ${expression}`;
}

const INTERVAL_UNIT_MS: readonly { readonly ms: number; readonly unit: string }[] = [
  { ms: 7 * 86_400_000, unit: 'week' },
  { ms: 86_400_000, unit: 'day' },
  { ms: 3_600_000, unit: 'hour' },
  { ms: 60_000, unit: 'minute' },
  { ms: 1_000, unit: 'second' },
];

/** Humanizes a fixed-interval cadence, reducing to the largest whole unit that evenly divides `intervalMs`. */
export function describeIntervalMs(intervalMs: number): string {
  for (const { ms, unit } of INTERVAL_UNIT_MS) {
    if (intervalMs % ms === 0) {
      return `Every ${countedUnit(intervalMs / ms, unit)}`;
    }
  }
  return `Every ${intervalMs}ms`;
}

/** Human-readable cadence for a schedule list/detail row (plan §9.3: "human-readable" cadence). */
export function describeCadence(cadence: ScheduleCadence): string {
  if (cadence.intervalMs !== undefined) return describeIntervalMs(cadence.intervalMs);
  if (cadence.cronExpression !== undefined) return describeCronExpression(cadence.cronExpression);
  return 'Unknown cadence';
}

const CINDER_INTERVAL_UNIT_MS: Readonly<Record<ScheduleIntervalUnit, number>> = {
  minutes: 60_000,
  hours: 3_600_000,
};

/**
 * Converts a Cinder `ScheduleBuilder` value into the spec Weft's
 * `weft.schedules.create`/`weft.schedules.update` operations accept
 * (`cron` | `every`). An interval resolves to milliseconds, which the Bureau
 * path turns back into its duration text (`bureauSpecOf`). The zone travels
 * separately: see {@link scheduleValueTimeZone}.
 */
export function scheduleValueToWireSpec(value: ScheduleValue): ScheduleSpec {
  if ('cron' in value) return { cron: value.cron };
  return { every: value.every.count * CINDER_INTERVAL_UNIT_MS[value.every.unit] };
}

/**
 * The zone to send with a builder value: its `timeZone` for a cron, and `undefined` for an
 * interval, which counts elapsed time and which Weft and the Bureau refuse a zone for.
 */
export function scheduleValueTimeZone(value: ScheduleValue): string | undefined {
  return 'cron' in value ? value.timeZone : undefined;
}

/** The zone a persisted cadence is read in: its own for a cron, and `undefined` for an interval. */
export function cadenceTimeZone(cadence: ScheduleCadence): string | undefined {
  return cadence.cronExpression !== undefined ? (cadence.timeZone ?? 'UTC') : undefined;
}

type IntervalScheduleValue = Extract<ScheduleValue, { every: unknown }>;

/** Reduces a millisecond interval to whole hours when it divides evenly, else to minutes (rounded, at least one), so a persisted `2d` reopens as every 48 hours. */
export function intervalMsToScheduleValue(
  intervalMs: number,
  timeZone: string,
): IntervalScheduleValue {
  if (intervalMs % CINDER_INTERVAL_UNIT_MS.hours === 0) {
    return {
      every: { unit: 'hours', count: intervalMs / CINDER_INTERVAL_UNIT_MS.hours },
      timeZone,
    };
  }
  return {
    every: {
      unit: 'minutes',
      count: Math.max(1, Math.round(intervalMs / CINDER_INTERVAL_UNIT_MS.minutes)),
    },
    timeZone,
  };
}

/**
 * Whether a persisted cadence is an interval the `ScheduleBuilder` cannot show exactly: it counts
 * in whole minutes at the smallest, so `30s` or `90s` would be rounded to a minute count. An edit
 * that resends the rounded value silently changes the schedule's timing, so such a cadence is
 * kept as it was until the operator chooses to change it.
 */
export function isSubMinuteInterval(cadence: ScheduleCadence): boolean {
  return (
    cadence.intervalMs !== undefined && cadence.intervalMs % CINDER_INTERVAL_UNIT_MS.minutes !== 0
  );
}

/** Just the cadence of a persisted schedule, copied, so a draft keeps it exactly as it was read. */
export function cadenceOf(schedule: ScheduleCadence): ScheduleCadence {
  return {
    ...(schedule.cronExpression !== undefined ? { cronExpression: schedule.cronExpression } : {}),
    ...(schedule.intervalMs !== undefined ? { intervalMs: schedule.intervalMs } : {}),
    ...(schedule.timeZone !== undefined ? { timeZone: schedule.timeZone } : {}),
  };
}

/** A persisted cadence in the wire fields an update takes, exactly as it is stored; `undefined` for a schedule with no cadence. */
export function cadenceToWireSpec(cadence: ScheduleCadence): ScheduleSpec | undefined {
  if (cadence.cronExpression !== undefined) return { cron: cadence.cronExpression };
  if (cadence.intervalMs !== undefined) return { every: cadence.intervalMs };
  return undefined;
}

/** The zone a builder opens in when a schedule has none to give it: the browser's own. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Rehydrates a persisted schedule's cadence into a `ScheduleValue` for the edit page's `ScheduleBuilder`, in the zone the schedule is stored with. */
export function cadenceToScheduleValue(cadence: ScheduleCadence): ScheduleValue {
  const timeZone = cadence.timeZone ?? 'UTC';
  if (cadence.cronExpression !== undefined) return { cron: cadence.cronExpression, timeZone };
  if (cadence.intervalMs !== undefined)
    return intervalMsToScheduleValue(cadence.intervalMs, timeZone);
  return { every: { unit: 'minutes', count: 15 }, timeZone };
}

/**
 * Whether the cadence builder inside `region` shows a field that is out of range. The builder keeps
 * the last cadence it emitted while a custom field is invalid, so the value a page holds is not the
 * one on screen: every page that saves a cadence refuses until what is shown is valid.
 */
export function shownCadenceIsInvalid(region: ParentNode | undefined): boolean {
  return region?.querySelector('[aria-invalid="true"]') != null;
}
