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

  test('mark the run a person asked to skip, and only that one and any before it', () => {
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
