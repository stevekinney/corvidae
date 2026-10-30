import type {
  ScheduleIntervalUnit,
  ScheduleRepeats,
  ScheduleValue,
} from './schedule-builder.types.ts';

/** The interval units the "Every N" choice offers, in order. */
export const INTERVAL_UNITS: readonly ScheduleIntervalUnit[] = ['minutes', 'hours'];

/** Weekday chips for the Custom days choice. `value` matches cron day-of-week (0 = Sunday). */
export const WEEKDAYS: readonly { value: number; short: string; long: string }[] = [
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
  { value: 0, short: 'Sun', long: 'Sunday' },
];

/** The five cron fields, in order, with their valid numeric ranges and hints. */
export const CRON_FIELDS: readonly {
  name: string;
  min: number;
  max: number;
  hint: string;
}[] = [
  { name: 'Minute', min: 0, max: 59, hint: '0–59' },
  { name: 'Hour', min: 0, max: 23, hint: '0–23' },
  { name: 'Day of month', min: 1, max: 31, hint: '1–31' },
  { name: 'Month', min: 1, max: 12, hint: '1–12' },
  { name: 'Day of week', min: 0, max: 6, hint: '0–6 (Sun–Sat)' },
];

/**
 * Validate a single cron field value against its field range. Accepts a
 * wildcard, a step, a range, a comma list, or a plain number. Returns an error
 * message when invalid, or `undefined` when the field is acceptable.
 */
export function validateCronField(rawValue: string, fieldIndex: number): string | undefined {
  const field = CRON_FIELDS[fieldIndex];
  if (!field) return 'Unknown field.';
  const value = rawValue.trim();
  if (value === '') return 'Required.';

  const inRange = (n: number): boolean => Number.isInteger(n) && n >= field.min && n <= field.max;

  // Comma-separated list: every part must be valid on its own.
  for (const part of value.split(',')) {
    const token = part.trim();
    if (token === '') return 'Empty list item.';

    // `*` or `*/step`
    if (token === '*') continue;
    const stepMatch = token.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[2] ?? '');
      if (!Number.isInteger(step) || step <= 0) return 'Step must be a positive integer.';
      // A step larger than the field's maximum (e.g. `*/100` for minutes) is
      // out of the advertised range and rejected by many cron parsers.
      if (step > field.max) return `Step is larger than ${field.hint}.`;
      const rangeText = stepMatch[1] ?? '*';
      if (rangeText !== '*') {
        const [a, b] = rangeText.split('-').map(Number);
        if (a === undefined || b === undefined || !inRange(a) || !inRange(b)) {
          return `Out of range (${field.hint}).`;
        }
        if (a > b) return 'Range start is after its end.';
      }
      continue;
    }

    // Range `a-b`
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      if (!inRange(a) || !inRange(b)) return `Out of range (${field.hint}).`;
      if (a > b) return 'Range start is after its end.';
      continue;
    }

    // Plain number
    if (/^\d+$/.test(token)) {
      if (!inRange(Number(token))) return `Out of range (${field.hint}).`;
      continue;
    }

    return 'Not a valid cron token.';
  }

  return undefined;
}

/** Whether all five cron fields are individually valid. */
export function cronFieldsValid(fields: string[]): boolean {
  return (
    fields.length === 5 &&
    fields.every((value, index) => validateCronField(value, index) === undefined)
  );
}

/** Join five cron fields into a normalized single-space expression. */
export function joinCron(fields: string[]): string {
  return fields.map((field) => field.trim()).join(' ');
}

/** Split a cron expression into exactly five fields, padding with `*` if short. */
export function splitCron(expression: string): [string, string, string, string, string] {
  const parts = expression.trim().split(/\s+/).filter(Boolean);
  // Preserve any overflow (e.g. a 6-field seconds cron) in the last field rather
  // than silently dropping it — the joined field then fails per-field validation
  // so the out-of-contract expression is surfaced instead of quietly truncated.
  const lastField = parts.length > 5 ? parts.slice(4).join(' ') : parts[4];
  return [parts[0] ?? '*', parts[1] ?? '*', parts[2] ?? '*', parts[3] ?? '*', lastField ?? '*'];
}

/** Clamp/parse a `HH:MM` time string into `{ hour, minute }`, defaulting to 00:00. */
export function parseTime(time: string): { hour: number; minute: number } {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 0, minute: 0 };
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return { hour, minute };
}

// ---------------------------------------------------------------------------
// Repeats: what each choice lowers to, and which choice a value reopens as.
// ---------------------------------------------------------------------------

