import { describe, expect, test } from 'bun:test';

import {
  cadenceOf,
  cadenceTimeZone,
  cadenceToScheduleValue,
  describeCadence,
  describeCronExpression,
  describeIntervalMs,
  intervalMsToScheduleValue,
  scheduleValueTimeZone,
  scheduleValueToWireSpec,
  shownCadenceIsInvalid,
} from './cadence.ts';

describe('describeCronExpression', () => {
  test('every-N-minutes step', () => {
    expect(describeCronExpression('*/5 * * * *')).toBe('Every 5 minutes');
    expect(describeCronExpression('*/30 * * * *')).toBe('Every 30 minutes');
  });

  test('a 1-minute step reads "Every minute", not "Every 1 minutes"', () => {
    expect(describeCronExpression('*/1 * * * *')).toBe('Every minute');
  });

  test('every-N-hours step', () => {
    expect(describeCronExpression('0 */2 * * *')).toBe('Every 2 hours');
  });

  test('minute pinned to 0, hour wildcard reads "Every hour"', () => {
    expect(describeCronExpression('0 * * * *')).toBe('Every hour');
  });

  test('minute pinned to a non-zero value, hour wildcard', () => {
    expect(describeCronExpression('15 * * * *')).toBe('Every hour at :15');
  });

  test('daily at a fixed time', () => {
    expect(describeCronExpression('0 2 * * *')).toBe('Every day at 02:00');
    expect(describeCronExpression('0 3 * * *')).toBe('Every day at 03:00');
  });

  test('weekly on a numeric day-of-week', () => {
    expect(describeCronExpression('0 9 * * 1')).toBe('Mondays at 09:00');
    expect(describeCronExpression('0 9 * * 0')).toBe('Sundays at 09:00');
  });

  test('weekly on a named day-of-week alias', () => {
    expect(describeCronExpression('0 9 * * MON')).toBe('Mondays at 09:00');
    expect(describeCronExpression('30 17 * * fri')).toBe('Fridays at 17:30');
  });

  test('monthly on a fixed day-of-month', () => {
    expect(describeCronExpression('0 6 1 * *')).toBe('Monthly on day 1 at 06:00');
  });

  test('falls back to raw cron for shapes outside the bounded set', () => {
    expect(describeCronExpression('*/15 9-17 * * 1-5')).toBe('Cron · */15 9-17 * * 1-5');
  });

  test('falls back to raw cron for a malformed (wrong field count) expression', () => {
    expect(describeCronExpression('* * *')).toBe('Cron · * * *');
  });
});

describe('describeIntervalMs', () => {
  test('reduces to the largest evenly-dividing unit', () => {
    expect(describeIntervalMs(60_000)).toBe('Every minute');
    expect(describeIntervalMs(5 * 60_000)).toBe('Every 5 minutes');
    expect(describeIntervalMs(3_600_000)).toBe('Every hour');
    expect(describeIntervalMs(2 * 3_600_000)).toBe('Every 2 hours');
    expect(describeIntervalMs(86_400_000)).toBe('Every day');
    expect(describeIntervalMs(7 * 86_400_000)).toBe('Every week');
  });

  test('falls back to milliseconds for a non-dividing value', () => {
    expect(describeIntervalMs(1_500)).toBe('Every 1500ms');
  });
});

describe('describeCadence', () => {
  test('prefers intervalMs over cronExpression when both are somehow present', () => {
    expect(describeCadence({ intervalMs: 60_000, cronExpression: '0 * * * *' })).toBe(
      'Every minute',
    );
  });

  test('falls back to cronExpression when intervalMs is absent', () => {
    expect(describeCadence({ cronExpression: '0 2 * * *' })).toBe('Every day at 02:00');
  });

  test('reports "Unknown cadence" when neither field is present', () => {
    expect(describeCadence({})).toBe('Unknown cadence');
  });
});

describe('scheduleValueToWireSpec', () => {
  test('a cron value passes the expression through as `cron`', () => {
    expect(scheduleValueToWireSpec({ cron: '0 2 * * *', timeZone: 'America/Los_Angeles' })).toEqual(
      { cron: '0 2 * * *' },
    );
  });

  test('an interval resolves to milliseconds counted from the start', () => {
    expect(
      scheduleValueToWireSpec({ every: { unit: 'minutes', count: 15 }, timeZone: 'UTC' }),
    ).toEqual({ every: 900_000 });
    expect(
      scheduleValueToWireSpec({ every: { unit: 'hours', count: 7 }, timeZone: 'UTC' }),
    ).toEqual({
      every: 25_200_000,
    });
  });
});

