import { normalizeStorageTimestamp } from '../scheduler.ts';
import {
  getDefaultTimeZone,
  getZonedParts,
  localDateTimeToTimestamp,
  matchesDay,
  selectNextValue,
  shiftLocalDateTime,
} from './cron-formatter.ts';
import { parseCronExpression } from './cron-parser.ts';
import type {
  CronOccurrenceOptions,
  LocalDateTime,
  ParsedCronExpression,
  ZonedParts,
} from './cron-types.ts';

function nextSearchTimestamp(candidate: number): number {
  return candidate + 1000;
}

function startOfLocalDay(parts: ZonedParts): LocalDateTime {
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
  };
}

function advanceToNextMonth(
  candidate: number,
  parts: ZonedParts,
  parsedExpression: ParsedCronExpression,
  timeZone: string,
): number {
  const nextMonth = selectNextValue(parsedExpression.months.values, parts.month);
  const monthCandidate = localDateTimeToTimestamp(
    {
      year: parts.year + (nextMonth.wrapped ? 1 : 0),
      month: nextMonth.value,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
    nextSearchTimestamp(candidate),
  );

  return monthCandidate ?? candidate + 86_400_000;
}

function advanceToNextDay(candidate: number, parts: ZonedParts, timeZone: string): number {
  const nextDayCandidate = localDateTimeToTimestamp(
    shiftLocalDateTime(startOfLocalDay(parts), { days: 1 }),
    timeZone,
    nextSearchTimestamp(candidate),
  );

  return nextDayCandidate ?? candidate + 86_400_000;
}

function advanceToNextHour(
  candidate: number,
  parts: ZonedParts,
  parsedExpression: ParsedCronExpression,
  timeZone: string,
): number {
  const nextHour = selectNextValue(parsedExpression.hours.values, parts.hour);
  const hourCandidate = localDateTimeToTimestamp(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: nextHour.value,
      minute: 0,
      second: 0,
    },
    timeZone,
    nextSearchTimestamp(candidate),
  );

  return hourCandidate ?? advanceToNextDay(candidate, parts, timeZone);
}

function advanceToNextMinute(
  candidate: number,
  parts: ZonedParts,
  parsedExpression: ParsedCronExpression,
  timeZone: string,
): number {
  const nextMinute = selectNextValue(parsedExpression.minutes.values, parts.minute);
  const minuteCandidate = localDateTimeToTimestamp(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: nextMinute.value,
      second: 0,
    },
    timeZone,
    nextSearchTimestamp(candidate),
  );

  if (minuteCandidate !== null) {
    return minuteCandidate;
  }

  const nextHourBoundary = localDateTimeToTimestamp(
    shiftLocalDateTime(
      {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour,
        minute: 0,
        second: 0,
      },
      { hours: 1 },
    ),
    timeZone,
    nextSearchTimestamp(candidate),
  );

  return nextHourBoundary ?? candidate + 3_600_000;
}

function advanceToNextSecond(
  candidate: number,
  parts: ZonedParts,
  parsedExpression: ParsedCronExpression,
  timeZone: string,
): number {
  const nextSecond = selectNextValue(parsedExpression.seconds.values, parts.second);
  const secondCandidate = localDateTimeToTimestamp(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
      second: nextSecond.value,
    },
    timeZone,
    nextSearchTimestamp(candidate),
  );

  if (secondCandidate !== null) {
    return secondCandidate;
  }

  const nextMinuteBoundary = localDateTimeToTimestamp(
    shiftLocalDateTime(
      {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour,
        minute: parts.minute,
        second: 0,
      },
      { minutes: 1 },
    ),
    timeZone,
    nextSearchTimestamp(candidate),
  );

  return nextMinuteBoundary ?? candidate + 60_000;
}

/**
 * How many candidate steps the search takes before it gives up on an expression that parses but
 * can never match, such as the 31st of April. Each step resolves a zoned calendar date, so the
 * exhaustive search is seconds of real work; only the slow lane runs it at this bound.
 */
const MAXIMUM_CRON_SEARCH_STEPS = 100_000;

/**
 * Find the next occurrence of a cron expression after a timestamp, giving up after
 * `maximumSearchSteps` candidate steps. This is the search behind {@link getNextCronOccurrence},
 * which fixes the bound at {@link MAXIMUM_CRON_SEARCH_STEPS}; it is exported so a fast test can
 * exhaust the search with a small bound instead of the production one.
 */
export function searchNextCronOccurrence(
  expression: string | ParsedCronExpression,
  afterTimestamp: number,
  options: CronOccurrenceOptions | undefined,
  maximumSearchSteps: number,
): number {
  const parsedExpression =
    typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const timeZone = options?.timeZone ?? getDefaultTimeZone();
  let candidate = normalizeStorageTimestamp(
    Math.floor(afterTimestamp / 1000) * 1000 + 1000,
    'Cron occurrence candidate',
  );

  for (let iteration = 0; iteration < maximumSearchSteps; iteration += 1) {
    const parts = getZonedParts(candidate, timeZone);

    if (!parsedExpression.months.values.includes(parts.month)) {
      candidate = advanceToNextMonth(candidate, parts, parsedExpression, timeZone);
      continue;
    }

    if (!matchesDay(parts, parsedExpression)) {
      candidate = advanceToNextDay(candidate, parts, timeZone);
      continue;
    }

    if (!parsedExpression.hours.values.includes(parts.hour)) {
      candidate = advanceToNextHour(candidate, parts, parsedExpression, timeZone);
      continue;
    }

    if (!parsedExpression.minutes.values.includes(parts.minute)) {
      candidate = advanceToNextMinute(candidate, parts, parsedExpression, timeZone);
      continue;
    }

    if (!parsedExpression.seconds.values.includes(parts.second)) {
      candidate = advanceToNextSecond(candidate, parts, parsedExpression, timeZone);
      continue;
    }

    return candidate;
  }

  throw new Error(`Could not find the next cron occurrence for "${parsedExpression.expression}"`);
}

export function getNextCronOccurrence(
  expression: string | ParsedCronExpression,
  afterTimestamp: number,
  options?: CronOccurrenceOptions,
): number {
  return searchNextCronOccurrence(expression, afterTimestamp, options, MAXIMUM_CRON_SEARCH_STEPS);
}

export function collectDueCronOccurrences(
  expression: string | ParsedCronExpression,
  firstDueAt: number,
  throughTimestamp: number,
  options?: CronOccurrenceOptions,
): number[] {
  const parsedExpression =
    typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const dueOccurrences: number[] = [];
  const requestedMaxOccurrences = options?.maxOccurrences;
  if (
    requestedMaxOccurrences !== undefined &&
    (!Number.isSafeInteger(requestedMaxOccurrences) || requestedMaxOccurrences <= 0)
  ) {
    throw new Error('Cron occurrence maxOccurrences must be a positive safe integer');
  }
  const maximumOccurrences = requestedMaxOccurrences ?? Number.POSITIVE_INFINITY;
  let nextOccurrence = firstDueAt;

  while (nextOccurrence <= throughTimestamp && dueOccurrences.length < maximumOccurrences) {
    dueOccurrences.push(nextOccurrence);
    nextOccurrence = getNextCronOccurrence(parsedExpression, nextOccurrence, options);
  }

  return dueOccurrences;
}