/** The Repeats choices, in the order the field lists them, with their labels. */
export const REPEATS_OPTIONS: readonly { value: ScheduleRepeats; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekends', label: 'Weekends' },
  { value: 'custom-days', label: 'Custom days' },
  { value: 'monthly', label: 'Monthly on a day' },
  { value: 'interval', label: 'Every few minutes or hours' },
  { value: 'cron', label: 'Custom cron' },
];

/**
 * Everything the fields hold, whichever Repeats choice is showing, so that switching choices keeps
 * what the person already chose. `time` is `HH:MM` on a 24-hour clock; `days` are cron
 * day-of-week numbers (0 = Sunday).
 */
export type ScheduleDraft = {
  repeats: ScheduleRepeats;
  time: string;
  days: number[];
  dayOfMonth: number;
  intervalCount: number;
  intervalUnit: ScheduleIntervalUnit;
  cron: string;
};

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAY_NUMBERS = [1, 2, 3, 4, 5];
const WEEKEND_NUMBERS = [0, 6];

/** The time zone the browser runs in, or `UTC` when the runtime cannot say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Every IANA time zone the runtime knows, with `UTC` always among them. */
export function availableTimeZones(): string[] {
  let zones: string[] = [];
  try {
    zones = [...Intl.supportedValuesOf('timeZone')];
  } catch {
    zones = [];
  }
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}

/** The value a builder with no `value` starts from: every day at 9:00 AM in `timeZone`. */
export function defaultScheduleValue(timeZone: string = browserTimeZone()): ScheduleValue {
  return { cron: '0 9 * * *', timeZone };
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function sortedUnique(days: readonly number[]): number[] {
  const unique = [...new Set(days)];
  // `toSorted()` is ES2023 and the package targets ES2022, so sort a copy in place.
  unique.sort((a, b) => a - b);
  return unique;
}

function sameDays(days: readonly number[], expected: readonly number[]): boolean {
  const sorted = sortedUnique(days);
  return sorted.length === expected.length && sorted.every((day, index) => day === expected[index]);
}

/** Whether a cron token is a single integer within the inclusive `[min, max]` range. */
function isFixedInRange(token: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(token)) return false;
  const n = Number(token);
  return n >= min && n <= max;
}

/**
 * The days a day-of-week token names, or `undefined` for a token the Repeats choices cannot
 * show: a step, a name, or a day outside 0–6.
 */
function daysOfWeekToken(token: string): number[] | undefined {
  if (token === '*') return [...ALL_DAYS];
  const days: number[] = [];
  for (const part of token.split(',')) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end || end > 6) return undefined;
      for (let day = start; day <= end; day += 1) days.push(day);
      continue;
    }
    if (!isFixedInRange(part, 0, 6)) return undefined;
    days.push(Number(part));
  }
  return sortedUnique(days);
}

/** The draft an absent value opens as, before any value seeds it. */
function baseDraft(): ScheduleDraft {
  return {
    repeats: 'daily',
    time: '09:00',
    days: [...WEEKDAY_NUMBERS],
    dayOfMonth: 1,
    intervalCount: 1,
    intervalUnit: 'hours',
    cron: '0 9 * * *',
  };
}

/** The Repeats choice a set of days reads as. */
function repeatsForDays(days: readonly number[]): ScheduleRepeats {
  if (sameDays(days, ALL_DAYS)) return 'daily';
  if (sameDays(days, WEEKDAY_NUMBERS)) return 'weekdays';
  if (sameDays(days, WEEKEND_NUMBERS)) return 'weekends';
  return 'custom-days';
}

/**
 * The draft a cron expression opens as: the Repeats choice that would produce it, when one would,
 * and Custom cron otherwise. A step such as `0 *\/6 * * *` stays Custom cron, because "Every 6
 * hours" counts from the start and the step restarts at midnight.
 */
function draftFromCron(expression: string): ScheduleDraft {
  const fields = splitCron(expression);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const draft: ScheduleDraft = { ...baseDraft(), repeats: 'cron', cron: joinCron(fields) };
  if (!cronFieldsValid(fields)) return draft;
  if (!isFixedInRange(minute, 0, 59) || !isFixedInRange(hour, 0, 23) || month !== '*') {
    return draft;
  }
  const time = `${pad2(Number(hour))}:${pad2(Number(minute))}`;
  if (dayOfMonth === '*') {
    const days = daysOfWeekToken(dayOfWeek);
    if (days === undefined || days.length === 0) return draft;
    return { ...draft, repeats: repeatsForDays(days), time, days };
  }
  if (dayOfWeek === '*' && isFixedInRange(dayOfMonth, 1, 31)) {
    return { ...draft, repeats: 'monthly', time, dayOfMonth: Number(dayOfMonth) };
  }
  return draft;
}