describe('scheduleValueTimeZone and cadenceTimeZone', () => {
  test('a cron carries its zone and an interval carries none', () => {
    expect(scheduleValueTimeZone({ cron: '0 9 * * *', timeZone: 'Europe/London' })).toBe(
      'Europe/London',
    );
    expect(
      scheduleValueTimeZone({ every: { unit: 'hours', count: 1 }, timeZone: 'Europe/London' }),
    ).toBeUndefined();
    expect(cadenceTimeZone({ cronExpression: '0 9 * * *', timeZone: 'Asia/Tokyo' })).toBe(
      'Asia/Tokyo',
    );
    expect(cadenceTimeZone({ cronExpression: '0 9 * * *' })).toBe('UTC');
    expect(cadenceTimeZone({ intervalMs: 60_000, timeZone: 'UTC' })).toBeUndefined();
  });
});

describe('intervalMsToScheduleValue', () => {
  test('reduces to whole hours when they divide evenly, so days stay exact', () => {
    expect(intervalMsToScheduleValue(604_800_000, 'UTC')).toEqual({
      every: { unit: 'hours', count: 168 },
      timeZone: 'UTC',
    });
    expect(intervalMsToScheduleValue(86_400_000, 'UTC')).toEqual({
      every: { unit: 'hours', count: 24 },
      timeZone: 'UTC',
    });
    expect(intervalMsToScheduleValue(7_200_000, 'UTC')).toEqual({
      every: { unit: 'hours', count: 2 },
      timeZone: 'UTC',
    });
    expect(intervalMsToScheduleValue(300_000, 'UTC')).toEqual({
      every: { unit: 'minutes', count: 5 },
      timeZone: 'UTC',
    });
  });

  test('falls back to a rounded minute count for a non-dividing value', () => {
    expect(intervalMsToScheduleValue(90_000, 'UTC')).toEqual({
      every: { unit: 'minutes', count: 2 },
      timeZone: 'UTC',
    });
  });
});

describe('cadenceToScheduleValue', () => {
  test('rehydrates a cron cadence in its stored zone', () => {
    expect(
      cadenceToScheduleValue({ cronExpression: '0 2 * * *', timeZone: 'America/Los_Angeles' }),
    ).toEqual({ cron: '0 2 * * *', timeZone: 'America/Los_Angeles' });
  });

  test('reads a cadence stored without a zone as UTC', () => {
    expect(cadenceToScheduleValue({ cronExpression: '0 2 * * *' })).toEqual({
      cron: '0 2 * * *',
      timeZone: 'UTC',
    });
  });

  test('rehydrates an interval cadence', () => {
    expect(cadenceToScheduleValue({ intervalMs: 300_000, timeZone: 'UTC' })).toEqual({
      every: { unit: 'minutes', count: 5 },
      timeZone: 'UTC',
    });
  });

  test('defaults to every-15-minutes when neither field is present', () => {
    expect(cadenceToScheduleValue({})).toEqual({
      every: { unit: 'minutes', count: 15 },
      timeZone: 'UTC',
    });
  });
});

describe('cadenceOf', () => {
  test('copies the zone with the cadence', () => {
    expect(cadenceOf({ cronExpression: '0 9 * * *', timeZone: 'Europe/Paris' })).toEqual({
      cronExpression: '0 9 * * *',
      timeZone: 'Europe/Paris',
    });
  });
});

describe('shownCadenceIsInvalid', () => {
  function region(markup: string): HTMLElement {
    const element = document.createElement('div');
    element.innerHTML = markup;
    return element;
  }

  test('is true while a field the builder shows is out of range', () => {
    expect(shownCadenceIsInvalid(region('<input aria-invalid="true" />'))).toBe(true);
  });

  test('is false when every field is valid, and when there is no region yet', () => {
    expect(shownCadenceIsInvalid(region('<input aria-invalid="false" /><input />'))).toBe(false);
    expect(shownCadenceIsInvalid(undefined)).toBe(false);
  });
});
