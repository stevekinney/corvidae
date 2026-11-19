/**
 * When a schedule runs, as the end of a run's Started by (COR-2424, row 55i): the timetable in the
 * viewer's time with the schedule's own zone in parentheses.
 */
import { describe, expect, test } from 'bun:test';

import { cadenceClauseOf } from './run-schedule-cadence.ts';

describe('the cadence a run’s Started by says', () => {
  const daily = {
    cronExpression: '0 9 * * *',
    intervalMs: null,
    timeZone: 'UTC',
    nextFireAt: '2026-11-03T09:00:00.000Z',
  };

  test('reads "every day at 3:00 AM (9:00 AM UTC)": the viewer’s time, then the schedule’s own', () => {
    expect(cadenceClauseOf(daily, 'America/Chicago')).toBe('every day at 3:00 AM (9:00 AM UTC)');
  });

  test('leaves the parentheses out when the viewer is in the schedule’s own zone', () => {
    expect(cadenceClauseOf(daily, 'UTC')).toBe('every day at 9:00 AM');
  });

  test('says an interval in the schedule’s own words, with no clock to convert', () => {
    expect(
      cadenceClauseOf(
        { cronExpression: null, intervalMs: 3_600_000, timeZone: 'UTC', nextFireAt: null },
        'America/Chicago',
      ),
    ).toBe('every hour');
  });
});
