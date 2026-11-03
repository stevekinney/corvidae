import { beforeAll, describe, expect, test } from 'bun:test';

import { environmentConfiguration } from '../../scripts/environment-configuration.ts';
import {
  formatDate,
  formatDateTime,
  formatDayAndTime,
  formatDayHeading,
  formatRelativeTime,
  formatScheduleTime,
  formatTimeOfDay,
  formatTimestamp,
  formatTimeZoneLabel,
} from './format-date.ts';

const DAY_MILLISECONDS = 86_400_000;

beforeAll(() => {
  if (environmentConfiguration().tz !== 'UTC') {
    throw new Error(
      'format-date.test.ts requires TZ=UTC. Run via `bun run test`, not bare `bun test`.',
    );
  }
});

const FIXED_DATE = new Date('2026-04-15T12:34:56.000Z');

describe('formatDate', () => {
  test('formats with explicit defaults (en-US, the viewer zone)', () => {
    // Intl.DateTimeFormat with no date-style options falls back to numeric M/D/Y.
    expect(formatDate(FIXED_DATE)).toBe('4/15/2026');
  });

  test('accepts ISO string input', () => {
    expect(formatDate('2026-04-15T12:34:56.000Z')).toBe('4/15/2026');
  });

  test('accepts numeric (epoch ms) input', () => {
    expect(formatDate(FIXED_DATE.getTime())).toBe('4/15/2026');
  });

  test('honors locale override', () => {
    // en-GB swaps day/month order.
    expect(formatDate(FIXED_DATE, 'en-GB')).toBe('15/04/2026');
  });

  test('honors options override (date and time, fixed time zone)', () => {
    const formatted = formatDate(FIXED_DATE, 'en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    // macOS/Linux Intl may emit "at" between date and time; match both forms.
    expect(formatted).toMatch(/^Apr 15, 2026.+12:34$/);
  });

  test('defaults to the viewer time zone and keeps it when only other options are overridden', () => {
    // The suite runs under TZ=UTC, so the viewer zone is UTC; a fixed zone must differ from it.
    const instant = new Date('2026-04-30T23:30:00.000Z');
    expect(formatDate(instant, 'en-US', { month: 'long' })).toBe('April');
    expect(formatDate(instant, 'en-US', { timeZone: 'Pacific/Auckland', month: 'long' })).toBe(
      'May',
    );
  });

  test('time zone override shifts wall-clock display', () => {
    // 12:34 UTC is 08:34 in America/New_York (EDT, UTC-4) on 2026-04-15.
    const formatted = formatDate(FIXED_DATE, 'en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(formatted).toBe('08:34');
  });
});

const CENTRAL = 'America/Chicago';
// Monday, Nov 2, 2026, 10:46 AM CST (UTC-6; daylight saving ended Nov 1).
const NOW = Date.UTC(2026, 10, 2, 16, 46);
const central = { timeZone: CENTRAL, now: NOW };

describe('formatRelativeTime', () => {
  test('returns "just now" for sub-minute deltas', () => {
    expect(formatRelativeTime(NOW - 30_000, central)).toBe('just now');
  });

  test('reads minutes as "4 min ago"', () => {
    expect(formatRelativeTime(NOW - 4 * 60_000, central)).toBe('4 min ago');
    expect(formatRelativeTime(NOW - 59 * 60_000, central)).toBe('59 min ago');
  });

  test('reads hours within today as "1 h ago"', () => {
    expect(formatRelativeTime(NOW - 1 * 3_600_000, central)).toBe('1 h ago');
    expect(formatRelativeTime(NOW - 10 * 3_600_000, central)).toBe('10 h ago');
  });

  test('reads yesterday as "Yesterday, 4:12 PM" in the viewer zone', () => {
    // Nov 1, 4:12 PM CST is 22:12 UTC.
    expect(formatRelativeTime(Date.UTC(2026, 10, 1, 22, 12), central)).toBe('Yesterday, 4:12 PM');
  });

  test('keeps four minutes across midnight relative', () => {
    const justAfterMidnight = Date.UTC(2026, 10, 2, 6, 2);
    expect(
      formatRelativeTime(justAfterMidnight - 4 * 60_000, { ...central, now: justAfterMidnight }),
    ).toBe('4 min ago');
  });

  test('reads older days as an absolute weekday, month and day', () => {
    expect(formatRelativeTime(Date.UTC(2026, 9, 29, 9, 0), central)).toBe('Thu Oct 29, 4:00 AM');
  });

  test('adds the year for a day in another year', () => {
    expect(formatRelativeTime(Date.UTC(2025, 9, 23, 19, 10), central)).toBe(
      'Thu Oct 23, 2025, 2:10 PM',
    );
  });

  test('reads the near future as "in 4 min" and "in 2 h"', () => {
    expect(formatRelativeTime(NOW + 4 * 60_000, central)).toBe('in 4 min');
    expect(formatRelativeTime(NOW + 2 * 3_600_000, central)).toBe('in 2 h');
  });

  test('reads tomorrow as an absolute "Tomorrow, 9:00 AM"', () => {
    expect(formatRelativeTime(Date.UTC(2026, 10, 3, 15, 0), central)).toBe('Tomorrow, 9:00 AM');
  });

  test('accepts a Date instance and an ISO string', () => {
    expect(formatRelativeTime(new Date(NOW - 10_000), central)).toBe('just now');
    expect(formatRelativeTime(new Date(NOW - 120_000).toISOString(), central)).toBe('2 min ago');
  });

  test('uses the locale for non-English output instead of English words', () => {
    expect(formatRelativeTime(NOW - 4 * 60_000, { ...central, locale: 'de' })).not.toContain('ago');
  });

  test('returns "Invalid date" for an unparseable input', () => {
    expect(formatRelativeTime('not-a-date', central)).toBe('Invalid date');
  });

  test('defaults to the viewer zone and the current time', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe('5 min ago');
  });
});

describe('formatDateTime', () => {
  test('writes today and yesterday as words with one 12-hour clock', () => {
    expect(formatDateTime(Date.UTC(2026, 10, 2, 16, 44), central)).toBe('Today, 10:44 AM');
    expect(formatDateTime(Date.UTC(2026, 10, 1, 22, 12), central)).toBe('Yesterday, 4:12 PM');
  });

  test('writes a day further back as weekday, month and day', () => {
    expect(formatDateTime(Date.UTC(2026, 10, 1, 22, 12) - DAY_MILLISECONDS, central)).toBe(
      'Sat Oct 31, 5:12 PM',
    );
  });

  test('defaults to the viewer zone', () => {
    const today = new Date();
    expect(formatDateTime(today, { now: today })).toBe(`Today, ${formatTimeOfDay(today)}`);
  });

  test('is absolute even for a moment seconds ago', () => {
    expect(formatDateTime(NOW - 5_000, central)).toBe('Today, 10:45 AM');
  });

  test('reads midnight and noon on the 12-hour clock', () => {
    expect(formatDateTime(Date.UTC(2026, 10, 2, 6, 0), central)).toBe('Today, 12:00 AM');
    expect(formatDateTime(Date.UTC(2026, 10, 2, 18, 0), central)).toBe('Today, 12:00 PM');
  });

  test('returns "Invalid date" for an unparseable input', () => {
    expect(formatDateTime(Number.NaN, central)).toBe('Invalid date');
  });
});

describe('formatTimeOfDay', () => {
  test('uses one 12-hour clock with AM or PM and a plain space', () => {
    const result = formatTimeOfDay(Date.UTC(2026, 10, 2, 21, 5), { timeZone: CENTRAL });
    expect(result).toBe('3:05 PM');
    expect(result).not.toMatch(/[\u202f\u00a0]/);
  });

  test('returns "Invalid date" for an unparseable input', () => {
    expect(formatTimeOfDay('nope')).toBe('Invalid date');
  });
});

describe('formatTimeZoneLabel', () => {
  test('names the zone as an abbreviation or as "Central time"', () => {
    const date = Date.UTC(2026, 10, 2, 16, 46);
    expect(formatTimeZoneLabel(date, { timeZone: CENTRAL })).toBe('CST');
    expect(formatTimeZoneLabel(date, { timeZone: CENTRAL, style: 'long' })).toBe('Central time');
  });

  test('follows daylight saving', () => {
    expect(formatTimeZoneLabel(Date.UTC(2026, 6, 1), { timeZone: CENTRAL })).toBe('CDT');
  });

  test('returns "Invalid date" for an unparseable input', () => {
    expect(formatTimeZoneLabel('nope')).toBe('Invalid date');
  });
});

describe('formatDayHeading', () => {
  test('names the zone after each day group', () => {
    expect(formatDayHeading(NOW, central)).toBe('Today · Central time');
    expect(formatDayHeading(Date.UTC(2026, 10, 1, 22, 12), central)).toBe(
      'Yesterday · Sunday, Nov 1 · Central time',
    );
    expect(formatDayHeading(Date.UTC(2026, 9, 29, 15, 0), central)).toBe(
      'Thursday, Oct 29 · Central time',
    );
  });

  test('can leave the zone off and adds the year for another year', () => {
    expect(formatDayHeading(Date.UTC(2025, 9, 29, 15, 0), { ...central, includeZone: false })).toBe(
      'Wednesday, Oct 29, 2025',
    );
  });

  test('groups by the viewer-zone calendar day, not the UTC day', () => {
    // 11:30 PM CST on Nov 1 is already Nov 2 in UTC.
    expect(formatDayHeading(Date.UTC(2026, 10, 2, 5, 30), central)).toBe(
      'Yesterday · Sunday, Nov 1 · Central time',
    );
  });

  test('returns "Invalid date" for an unparseable input', () => {
    expect(formatDayHeading('nope')).toBe('Invalid date');
  });
});

describe('formatScheduleTime', () => {
  test('follows the viewer reading with the schedule zone in parentheses', () => {
    // 3:00 AM CST is 9:00 AM UTC.
    expect(formatScheduleTime(Date.UTC(2026, 10, 2, 9, 0), 'UTC', { timeZone: CENTRAL })).toBe(
      '3:00 AM (9:00 AM UTC)',
    );
  });

  test('collapses to one reading when the zones read the same', () => {
    expect(formatScheduleTime(Date.UTC(2026, 10, 2, 9, 0), CENTRAL, { timeZone: CENTRAL })).toBe(
      '3:00 AM',
    );
  });

  test('returns "Invalid date" for an unparseable input', () => {
    expect(formatScheduleTime('nope', 'UTC')).toBe('Invalid date');
  });
});

describe('formatTimestamp', () => {
  test('returns "-" for null', () => {
    expect(formatTimestamp(null)).toBe('-');
  });

  test('returns "-" for undefined', () => {
    expect(formatTimestamp(undefined)).toBe('-');
  });

  test('returns a non-empty string for a valid Date', () => {
    const result = formatTimestamp(FIXED_DATE);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe('-');
  });

  test('accepts numeric epoch input', () => {
    const result = formatTimestamp(FIXED_DATE.getTime());
    expect(result.length).toBeGreaterThan(0);
  });

  test('accepts ISO string input', () => {
    const result = formatTimestamp('2026-04-15T12:34:56.000Z');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('COR-2010 board forms', () => {
  // The design's sample world: now is Mon Nov 2, 10:46 AM Central.
  const nowCentral = Date.UTC(2026, 10, 2, 16, 46);
  const options = { timeZone: CENTRAL, now: nowCentral };

  describe('formatDateTime with dayWords: false (row 70g)', () => {
    test('names tomorrow by its calendar day, not "Tomorrow"', () => {
      const dailySummary = Date.UTC(2026, 10, 3, 9, 0);
      expect(formatDateTime(dailySummary, options)).toBe('Tomorrow, 3:00 AM');
      expect(formatDateTime(dailySummary, { ...options, dayWords: false })).toBe(
        'Tue Nov 3, 3:00 AM',
      );
    });

    test('names today and yesterday by their calendar day too', () => {
      expect(formatDateTime(Date.UTC(2026, 10, 2, 16, 44), { ...options, dayWords: false })).toBe(
        'Mon Nov 2, 10:44 AM',
      );
      expect(formatDateTime(Date.UTC(2026, 10, 1, 22, 12), { ...options, dayWords: false })).toBe(
        'Sun Nov 1, 4:12 PM',
      );
    });

    test('keeps the Nov 6 form of a later day', () => {
      expect(formatDateTime(Date.UTC(2026, 10, 6, 17, 0), { ...options, dayWords: false })).toBe(
        'Fri Nov 6, 11:00 AM',
      );
    });
  });

  describe('formatDayAndTime (row 56p)', () => {
    test('writes the run-detail form even when the day is today', () => {
      expect(formatDayAndTime(Date.UTC(2026, 10, 2, 15, 20), options)).toBe('Mon, Nov 2 · 9:20 AM');
    });

    test('adds the year for another year and rejects an invalid date', () => {
      expect(formatDayAndTime(Date.UTC(2025, 10, 2, 15, 20), options)).toBe(
        'Sun, Nov 2, 2025 · 9:20 AM',
      );
      expect(formatDayAndTime('nope', options)).toBe('Invalid date');
    });
  });

  describe("formatRelativeTime with units: 'spelled' (row 72h)", () => {
    const spelled = { ...options, units: 'spelled' as const };

    test('reads the upcoming occurrences of the schedule detail', () => {
      expect(formatRelativeTime(Date.UTC(2026, 10, 3, 9, 0), spelled)).toBe('in 16 hours');
      expect(formatRelativeTime(Date.UTC(2026, 10, 4, 9, 0), spelled)).toBe('in 2 days');
      expect(formatRelativeTime(Date.UTC(2026, 10, 5, 9, 0), spelled)).toBe('in 3 days');
    });

    test('spells minutes and past moments the same way', () => {
      expect(formatRelativeTime(nowCentral + 4 * 60_000, spelled)).toBe('in 4 minutes');
      expect(formatRelativeTime(nowCentral - 3 * 3_600_000, spelled)).toBe('3 hours ago');
      expect(formatRelativeTime(nowCentral - 3 * DAY_MILLISECONDS, spelled)).toBe('3 days ago');
      expect(formatRelativeTime(nowCentral + 20_000, spelled)).toBe('just now');
    });

    test('falls back to the absolute form beyond a week', () => {
      expect(formatRelativeTime(Date.UTC(2026, 10, 12, 9, 0), spelled)).toBe('Thu Nov 12, 3:00 AM');
    });

    test('leaves the compact default untouched', () => {
      expect(formatRelativeTime(nowCentral + 2 * 3_600_000, options)).toBe('in 2 h');
    });
  });
});
