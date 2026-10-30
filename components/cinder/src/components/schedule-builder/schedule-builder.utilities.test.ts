import { afterEach, describe, expect, test } from 'bun:test';

import type { ScheduleRepeats } from './schedule-builder.types.ts';
import {
  CRON_FIELDS,
  INTERVAL_UNITS,
  REPEATS_OPTIONS,
  WEEKDAYS,
  availableTimeZones,
  browserTimeZone,
  cronFieldsValid,
  cronForDraft,
  defaultScheduleValue,
  describeSchedule,
  draftFromValue,
  formatClockTime,
  joinCron,
  parseTime,
  splitCron,
  timeZoneDisplayName,
  validateCronField,
  valueFromDraft,
} from './schedule-builder.utilities.ts';

const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
const originalSupportedValuesOf = Intl.supportedValuesOf;

describe('schedule-builder utilities', () => {
  describe('constants', () => {
    test('INTERVAL_UNITS lists minutes and hours, the units an interval counts in', () => {
      expect(INTERVAL_UNITS).toEqual(['minutes', 'hours']);
    });

    test('REPEATS_OPTIONS lists the settled choices in order', () => {
      expect(REPEATS_OPTIONS.map((option) => option.value)).toEqual([
        'daily',
        'weekdays',
        'weekends',
        'custom-days',
        'monthly',
        'interval',
        'cron',
      ]);
    });

    test('WEEKDAYS has seven entries with cron day-of-week values 0-6', () => {
      expect(WEEKDAYS).toHaveLength(7);
      const values = WEEKDAYS.map((day) => day.value).toSorted((a, b) => a - b);
      expect(values).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    test('CRON_FIELDS has five fields with names, ranges, and hints', () => {
      expect(CRON_FIELDS).toHaveLength(5);
      expect(CRON_FIELDS.map((field) => field.name)).toEqual([
        'Minute',
        'Hour',
        'Day of month',
        'Month',
        'Day of week',
      ]);
    });
  });

  describe('defaultScheduleValue', () => {
    test('returns every day at 9:00 AM in the given zone', () => {
      expect(defaultScheduleValue('Europe/London')).toEqual({
        cron: '0 9 * * *',
        timeZone: 'Europe/London',
      });
    });

    test('defaults to the browser zone, which the test script pins to UTC', () => {
      expect(defaultScheduleValue()).toEqual({ cron: '0 9 * * *', timeZone: 'UTC' });
    });
  });

  describe('validateCronField', () => {
    test('accepts a wildcard', () => {
      expect(validateCronField('*', 0)).toBeUndefined();
    });

    test('accepts a step against the wildcard', () => {
      expect(validateCronField('*/15', 0)).toBeUndefined();
    });

    test('accepts a step against a range', () => {
      expect(validateCronField('1-10/2', 0)).toBeUndefined();
    });

    test('rejects a non-positive step', () => {
      expect(validateCronField('*/0', 0)).toBe('Step must be a positive integer.');
    });

    test('rejects a non-integer step', () => {
      expect(validateCronField('*/1.5', 0)).toBe('Not a valid cron token.');
    });

    test('rejects a step whose range is out of bounds', () => {
      expect(validateCronField('50-70/2', 0)).toBe('Out of range (0–59).');
    });

    test('rejects a step whose range start is after its end, with the same message as a plain range', () => {
      expect(validateCronField('10-5/2', 0)).toBe('Range start is after its end.');
    });

    test('rejects a step larger than the field maximum', () => {
      expect(validateCronField('*/100', 0)).toBe('Step is larger than 0–59.');
      // A step within the field range is still accepted.
      expect(validateCronField('*/30', 0)).toBeUndefined();
    });

    test('accepts a plain range', () => {
      expect(validateCronField('1-5', 0)).toBeUndefined();
    });

    test('rejects a range that is out of bounds', () => {
      expect(validateCronField('1-99', 0)).toBe('Out of range (0–59).');
    });

    test('rejects a range whose start is after its end', () => {
      expect(validateCronField('10-5', 0)).toBe('Range start is after its end.');
    });

    test('accepts a plain in-range number', () => {
      expect(validateCronField('30', 0)).toBeUndefined();
    });

    test('rejects a plain out-of-range number', () => {
      expect(validateCronField('99', 0)).toBe('Out of range (0–59).');
    });

    test('accepts a comma-separated list where every part is valid', () => {
      expect(validateCronField('1,2,3', 0)).toBeUndefined();
    });

    test('rejects a comma-separated list with an empty item', () => {
      expect(validateCronField('1,,3', 0)).toBe('Empty list item.');
    });

    test('rejects a comma-separated list with one invalid part', () => {
      expect(validateCronField('1,99,3', 0)).toBe('Out of range (0–59).');
    });

    test('rejects an empty string', () => {
      expect(validateCronField('', 0)).toBe('Required.');
    });

    test('rejects a whitespace-only string', () => {
      expect(validateCronField('   ', 0)).toBe('Required.');
    });

    test('rejects junk text', () => {
      expect(validateCronField('nope', 0)).toBe('Not a valid cron token.');
    });

    test('rejects an unknown field index', () => {
      expect(validateCronField('5', 99)).toBe('Unknown field.');
    });

    test('trims surrounding whitespace before validating', () => {
      expect(validateCronField('  30  ', 0)).toBeUndefined();
    });

    describe('field ranges', () => {
      test('Minute (index 0) accepts 0-59 and rejects 60', () => {
        expect(validateCronField('59', 0)).toBeUndefined();
        expect(validateCronField('60', 0)).toBe('Out of range (0–59).');
      });

      test('Hour (index 1) accepts 0-23 and rejects 24', () => {
        expect(validateCronField('23', 1)).toBeUndefined();
        expect(validateCronField('24', 1)).toBe('Out of range (0–23).');
      });

      test('Day of month (index 2) accepts 1-31 and rejects 0 and 32', () => {
        expect(validateCronField('31', 2)).toBeUndefined();
        expect(validateCronField('0', 2)).toBe('Out of range (1–31).');
        expect(validateCronField('32', 2)).toBe('Out of range (1–31).');
      });

      test('Month (index 3) accepts 1-12 and rejects 0 and 13', () => {
        expect(validateCronField('12', 3)).toBeUndefined();
        expect(validateCronField('0', 3)).toBe('Out of range (1–12).');
        expect(validateCronField('13', 3)).toBe('Out of range (1–12).');
      });

      test('Day of week (index 4) accepts 0-6 and rejects 7', () => {
        expect(validateCronField('6', 4)).toBeUndefined();
        expect(validateCronField('7', 4)).toBe('Out of range (0–6 (Sun–Sat)).');
      });
    });
  });

  describe('cronFieldsValid', () => {
    test('returns true when all five fields are individually valid', () => {
      expect(cronFieldsValid(['*', '*', '*', '*', '*'])).toBe(true);
      expect(cronFieldsValid(['0', '9', '1', '1', '1'])).toBe(true);
    });

    test('returns false when any field is invalid', () => {
      expect(cronFieldsValid(['*', '99', '*', '*', '*'])).toBe(false);
    });

    test('returns false when there are not exactly five fields', () => {
      expect(cronFieldsValid(['*', '*', '*', '*'])).toBe(false);
      expect(cronFieldsValid(['*', '*', '*', '*', '*', '*'])).toBe(false);
      expect(cronFieldsValid([])).toBe(false);
    });
  });

  describe('joinCron / splitCron', () => {
    test('joinCron trims and space-joins five fields', () => {
      expect(joinCron([' 0 ', '9', '*', '*', '*'])).toBe('0 9 * * *');
    });

    test('splitCron parses a full five-field expression', () => {
      expect(splitCron('0 9 * * 1')).toEqual(['0', '9', '*', '*', '1']);
    });

    test('splitCron pads a short expression with wildcards', () => {
      expect(splitCron('0 9')).toEqual(['0', '9', '*', '*', '*']);
      expect(splitCron('')).toEqual(['*', '*', '*', '*', '*']);
    });

    test('splitCron collapses extra internal whitespace', () => {
      expect(splitCron('0    9   *  *   1')).toEqual(['0', '9', '*', '*', '1']);
    });

    test('splitCron and joinCron round-trip a normalized expression', () => {
      const expression = '15 3 1 * *';
      expect(joinCron(splitCron(expression))).toBe(expression);
    });

    test('splitCron preserves overflow fields in the last field instead of dropping them', () => {
      // A six-field (seconds-prefixed) cron must not silently truncate to five
      // valid fields — the overflow lands in the day-of-week field so per-field
      // validation flags the out-of-contract expression.
      expect(splitCron('0 0 9 * * 1')).toEqual(['0', '0', '9', '*', '* 1']);
    });
  });

  describe('parseTime', () => {
    test('parses a valid HH:MM string', () => {
      expect(parseTime('09:30')).toEqual({ hour: 9, minute: 30 });
    });

    test('parses a single-digit hour', () => {
      expect(parseTime('9:05')).toEqual({ hour: 9, minute: 5 });
    });

    test('clamps an hour above 23', () => {
      expect(parseTime('99:00')).toEqual({ hour: 23, minute: 0 });
    });

    test('clamps a minute above 59', () => {
      expect(parseTime('10:99')).toEqual({ hour: 10, minute: 59 });
    });

    test('defaults to 00:00 for an empty string', () => {
      expect(parseTime('')).toEqual({ hour: 0, minute: 0 });
    });

    test('defaults to 00:00 for a malformed string', () => {
      expect(parseTime('not-a-time')).toEqual({ hour: 0, minute: 0 });
    });

    test('trims surrounding whitespace', () => {
      expect(parseTime('  09:30  ')).toEqual({ hour: 9, minute: 30 });
    });
  });

  describe('repeats choices', () => {
    const at = { time: '09:00', days: [1, 3, 5], dayOfMonth: 1 };
    const cases: {
      repeats: Parameters<typeof cronForDraft>[0]['repeats'];
      cron: string;
      readBack: string;
    }[] = [
      { repeats: 'daily', cron: '0 9 * * *', readBack: 'Every day at 9:00 AM Pacific Time' },
      { repeats: 'weekdays', cron: '0 9 * * 1-5', readBack: 'Weekdays at 9:00 AM Pacific Time' },
      { repeats: 'weekends', cron: '0 9 * * 0,6', readBack: 'Weekends at 9:00 AM Pacific Time' },
      {
        repeats: 'custom-days',
        cron: '0 9 * * 1,3,5',
        readBack: 'Mondays, Wednesdays and Fridays at 9:00 AM Pacific Time',
      },
      {
        repeats: 'monthly',
        cron: '0 9 1 * *',
        readBack: 'Monthly on the 1st at 9:00 AM Pacific Time',
      },
    ];

    for (const expected of cases) {
      test(`${expected.repeats} lowers to ${expected.cron} and reads back as a sentence`, () => {
        const draft = { ...draftFromValue(defaultScheduleValue('UTC')), ...at };
        const value = valueFromDraft(
          { ...draft, repeats: expected.repeats },
          'America/Los_Angeles',
        );

        expect(value).toEqual({ cron: expected.cron, timeZone: 'America/Los_Angeles' });
        expect(describeSchedule(value)).toBe(expected.readBack);
        expect(draftFromValue(value).repeats).toBe(expected.repeats);
      });
    }

    test('an interval emits every, not a cron, and reads back without a zone', () => {
      const draft = {
        ...draftFromValue(defaultScheduleValue('UTC')),
        repeats: 'interval' as const,
        intervalCount: 7,
        intervalUnit: 'hours' as const,
      };
      const value = valueFromDraft(draft, 'America/Los_Angeles');

      expect(value).toEqual({
        every: { unit: 'hours', count: 7 },
        timeZone: 'America/Los_Angeles',
      });
      expect(describeSchedule(value)).toBe('Every 7 hours');
      expect(describeSchedule({ every: { unit: 'minutes', count: 1 }, timeZone: 'UTC' })).toBe(
        'Every minute',
      );
    });

    test('custom cron emits its own expression', () => {
      const draft = { ...draftFromValue(defaultScheduleValue('UTC')), repeats: 'cron' as const };
      expect(valueFromDraft({ ...draft, cron: '0 */6 * * *' }, 'UTC')).toEqual({
        cron: '0 */6 * * *',
        timeZone: 'UTC',
      });
    });

    test('custom days sorts and de-duplicates the days it lowers', () => {
      const draft = draftFromValue(defaultScheduleValue('UTC'));
      expect(cronForDraft({ ...draft, repeats: 'custom-days', days: [5, 1, 3, 1] })).toBe(
        '0 9 * * 1,3,5',
      );
    });

    test('monthly clamps the day of month to 1 to 31', () => {
      const draft = { ...draftFromValue(defaultScheduleValue('UTC')), repeats: 'monthly' as const };
      expect(cronForDraft({ ...draft, dayOfMonth: 40 })).toBe('0 9 31 * *');
      expect(cronForDraft({ ...draft, dayOfMonth: 0 })).toBe('0 9 1 * *');
    });
  });

  describe('draftFromValue', () => {
    test('a custom cron that matches a choice reopens as that choice', () => {
      const cases: [string, ScheduleRepeats][] = [
        ['0 9 * * *', 'daily'],
        ['0 9 * * 0-6', 'daily'],
        ['0 9 * * 1-5', 'weekdays'],
        ['0 9 * * 1,2,3,4,5', 'weekdays'],
        ['0 9 * * 0,6', 'weekends'],
        ['0 9 * * 6,0', 'weekends'],
        ['30 14 * * 2,4', 'custom-days'],
        ['30 14 * * 1-3,5', 'custom-days'],
        ['0 8 15 * *', 'monthly'],
      ];
      for (const [cron, repeats] of cases) {
        expect(draftFromValue({ cron, timeZone: 'UTC' }).repeats).toBe(repeats);
      }
    });

    test('a cron no choice produces stays custom cron, with its expression', () => {
      for (const cron of [
        '0 */6 * * *',
        '*/15 * * * *',
        '0 9 1 * 1',
        '0 9 * 1 *',
        '0,30 9 * * *',
        '0 9 * * 7',
        '0 9 * * 5-1',
        '0 9 */2 * *',
        'not a cron',
      ]) {
        const draft = draftFromValue({ cron, timeZone: 'UTC' });
        expect(draft.repeats).toBe('cron');
        expect(draft.cron).toBe(joinCron(splitCron(cron)));
      }
    });

    test('reads the time, days, and day of month from the cron', () => {
      expect(draftFromValue({ cron: '30 14 * * 2,4', timeZone: 'UTC' })).toMatchObject({
        time: '14:30',
        days: [2, 4],
      });
      expect(draftFromValue({ cron: '5 7 22 * *', timeZone: 'UTC' })).toMatchObject({
        time: '07:05',
        dayOfMonth: 22,
      });
    });

    test('an interval value reopens as the interval choice', () => {
      expect(
        draftFromValue({ every: { unit: 'minutes', count: 45 }, timeZone: 'UTC' }),
      ).toMatchObject({ repeats: 'interval', intervalCount: 45, intervalUnit: 'minutes' });
    });
  });

  describe('read-back', () => {
    test('formatClockTime reads a 24-hour time on a 12-hour clock', () => {
      expect(formatClockTime('00:00')).toBe('12:00 AM');
      expect(formatClockTime('09:05')).toBe('9:05 AM');
      expect(formatClockTime('12:30')).toBe('12:30 PM');
      expect(formatClockTime('23:59')).toBe('11:59 PM');
    });

    test('timeZoneDisplayName names a zone the way a person reads it', () => {
      expect(timeZoneDisplayName('America/Los_Angeles')).toBe('Pacific Time');
      expect(timeZoneDisplayName('UTC')).toBe('UTC');
      expect(timeZoneDisplayName('Not/AZone')).toBe('Not/AZone');
    });

    test('a single custom day and two custom days read naturally', () => {
      expect(describeSchedule({ cron: '0 9 * * 1', timeZone: 'UTC' })).toBe(
        'Mondays at 9:00 AM UTC',
      );
      expect(describeSchedule({ cron: '0 9 * * 0,1', timeZone: 'UTC' })).toBe(
        'Mondays and Sundays at 9:00 AM UTC',
      );
    });

    test('monthly ordinals cover the teens and the twenties', () => {
      const ordinals = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(
        (day) => describeSchedule({ cron: `0 9 ${day} * *`, timeZone: 'UTC' }).split(' ')[3],
      );
      expect(ordinals).toEqual([
        '1st',
        '2nd',
        '3rd',
        '4th',
        '11th',
        '12th',
        '13th',
        '21st',
        '22nd',
        '23rd',
        '31st',
      ]);
    });

    test('a cron no choice produces reads back as the expression in its zone', () => {
      expect(describeSchedule({ cron: '0 */6 * * *', timeZone: 'America/Los_Angeles' })).toBe(
        'Cron 0 */6 * * * in Pacific Time',
      );
    });
  });

  describe('availableTimeZones', () => {
    test('lists IANA zones with UTC among them', () => {
      const zones = availableTimeZones();
      expect(zones).toContain('UTC');
      expect(zones).toContain('America/Los_Angeles');
    });
  });

  describe('cronForDraft', () => {
    const base = draftFromValue(defaultScheduleValue('UTC'));

    test('an interval or custom-cron draft keeps the draft cron as written', () => {
      expect(cronForDraft({ ...base, repeats: 'interval', cron: '*/15 * * * *' })).toBe(
        '*/15 * * * *',
      );
      expect(cronForDraft({ ...base, repeats: 'cron', cron: '5 4 * * 2' })).toBe('5 4 * * 2');
    });
  });

  describe('time zone fallbacks', () => {
    afterEach(() => {
      Intl.DateTimeFormat.prototype.resolvedOptions = originalResolvedOptions;
      Intl.supportedValuesOf = originalSupportedValuesOf;
    });

    test('browserTimeZone falls back to UTC when the runtime throws', () => {
      Intl.DateTimeFormat.prototype.resolvedOptions = () => {
        throw new Error('no Intl');
      };
      expect(browserTimeZone()).toBe('UTC');
    });

    test('browserTimeZone returns the runtime zone when it reports one', () => {
      expect(browserTimeZone()).toBe(
        originalResolvedOptions.call(new Intl.DateTimeFormat()).timeZone,
      );
    });

    test('availableTimeZones is just UTC when the runtime cannot list zones', () => {
      Intl.supportedValuesOf = () => {
        throw new Error('unsupported');
      };
      expect(availableTimeZones()).toEqual(['UTC']);
    });

    test('availableTimeZones prepends UTC when the runtime list omits it', () => {
      Intl.supportedValuesOf = () => ['America/Los_Angeles'];
      expect(availableTimeZones()).toEqual(['UTC', 'America/Los_Angeles']);
    });
  });
});
