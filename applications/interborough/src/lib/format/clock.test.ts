/**
 * The clock words of Home's date line and its rows, read in the sample world's zone (Central time
 * on Monday, Nov 2) so the boards' exact sentences are the expectations.
 */
import { describe, expect, test } from 'bun:test';

import {
  calendarDay,
  clockTime,
  clockTimeWithSeconds,
  dateLine,
  dayAndTime,
  rowTime,
  timesShowIn,
  viewerTimeZone,
  waitedFor,
  zoneLabel,
  zoneName,
} from './clock.ts';

const ZONE = 'America/Chicago';
const NOW = Date.parse('2026-11-02T10:46:00-06:00');

describe('dateLine and timesShowIn', () => {
  test('say the day and name the zone as the board draws them', () => {
    expect(dateLine(NOW, ZONE)).toBe('Monday, Nov 2');
    expect(timesShowIn(NOW, ZONE)).toBe('Times show in Central time (CST)');
  });

  test('read the zone each instant is in, so daylight time names itself', () => {
    expect(zoneName(Date.parse('2026-07-01T12:00:00Z'), ZONE)).toBe('Central time (CDT)');
  });

  test('say a zone with no generic name by its short form alone', () => {
    expect(zoneName(NOW, 'UTC')).toBe('UTC');
  });

  test('read the day the zone is in, not the one the instant is in at UTC', () => {
    const lateEvening = Date.parse('2026-11-03T03:30:00Z');
    expect(dateLine(lateEvening, ZONE)).toBe('Monday, Nov 2');
    expect(dateLine(lateEvening, 'Asia/Tokyo')).toBe('Tuesday, Nov 3');
  });
});

describe('dayStamp', () => {
  test('says the weekday, the day and the clock, for today and for any other day', () => {
    expect(dayStamp(Date.parse('2026-11-02T10:30:00-06:00'), ZONE)).toBe('Mon, Nov 2, 10:30 AM');
    expect(dayStamp(Date.parse('2026-10-30T10:07:00-05:00'), ZONE)).toBe('Fri, Oct 30, 10:07 AM');
  });
});

describe('clockTime and rowTime', () => {
  test('say the clock for a time today', () => {
    expect(clockTime(Date.parse('2026-11-02T10:42:00-06:00'), ZONE)).toBe('10:42 AM');
    expect(rowTime(Date.parse('2026-11-02T09:46:00-06:00'), NOW, ZONE)).toBe('9:46 AM');
  });

  test('say Yesterday for the day before, by the zone’s calendar', () => {
    expect(rowTime(Date.parse('2026-11-01T16:12:00-06:00'), NOW, ZONE)).toBe('Yesterday, 4:12 PM');
    // Just past midnight is a new day, though it is a few minutes ago.
    const justAfterMidnight = Date.parse('2026-11-02T00:10:00-06:00');
    expect(rowTime(Date.parse('2026-11-01T23:50:00-06:00'), justAfterMidnight, ZONE)).toBe(
      'Yesterday, 11:50 PM',
    );
  });

  test('say the day for anything older, and treat a future time as today', () => {
    expect(rowTime(Date.parse('2026-10-29T16:12:00-05:00'), NOW, ZONE)).toBe(
      'Thu, Oct 29, 4:12 PM',
    );
    expect(rowTime(NOW + 60_000, NOW, ZONE)).toBe('10:47 AM');
  });
});

describe('dayAndTime', () => {
  test('names today as well as the clock, and otherwise reads as a row does', () => {
    expect(dayAndTime(Date.parse('2026-11-02T10:30:00-06:00'), NOW, ZONE)).toBe('Today, 10:30 AM');
    expect(dayAndTime(Date.parse('2026-11-01T16:12:00-06:00'), NOW, ZONE)).toBe(
      'Yesterday, 4:12 PM',
    );
    expect(dayAndTime(Date.parse('2026-10-29T11:05:00-05:00'), NOW, ZONE)).toBe(
      'Thu, Oct 29, 11:05 AM',
    );
    expect(dayAndTime(NOW + 60_000, NOW, ZONE)).toBe('Today, 10:47 AM');
  });
});

describe('waitedFor', () => {
  const ago = (milliseconds: number): string => waitedFor(NOW - milliseconds, NOW, ZONE);

  test('says just now under a minute, and rounds the minute as the bell does', () => {
    expect(ago(30_000)).toBe('just now');
    expect(ago(3 * 60_000 + 40_000)).toBe('4 min ago');
    expect(ago(59 * 60_000)).toBe('59 min ago');
  });

  test('says whole hours through the day', () => {
    expect(ago(60 * 60_000)).toBe('1 h ago');
    expect(ago(5 * 3_600_000 + 1_800_000)).toBe('5 h ago');
  });

  test('says the day and clock once it has been a day or more', () => {
    expect(waitedFor(Date.parse('2026-10-31T16:12:00-05:00'), NOW, ZONE)).toBe(
      'Sat Oct 31, 4:12 PM',
    );
  });
});

describe('viewerTimeZone', () => {
  test('names a zone the formatters accept', () => {
    expect(() => dateLine(NOW, viewerTimeZone())).not.toThrow();
  });

  test('is UTC where the browser cannot say', () => {
    const original = Intl.DateTimeFormat;
    Intl.DateTimeFormat = (() => {
      throw new RangeError('No zone');
    }) as never;
    try {
      expect(viewerTimeZone()).toBe('UTC');
    } finally {
      Intl.DateTimeFormat = original;
    }
  });
});

describe('zoneLabel and calendarDay', () => {
  test('zoneLabel names the zone as a day band does, without its short form', () => {
    expect(zoneLabel(NOW, ZONE)).toBe('Central time');
    expect(zoneLabel(Date.parse('2026-07-01T12:00:00Z'), ZONE)).toBe('Central time');
    expect(zoneLabel(NOW, 'UTC')).toBe('UTC');
  });

  test('calendarDay counts days in the zone, so a difference is the days between two instants', () => {
    const yesterday = Date.parse('2026-11-01T16:12:00-06:00');
    const lateEvening = Date.parse('2026-11-03T03:30:00Z');
    expect(calendarDay(NOW, ZONE) - calendarDay(yesterday, ZONE)).toBe(1);
    // 9:30 PM on Monday in Chicago is already Tuesday in Tokyo.
    expect(calendarDay(lateEvening, ZONE)).toBe(calendarDay(NOW, ZONE));
    expect(calendarDay(lateEvening, 'Asia/Tokyo')).toBe(calendarDay(NOW, ZONE) + 1);
  });
});

describe('clockTimeWithSeconds', () => {
  test('says the second a run started on a twelve-hour clock (55s)', () => {
    expect(clockTimeWithSeconds(Date.parse('2026-11-02T10:42:11-06:00'), ZONE)).toBe('10:42:11 AM');
    expect(clockTimeWithSeconds(Date.parse('2026-11-02T16:05:09-06:00'), ZONE)).toBe('4:05:09 PM');
  });

  test('reads the zone it is given, not the one the instant is in at UTC', () => {
    expect(clockTimeWithSeconds(Date.parse('2026-11-02T16:42:11Z'), ZONE)).toBe('10:42:11 AM');
  });
});
