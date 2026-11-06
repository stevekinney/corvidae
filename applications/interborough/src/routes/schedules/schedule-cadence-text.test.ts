/**
 * A cadence as a row of the Schedules list says it: a clock time in the viewer's zone, with the
 * schedule's own reading after it where that differs, and a shorter form for a phone's third line.
 * The viewer's zone is the machine's, so each case names the zone it is read in.
 */
import { describe, expect, test } from 'bun:test';

import { browserTimeZone } from './cadence.ts';
import { cadenceText } from './schedule-cadence-text.ts';

/** Monday, Nov 2, 2026, 10:46 in the viewer's zone, whatever it is. */
const NOW = Date.parse('2026-11-02T16:46:00.000Z');

describe('cadenceText', () => {
  test('a schedule in the viewer’s own zone reads one time, with no second reading', () => {
    const zone = browserTimeZone();
    const daily = cadenceText({ cronExpression: '0 8 * * *', timeZone: zone }, NOW);
    expect(daily.full).toMatch(/^Every day at \d{1,2}:00 (AM|PM)$/);
    expect(daily.phone).toMatch(/^every day at \d{1,2}:00 (AM|PM)$/);
  });

  test('a schedule in another zone says its own reading in parentheses, and a phone leaves it out', () => {
    const text = cadenceText({ cronExpression: '0 9 * * *', timeZone: 'Pacific/Kiritimati' }, NOW);
    expect(text.full).toMatch(/^Every day at \d{1,2}:00 (AM|PM) \(9:00 AM GMT\+14\)$/);
    expect(text.phone).toMatch(/^every day at \d{1,2}:00 (AM|PM)$/);
  });

  test('one weekday names the viewer’s own weekday, and a phone pluralises it', () => {
    const zone = browserTimeZone();
    const weekly = cadenceText({ cronExpression: '0 11 * * 1', timeZone: zone }, NOW);
    expect(weekly.full).toMatch(/^Every Monday at \d{1,2}:00 (AM|PM)$/);
    expect(weekly.phone).toMatch(/^Mondays at \d{1,2}:00 (AM|PM)$/);
    // A schedule defined in a workflow file says it as the file does (row 10x).
    expect(weekly.file).toMatch(/^every Monday at \d{1,2}:00 (AM|PM)$/);
    expect(cadenceText({ cronExpression: '0 9 * * *', timeZone: zone }, NOW).file).toMatch(
      /^every day at \d{1,2}:00 (AM|PM)$/,
    );
  });

  test('weekdays and a day of the month have their own sentences', () => {
    const zone = browserTimeZone();
    expect(cadenceText({ cronExpression: '0 9 * * 1-5', timeZone: zone }, NOW).full).toMatch(
      /^Weekdays at \d{1,2}:00 (AM|PM)$/,
    );
    expect(cadenceText({ cronExpression: '30 6 15 * *', timeZone: zone }, NOW).full).toMatch(
      /^Monthly on day 15 at \d{1,2}:30 (AM|PM)$/,
    );
  });

  test('a cadence with no single time of day is said in words, with no clock to read', () => {
    expect(cadenceText({ intervalMs: 5 * 60_000 }, NOW)).toEqual({
      file: 'every 5 minutes',
      full: 'Every 5 minutes',
      phone: 'every 5 minutes',
    });
    expect(cadenceText({ cronExpression: '*/15 * * * *', timeZone: 'UTC' }, NOW).full).toBe(
      'Every 15 minutes',
    );
    expect(cadenceText({ cronExpression: '0 9 1-7 * 1', timeZone: 'UTC' }, NOW).full).toBe(
      'Cron · 0 9 1-7 * 1',
    );
  });

  test('an expression that cannot be read is said as it is', () => {
    expect(cadenceText({ cronExpression: '0 9 * * * *', timeZone: 'UTC' }, NOW).full).toBe(
      'Cron · 0 9 * * * *',
    );
  });
});

describe('cadenceText for an expression that cannot be read', () => {
  test('says the expression as it is, with no clock time', () => {
    const text = cadenceText({ cronExpression: 'not a cron', timeZone: 'UTC' }, NOW);
    expect(text.full).not.toMatch(/\d{1,2}:\d{2} (AM|PM)/);
  });
});
