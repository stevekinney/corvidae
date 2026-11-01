/**
 * When a schedule fires, in the zone it is read in: a cron's next runs are the expression read in
 * its zone, an interval's follow `nextFireAt`, and the run a person asked to skip is marked.
 */
import { describe, expect, test } from 'bun:test';

import {
  formatInZone,
  scheduleZone,
  sentenceZone,
  upcomingFires,
  zoneLabel,
} from './schedule-time.ts';

/** 2026-11-02 12:00 UTC, a Monday. */
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

describe('the zone a schedule is shown in', () => {
  test('is its own for a cron, UTC when it was made without one', () => {
    expect(scheduleZone({ cronExpression: '0 9 * * *', timeZone: 'America/Los_Angeles' })).toBe(
      'America/Los_Angeles',
    );
    expect(scheduleZone({ cronExpression: '0 9 * * *' })).toBe('UTC');
  });

  test('is the browser’s for an interval, which has none of its own', () => {
    expect(scheduleZone({})).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  test('is named in a sentence for a cron only', () => {
    expect(sentenceZone({ cronExpression: '0 9 * * *', timeZone: 'America/Los_Angeles' })).toBe(
      'America/Los Angeles',
    );
    expect(sentenceZone({})).toBeNull();
    expect(zoneLabel('Europe/Berlin')).toBe('Europe/Berlin');
  });
});

describe('formatting a moment in a zone', () => {
  test('shows the wall clock of that zone with its short name', () => {
    // 17:00 UTC is 09:00 in Los Angeles in November.
    const label = formatInZone(Date.UTC(2026, 10, 2, 17, 0), 'America/Los_Angeles');
    expect(label).toContain('9:00');
    expect(label).toMatch(/PST/);
  });

  test('falls back to UTC for a zone the browser does not know', () => {
    expect(formatInZone(Date.UTC(2026, 10, 2, 17, 0), 'Not/AZone')).toContain('UTC');
  });
});

describe('the next runs of a schedule', () => {
  test('are a cron read in its zone: 09:00 in Los Angeles is 17:00 UTC', () => {
    const fires = upcomingFires(
      { status: 'active', cronExpression: '0 9 * * *', timeZone: 'America/Los_Angeles' },
      3,
      NOW,
    );
    expect(fires.map((fire) => new Date(fire.at).toISOString())).toEqual([
      '2026-11-02T17:00:00.000Z',
      '2026-11-03T17:00:00.000Z',
      '2026-11-04T17:00:00.000Z',
    ]);
  });

  test('are an interval counted from the next fire', () => {
    const fires = upcomingFires(
      { status: 'active', intervalMs: 3_600_000, nextFireAt: NOW + 1_000 },
      3,
      NOW,
    );
    expect(fires.map((fire) => fire.at)).toEqual([NOW + 1_000, NOW + 3_601_000, NOW + 7_201_000]);
  });

  test('mark the run a person asked to skip', () => {
    const fires = upcomingFires(
      {
        status: 'active',
        cronExpression: '0 9 * * *',
        timeZone: 'UTC',
        skipUntil: Date.UTC(2026, 10, 3, 9, 0),
      },
      3,
      NOW,
    );
    expect(fires.map((fire) => fire.skipped)).toEqual([true, false, false]);
  });

  test('are none for a paused or cancelled schedule', () => {
    expect(upcomingFires({ status: 'paused', cronExpression: '0 9 * * *' }, 3, NOW)).toEqual([]);
    expect(upcomingFires({ status: 'cancelled', intervalMs: 1, nextFireAt: NOW }, 3, NOW)).toEqual(
      [],
    );
  });

  test('are none for an expression that cannot be read', () => {
    expect(upcomingFires({ status: 'active', cronExpression: 'not a cron' }, 3, NOW)).toEqual([]);
  });
});

describe('the next runs of a schedule that has fired since the page read it', () => {
  const NINE = Date.UTC(2026, 10, 3, 9, 0);

  test('start at the schedule’s nextFireAt, not at a time read from the clock', () => {
    // The page's clock is two days past the fire the schedule reports.
    const fires = upcomingFires(
      { status: 'active', cronExpression: '0 9 * * *', timeZone: 'UTC', nextFireAt: NINE },
      2,
      NINE + 2 * 86_400_000,
    );
    expect(fires.map((fire) => fire.at)).toEqual([NINE, NINE + 86_400_000]);
  });

  test('change when the schedule does: the run that fired is gone from the list', () => {
    const before = upcomingFires(
      { status: 'active', cronExpression: '0 9 * * *', timeZone: 'UTC', nextFireAt: NINE },
      2,
      NOW,
    );
    const after = upcomingFires(
      {
        status: 'active',
        cronExpression: '0 9 * * *',
        timeZone: 'UTC',
        nextFireAt: NINE + 86_400_000,
        lastFireAt: NINE,
      },
      2,
      NOW,
    );
    expect(before[0]?.at).toBe(NINE);
    expect(after.map((fire) => fire.at)).toEqual([NINE + 86_400_000, NINE + 2 * 86_400_000]);
  });

  test('mark only the run at skipUntil, never one that is before it', () => {
    const fires = upcomingFires(
      {
        status: 'active',
        cronExpression: '0 9 * * *',
        timeZone: 'UTC',
        nextFireAt: NINE,
        // A skip recorded for a later run: the earlier one still starts.
        skipUntil: NINE + 86_400_000,
      },
      3,
      NOW,
    );
    expect(fires.map((fire) => fire.skipped)).toEqual([false, true, false]);
  });

  test('list a due run whose fire time has passed, so a jittered run is offered, not tomorrow’s', () => {
    const fires = upcomingFires(
      { status: 'active', cronExpression: '0 9 * * *', timeZone: 'UTC', nextFireAt: NINE },
      2,
      NINE + 60_000,
    );
    expect(fires[0]?.at).toBe(NINE);
  });

  test('skip a daylight-saving gap: 02:30 in New York on 2027-03-14 does not exist', () => {
    const fires = upcomingFires(
      {
        status: 'active',
        cronExpression: '30 2 * * *',
        timeZone: 'America/New_York',
        // The tick at the end of the gap, where the engine fires nothing.
        nextFireAt: Date.UTC(2027, 2, 14, 7, 0),
      },
      2,
      NOW,
    );
    expect(fires.map((fire) => new Date(fire.at).toISOString())).toEqual([
      '2027-03-15T06:30:00.000Z',
      '2027-03-16T06:30:00.000Z',
    ]);
  });

  test('keep an hourly time that follows the gap: 03:00 fires', () => {
    const fires = upcomingFires(
      {
        status: 'active',
        cronExpression: '0 * * * *',
        timeZone: 'America/New_York',
        nextFireAt: Date.UTC(2027, 2, 14, 7, 0),
      },
      2,
      NOW,
    );
    expect(fires.map((fire) => new Date(fire.at).toISOString())).toEqual([
      '2027-03-14T07:00:00.000Z',
      '2027-03-14T08:00:00.000Z',
    ]);
  });

  test('count an interval on from the occurrence after lastFireAt while a backfill catches up', () => {
    const fires = upcomingFires(
      {
        status: 'active',
        intervalMs: 60_000,
        nextFireAt: NOW,
        lastFireAt: NOW + 120_000,
      },
      2,
      NOW,
    );
    expect(fires.map((fire) => fire.at)).toEqual([NOW + 180_000, NOW + 240_000]);
  });
});