/** The draft a value opens as, and so the Repeats choice it shows. */
export function draftFromValue(value: ScheduleValue): ScheduleDraft {
  if ('every' in value) {
    return {
      ...baseDraft(),
      repeats: 'interval',
      intervalCount: value.every.count,
      intervalUnit: value.every.unit,
    };
  }
  return draftFromCron(value.cron);
}

/** The cron expression a draft's time-of-day choice lowers to; Custom cron is the draft's own. */
export function cronForDraft(draft: ScheduleDraft): string {
  const { hour, minute } = parseTime(draft.time);
  const at = `${minute} ${hour}`;
  switch (draft.repeats) {
    case 'daily':
      return `${at} * * *`;
    case 'weekdays':
      return `${at} * * 1-5`;
    case 'weekends':
      return `${at} * * 0,6`;
    case 'custom-days':
      return `${at} * * ${sortedUnique(draft.days).join(',')}`;
    case 'monthly':
      return `${at} ${Math.min(31, Math.max(1, Math.trunc(draft.dayOfMonth)))} * *`;
    case 'interval':
    case 'cron':
      return draft.cron;
  }
}

/** The value a draft emits in `timeZone`: `every` for an interval, `cron` for every other choice. */
export function valueFromDraft(draft: ScheduleDraft, timeZone: string): ScheduleValue {
  if (draft.repeats === 'interval') {
    return { every: { unit: draft.intervalUnit, count: draft.intervalCount }, timeZone };
  }
  return { cron: cronForDraft(draft), timeZone };
}

// ---------------------------------------------------------------------------
// Read-back sentence — no date library required.
// ---------------------------------------------------------------------------

const PLURAL_DAY_NAMES = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

/** A day of the month as an English ordinal: 1st, 2nd, 3rd, 4th, 11th to 13th, 21st, 22nd, 23rd. */
function ordinal(day: number): string {
  const teen = day % 100;
  if (teen >= 11 && teen <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** A `HH:MM` time on a 12-hour clock, such as `9:00 AM` or `12:30 PM`. */
export function formatClockTime(time: string): string {
  const { hour, minute } = parseTime(time);
  const period = hour < 12 ? 'AM' : 'PM';
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour}:${pad2(minute)} ${period}`;
}

/**
 * A time zone's name as a person reads it, such as `Pacific Time`, falling back to the IANA name
 * when the runtime has no better one. UTC reads as `UTC`.
 */
export function timeZoneDisplayName(timeZone: string): string {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return 'UTC';
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' })
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value;
    return name === undefined || name.startsWith('GMT') ? timeZone : name;
  } catch {
    return timeZone;
  }
}

/** "Mondays", "Mondays and Fridays", "Mondays, Wednesdays and Fridays", listed Monday first. */
function listDays(days: readonly number[]): string {
  const names = WEEKDAYS.filter((day) => days.includes(day.value)).map(
    (day) => PLURAL_DAY_NAMES[day.value] ?? '',
  );
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** What a choice repeats on, before "at <time>". */
function describeDays(draft: ScheduleDraft): string {
  switch (draft.repeats) {
    case 'weekdays':
      return 'Weekdays';
    case 'weekends':
      return 'Weekends';
    case 'custom-days':
      return listDays(draft.days);
    case 'monthly':
      return `Monthly on the ${ordinal(draft.dayOfMonth)}`;
    default:
      return 'Every day';
  }
}

/**
 * The schedule read back as a sentence, such as "Weekdays at 9:00 AM Pacific Time". An interval
 * reads as "Every 7 hours"; a cron no choice produces reads as the expression and its zone.
 */
export function describeSchedule(value: ScheduleValue): string {
  if ('every' in value) {
    const { count, unit } = value.every;
    return count === 1 ? `Every ${unit.slice(0, -1)}` : `Every ${count} ${unit}`;
  }
  const zone = timeZoneDisplayName(value.timeZone);
  const draft = draftFromCron(value.cron);
  if (draft.repeats === 'cron') return `Cron ${draft.cron} in ${zone}`;
  return `${describeDays(draft)} at ${formatClockTime(draft.time)} ${zone}`;
}
