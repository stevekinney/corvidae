const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A date, an ISO string or epoch milliseconds. */
export type DateInput = Date | string | number;

/** Options shared by the viewer-zone date helpers. */
export type DateFormatOptions = {
  /** Locale, `en-US` by default. */
  locale?: Intl.LocalesArgument | undefined;
  /** IANA time zone. Defaults to the viewer's zone. */
  timeZone?: string | undefined;
  /** The reference time for "today" and "ago" (a `Date` or epoch milliseconds). Defaults to now. */
  now?: Date | number | undefined;
  /**
   * Whether {@link formatDateTime} may say "Today", "Yesterday" and "Tomorrow". Defaults to true.
   * Set it to false for a schedule or an occurrence that must always name its calendar day
   * ("Tue Nov 3, 3:00 AM"), even when that day is tomorrow. Set it to `'today'` to say "Today"
   * and name every other day ("Today, 10:44 AM", "Sun Nov 1, 4:12 PM"), the reading of an
   * absolute "Updated" time.
   */
  dayWords?: boolean | 'today' | undefined;
};

/** Options for {@link formatRelativeTime}. */
export type RelativeTimeFormatOptions = DateFormatOptions & {
  /**
   * `compact` (the default) reads "4 min ago" and "1 h ago" within today and falls back to the
   * absolute form on any other day. `spelled` writes the unit out and reaches across days:
   * "in 16 hours", "in 2 days", "3 days ago", falling back to the absolute form beyond a week.
   */
  units?: 'compact' | 'spelled' | undefined;
};

/** Options for {@link formatTimeZoneLabel}. */
export type TimeZoneLabelOptions = Omit<DateFormatOptions, 'now'> & {
  /** `short` reads "CST"; `long` reads "Central time". */
  style?: 'short' | 'long' | undefined;
};

/** Options for {@link formatDayHeading}. */
export type DayHeadingOptions = DateFormatOptions & {
  /** Name the zone after the day, as "Today · Central time". Defaults to true. */
  includeZone?: boolean | undefined;
};

function toDate(input: DateInput): Date {
  return input instanceof Date ? input : new Date(input);
}

function isEnglish(locale: Intl.LocalesArgument | undefined): boolean {
  if (locale === undefined) return true;
  const first = typeof locale === 'string' ? locale : Array.isArray(locale) ? locale[0] : locale;
  const tag = typeof first === 'string' ? first : (first?.baseName ?? 'en-US');
  return tag.toLowerCase().split('-')[0] === 'en';
}

/** Intl emits a narrow no-break space before AM and PM on current ICU builds; one plain space reads the same everywhere. */
function plainSpaces(text: string): string {
  return text.replace(/[  ]/g, ' ');
}

/**
 * Format a date with explicit locale and time-zone control.
 *
 * Defaults to `en-US` and the viewer's time zone. Pass an `Intl.DateTimeFormatOptions` object to
 * choose another time zone or formatting.
 */
export function formatDate(
  date: Date | string | number,
  locale: Intl.LocalesArgument = 'en-US',
  options: Intl.DateTimeFormatOptions = {},
): string {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(locale, options).format(d);
}

/** The clock time on one 12-hour clock with AM or PM, such as "4:12 PM". */
export function formatTimeOfDay(input: DateInput, options: DateFormatOptions = {}): string {
  const date = toDate(input);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  return plainSpaces(
    formatDate(date, options.locale ?? 'en-US', {
      timeZone: options.timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }),
  );
}

/**
 * Name a time zone for a moment: "CST" (`short`) or "Central time" (`long`). The abbreviation
 * follows daylight saving, so the same zone reads "CDT" in summer.
 */
export function formatTimeZoneLabel(input: DateInput, options: TimeZoneLabelOptions = {}): string {
  const date = toDate(input);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  const locale = options.locale ?? 'en-US';
  const long = options.style === 'long';
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: options.timeZone,
    timeZoneName: long ? 'longGeneric' : 'short',
  }).formatToParts(date);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  // Intl title-cases the generic name ("Central Time"); the design writes "Central time".
  return long && isEnglish(options.locale) ? name.replace(/ Time$/, ' time') : name;
}

/** The calendar day of an instant in a zone, as a whole number of days since the epoch. */
function calendarDay(date: Date, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Math.round(Date.UTC(read('year'), read('month') - 1, read('day')) / DAY);
}

function calendarYear(date: Date, timeZone: string | undefined): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' })
      .formatToParts(date)
      .find((part) => part.type === 'year')?.value,
  );
}

function resolveNow(now: Date | number | undefined): Date {
  if (now === undefined) return new Date();
  return now instanceof Date ? now : new Date(now);
}

