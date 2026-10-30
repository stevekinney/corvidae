/**
 * Coverage for `computeNextFires` (split out of `./index.test.ts` alongside
 * `./cron-preview.ts` — see that module's doc for why). Runs under
 * `TZ=UTC` (`package.json`'s `test` script). Each value names its own zone,
 * which cron-parser reads the expression in; most fixtures below use `UTC`.
 */
import { describe, expect, test } from 'bun:test';

import { computeNextFires } from './cron-preview.ts';

describe('computeNextFires', () => {
  test('interval mode: every N minutes, evenly spaced from `from`', () => {
    const from = new Date('2026-07-20T10:05:00.000Z');
    const fires = computeNextFires(
      { every: { unit: 'minutes', count: 15 }, timeZone: 'UTC' },
      3,
      from,
    );

    expect(fires.map((fire) => fire.id)).toEqual([
      '2026-07-20T10:20:00.000Z',
      '2026-07-20T10:35:00.000Z',
      '2026-07-20T10:50:00.000Z',
    ]);
    expect(fires.every((fire) => fire.label.length > 0)).toBe(true);
  });

  test('interval mode: every N hours scales the step, so every 7 hours is exact', () => {
    const from = new Date('2026-07-20T00:00:00.000Z');
    const fires = computeNextFires(
      { every: { unit: 'hours', count: 7 }, timeZone: 'UTC' },
      4,
      from,
    );
    expect(fires.map((fire) => fire.id)).toEqual([
      '2026-07-20T07:00:00.000Z',
      '2026-07-20T14:00:00.000Z',
      '2026-07-20T21:00:00.000Z',
      '2026-07-21T04:00:00.000Z',
    ]);
  });

  test('cron mode: reads the expression in the value time zone and labels fires there', () => {
    // 2026-07-20 is a Monday; 9:00 AM Pacific Daylight Time is 16:00 UTC.
    const from = new Date('2026-07-20T00:00:00.000Z');
    const fires = computeNextFires(
      { cron: '0 9 * * 1-5', timeZone: 'America/Los_Angeles' },
      2,
      from,
    );

    expect(fires.map((fire) => fire.id)).toEqual([
      '2026-07-20T16:00:00.000Z',
      '2026-07-21T16:00:00.000Z',
    ]);
    expect(fires[0]?.label).toContain('09:00');
  });

  test('cron mode: daily at a fixed time', () => {
    const from = new Date('2026-07-20T10:00:00.000Z');
    const fires = computeNextFires({ cron: '0 9 * * *', timeZone: 'UTC' }, 3, from);

    expect(fires.map((fire) => fire.id)).toEqual([
      '2026-07-21T09:00:00.000Z',
      '2026-07-22T09:00:00.000Z',
      '2026-07-23T09:00:00.000Z',
    ]);
  });

  test('cron mode: step syntax ("*/15")', () => {
    const from = new Date('2026-07-20T10:05:00.000Z');
    const fires = computeNextFires({ cron: '*/15 * * * *', timeZone: 'UTC' }, 3, from);

    expect(fires.map((fire) => fire.id)).toEqual([
      '2026-07-20T10:15:00.000Z',
      '2026-07-20T10:30:00.000Z',
      '2026-07-20T10:45:00.000Z',
    ]);
  });

  test('cron mode: day-of-week names and a range (MON-FRI) skip the weekend', () => {
    // 2026-07-17 is a Friday.
    const from = new Date('2026-07-17T00:00:00.000Z');
    const fires = computeNextFires({ cron: '0 9 * * MON-FRI', timeZone: 'UTC' }, 5, from);

    expect(fires.map((fire) => fire.id)).toEqual([
      '2026-07-17T09:00:00.000Z', // Fri (later the same day as `from`)
      '2026-07-20T09:00:00.000Z', // Mon — 07-18/07-19 (Sat/Sun) skipped
      '2026-07-21T09:00:00.000Z',
      '2026-07-22T09:00:00.000Z',
      '2026-07-23T09:00:00.000Z',
    ]);
  });

  test('cron mode: POSIX OR semantics when both day-of-month and day-of-week are restricted', () => {
    const from = new Date('2026-07-01T00:00:00.000Z');
    const fires = computeNextFires({ cron: '0 0 1,15 * MON', timeZone: 'UTC' }, 5, from);

    // 2026-07-15 is a Wednesday — it fires because day-of-month (1,15) OR
    // day-of-week (MON) matches, not because both do.
    expect(fires.map((fire) => fire.id)).toEqual([
      '2026-07-06T00:00:00.000Z',
      '2026-07-13T00:00:00.000Z',
      '2026-07-15T00:00:00.000Z',
      '2026-07-20T00:00:00.000Z',
      '2026-07-27T00:00:00.000Z',
    ]);
  });

  test('cron mode: an out-of-range field throws', () => {
    expect(() =>
      computeNextFires({ cron: '99 * * * *', timeZone: 'UTC' }, 1, new Date()),
    ).toThrow();
  });

  test('cron mode: an unresolvable alias throws', () => {
    expect(() =>
      computeNextFires({ cron: '0 9 * * XYZ', timeZone: 'UTC' }, 1, new Date()),
    ).toThrow();
  });

  test('cron mode: too many fields throws', () => {
    expect(() =>
      computeNextFires({ cron: '* * * * * * *', timeZone: 'UTC' }, 1, new Date()),
    ).toThrow();
  });

  test('count 0 returns an empty list for both modes', () => {
    const from = new Date('2026-07-20T00:00:00.000Z');
    expect(
      computeNextFires({ every: { unit: 'minutes', count: 5 }, timeZone: 'UTC' }, 0, from),
    ).toEqual([]);
    expect(computeNextFires({ cron: '0 9 * * *', timeZone: 'UTC' }, 0, from)).toEqual([]);
  });

  test('`from` defaults to the current time when omitted', () => {
    const before = Date.now();
    const [fire] = computeNextFires({ every: { unit: 'minutes', count: 1 }, timeZone: 'UTC' }, 1);
    const after = Date.now();

    expect(fire).toBeDefined();
    const fireTime = Date.parse(fire!.id);
    expect(fireTime).toBeGreaterThan(before);
    expect(fireTime).toBeLessThanOrEqual(after + 60_000);
  });
});