/** How many calendar days (in the zone) `date` lies before `now`: 0 today, 1 yesterday, -1 tomorrow. */
function daysBefore(date: Date, now: Date, timeZone: string | undefined): number {
  return calendarDay(now, timeZone) - calendarDay(date, timeZone);
}

function dayWord(offset: -1 | 0 | 1, locale: Intl.LocalesArgument | undefined): string {
  if (isEnglish(locale)) return offset === 0 ? 'Today' : offset === 1 ? 'Yesterday' : 'Tomorrow';
  const word = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-offset, 'day');
  return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
}

/** "Sun Nov 1" in English, the locale's own order elsewhere; the year joins when it is not this year. */
function shortDayLabel(date: Date, now: Date, options: DateFormatOptions): string {
  const locale = options.locale ?? 'en-US';
  const timeZone = options.timeZone;
  const withYear = calendarYear(date, timeZone) !== calendarYear(now, timeZone);
  if (!isEnglish(options.locale)) {
    return formatDate(date, locale, {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(withYear ? { year: 'numeric' } : {}),
    });
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const label = `${read('weekday')} ${read('month')} ${read('day')}`;
  return withYear ? `${label}, ${read('year')}` : label;
}

/**
 * An absolute date and time in the viewer's zone on one 12-hour clock: "Today, 10:44 AM",
 * "Yesterday, 4:12 PM", "Sun Nov 1, 4:12 PM". Never relative; pair it with
 * {@link formatRelativeTime} in a tooltip. Pass `dayWords: false` to always name the calendar day
 * ("Tue Nov 3, 3:00 AM" rather than "Tomorrow, 3:00 AM"), or `dayWords: 'today'` to say only
 * "Today" ("Sun Nov 1, 4:12 PM" rather than "Yesterday, 4:12 PM").
 */
export function formatDateTime(input: DateInput, options: DateFormatOptions = {}): string {
  const date = toDate(input);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  const now = resolveNow(options.now);
  const time = formatTimeOfDay(date, options);
  const offset = daysBefore(date, now, options.timeZone);
  const saysWord =
    options.dayWords === 'today'
      ? offset === 0
      : options.dayWords !== false && (offset === 0 || offset === 1 || offset === -1);
  const label =
    saysWord && (offset === 0 || offset === 1 || offset === -1)
      ? dayWord(offset, options.locale)
      : shortDayLabel(date, now, options);
  return `${label}, ${time}`;
}

function relativeUnit(
  value: number,
  unit: 'minute' | 'hour',
  past: boolean,
  locale: Intl.LocalesArgument | undefined,
): string {
  if (isEnglish(locale)) {
    const text = `${value} ${unit === 'minute' ? 'min' : 'h'}`;
    return past ? `${text} ago` : `in ${text}`;
  }
  return new Intl.RelativeTimeFormat(locale, { style: 'short' }).format(
    past ? -value : value,
    unit,
  );
}

/**
 * Format a moment relative to now: "just now", "4 min ago", "1 h ago" within today, then the
 * absolute form from {@link formatDateTime} ("Yesterday, 4:12 PM", "Sun Nov 1, 4:12 PM"). A moment
 * in the near future reads "in 4 min" or "in 2 h". With `units: 'spelled'` the unit is written out
 * and days are reachable: "in 16 hours", "in 2 days", "3 days ago".
 */
export function formatRelativeTime(
  input: DateInput,
  options: RelativeTimeFormatOptions = {},
): string {
  const date = toDate(input);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  const now = resolveNow(options.now);
  const elapsed = now.getTime() - date.getTime();
  const distance = Math.abs(elapsed);
  const past = elapsed >= 0;

  if (options.units === 'spelled') return formatSpelledRelativeTime(date, now, elapsed, options);

  if (distance < MINUTE)
    return isEnglish(options.locale) ? 'just now' : relativeNow(options.locale);
  if (distance < HOUR) {
    return relativeUnit(Math.floor(distance / MINUTE), 'minute', past, options.locale);
  }
  if (daysBefore(date, now, options.timeZone) !== 0) return formatDateTime(date, options);
  return relativeUnit(Math.floor(distance / HOUR), 'hour', past, options.locale);
}

/**
 * How long ago a moment was in the few characters a list row's time column has, and never "ago":
 * "now" under a minute, "4 min" to the nearest minute under an hour, "7 h" in whole hours under a
 * day, the weekday ("Sun") under a week, then the date ("Oct 24", with the year when it is not this
 * one). A moment in the future reads "now". Another language reads {@link formatRelativeTime}.
 */
export function formatCompactAge(input: DateInput, options: DateFormatOptions = {}): string {
  const date = toDate(input);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  if (!isEnglish(options.locale)) return formatRelativeTime(date, options);
  const now = resolveNow(options.now);
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) {
    const minutes = Math.round(elapsed / MINUTE);
    return minutes >= 60 ? '1 h' : `${minutes} min`;
  }
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h`;
  const locale = options.locale ?? 'en-US';
  if (elapsed < 7 * DAY) {
    return formatDate(date, locale, { timeZone: options.timeZone, weekday: 'short' });
  }
  const withYear = calendarYear(date, options.timeZone) !== calendarYear(now, options.timeZone);
  return formatDate(date, locale, {
    timeZone: options.timeZone,
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** The `spelled` reading: minutes, hours, then whole days up to a week, then the absolute form. */
function formatSpelledRelativeTime(
  date: Date,
  now: Date,
  elapsed: number,
  options: RelativeTimeFormatOptions,
): string {
  const distance = Math.abs(elapsed);
  const sign = elapsed >= 0 ? -1 : 1;
  if (distance < MINUTE) {
    return isEnglish(options.locale) ? 'just now' : relativeNow(options.locale);
  }
  const formatter = new Intl.RelativeTimeFormat(options.locale, {
    numeric: 'always',
    style: 'long',
  });
  if (distance < HOUR) return formatter.format(sign * Math.floor(distance / MINUTE), 'minute');
  if (distance < DAY) return formatter.format(sign * Math.floor(distance / HOUR), 'hour');
  const days = Math.round(distance / DAY);
  if (days <= 7) return formatter.format(sign * days, 'day');
  return formatDateTime(date, { ...options, now });
}

function relativeNow(locale: Intl.LocalesArgument | undefined): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
}

/**
 * A calendar day and a clock time joined by a middle dot, for a detail line that carries more
 * facts after it: "Mon, Nov 2 · 9:20 AM". It always names the day, even when that day is today, and
 * adds the year when it is not this year.
 */
export function formatDayAndTime(input: DateInput, options: DateFormatOptions = {}): string {
  const date = toDate(input);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  const now = resolveNow(options.now);
  const withYear = calendarYear(date, options.timeZone) !== calendarYear(now, options.timeZone);
  const day = formatDate(date, options.locale ?? 'en-US', {
    timeZone: options.timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
  return `${day} · ${formatTimeOfDay(date, options)}`;
}

/**
 * A day group heading that names the zone: "Today · Central time",
 * "Yesterday · Sunday, Nov 1 · Central time", "Thursday, Oct 29 · Central time".
 */
export function formatDayHeading(input: DateInput, options: DayHeadingOptions = {}): string {
  const date = toDate(input);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  const now = resolveNow(options.now);
  const locale = options.locale ?? 'en-US';
  const offset = daysBefore(date, now, options.timeZone);
  const withYear = calendarYear(date, options.timeZone) !== calendarYear(now, options.timeZone);
  const calendar = formatDate(date, locale, {
    timeZone: options.timeZone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
  const segments =
    offset === 0
      ? [dayWord(0, options.locale)]
      : offset === 1
        ? [dayWord(1, options.locale), calendar]
        : [calendar];
  if (options.includeZone !== false) {
    segments.push(formatTimeZoneLabel(date, { ...options, style: 'long' }));
  }
  return segments.join(' · ');
}

/**
 * A recurring time as the viewer reads it, with the schedule's own zone after it where that zone
 * reads differently: "3:00 AM (9:00 AM UTC)". Equal readings collapse to "3:00 AM".
 */
export function formatScheduleTime(
  input: DateInput,
  scheduleTimeZone: string,
  options: Omit<DateFormatOptions, 'now'> = {},
): string {
  const date = toDate(input);
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  const viewerReading = formatTimeOfDay(date, options);
  const viewerLabel = formatTimeZoneLabel(date, options);
  const scheduleReading = formatTimeOfDay(date, { ...options, timeZone: scheduleTimeZone });
  const scheduleLabel = formatTimeZoneLabel(date, { ...options, timeZone: scheduleTimeZone });
  if (viewerReading === scheduleReading && viewerLabel === scheduleLabel) return viewerReading;
  return `${viewerReading} (${scheduleReading} ${scheduleLabel})`;
}

/** Format a timestamp with seconds for display, in the viewer's zone. Returns "-" for null/undefined. */
export function formatTimestamp(
  input: number | string | Date | null | undefined,
  options: Omit<DateFormatOptions, 'now'> = {},
): string {
  if (input === null || input === undefined) return '-';

  return plainSpaces(
    formatDate(toDate(input), options.locale ?? 'en-US', {
      timeZone: options.timeZone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }),
  );
}
