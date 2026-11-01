/**
 * The runs the page lists, proved against the engine's own state rather than a second calculation:
 * a schedule is made in a real engine on a clock the test moves, the engine is asked to skip, and
 * the list must name the run the engine skipped and no time it does not fire at.
 */
import { describe, expect, test } from 'bun:test';

import { HttpClient } from '@lostgradient/weft';

import { startLiveSourceTestServer } from '../../lib/live-source/live-source-test-server.test-support.ts';
import { upcomingFires } from './schedule-time.ts';

const iso = (at: number | undefined): string | undefined =>
  at === undefined ? undefined : new Date(at).toISOString();

describe('the next runs against the engine', () => {
  test('a due run that waits out its jitter is the one the engine skips, and the list names it', async () => {
    // 09:00 UTC today has passed on the page's clock, but the run has not started: its jitter holds
    // it. The engine keeps `nextFireAt` at the nominal time and a skip takes that run, not tomorrow's.
    let clock = Date.UTC(2026, 10, 2, 12, 0, 0);
    const server = await startLiveSourceTestServer({ getNow: () => clock });
    try {
      await server.engine.schedule({
        workflow: 'inventory-sync-sweep',
        id: 'jittered',
        cron: '0 9 * * *',
        timeZone: 'UTC',
        jitter: '1h',
        input: { warehouseId: 'wh-main' },
      });
      const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
      const due = Date.UTC(2026, 10, 3, 9, 0, 0);
      clock = due + 1;

      const before = await client.getSchedule('jittered');
      expect(before?.nextFireAt).toBe(due);
      await server.engine.skipNextScheduleOccurrence('jittered');
      const after = await client.getSchedule('jittered');
      expect(after?.skipUntil).toBe(due);
      if (!after) throw new Error('The schedule is gone.');

      const fires = upcomingFires(after, 3, clock);
      expect(fires.map((fire) => iso(fire.at))).toEqual([
        '2026-11-03T09:00:00.000Z',
        '2026-11-04T09:00:00.000Z',
        '2026-11-05T09:00:00.000Z',
      ]);
      expect(fires.map((fire) => fire.skipped)).toEqual([true, false, false]);
    } finally {
      await server.stop();
    }
  });

  test('a time inside a daylight-saving gap is not listed, and the skipped run is the one the engine skipped', async () => {
    // 02:30 on 2027-03-14 does not exist in New York. The engine ticks at the end of the gap and
    // fires nothing, so the next run is the 15th; a reader that shifts the time forward would
    // offer 03:30 on the 14th.
    const clock = Date.UTC(2027, 2, 14, 5, 0, 0);
    const server = await startLiveSourceTestServer({ getNow: () => clock });
    try {
      await server.engine.schedule({
        workflow: 'inventory-sync-sweep',
        id: 'gap',
        cron: '30 2 * * *',
        timeZone: 'America/New_York',
        input: { warehouseId: 'wh-main' },
      });
      const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
      await server.engine.skipNextScheduleOccurrence('gap');
      const schedule = await client.getSchedule('gap');
      if (!schedule) throw new Error('The schedule is gone.');
      expect(iso(schedule.skipUntil)).toBe('2027-03-15T06:30:00.000Z');

      const fires = upcomingFires(schedule, 3, clock);
      expect(fires.map((fire) => iso(fire.at))).toEqual([
        '2027-03-15T06:30:00.000Z',
        '2027-03-16T06:30:00.000Z',
        '2027-03-17T06:30:00.000Z',
      ]);
      expect(fires.map((fire) => fire.skipped)).toEqual([true, false, false]);
      expect(fires.some((fire) => iso(fire.at) === '2027-03-14T07:30:00.000Z')).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test('lists the run the engine will start next, whatever the page’s clock says', async () => {
    const clock = Date.UTC(2026, 10, 2, 12, 0, 0);
    const server = await startLiveSourceTestServer({ getNow: () => clock });
    try {
      await server.engine.schedule({
        workflow: 'inventory-sync-sweep',
        id: 'steady',
        cron: '0 9 * * *',
        timeZone: 'UTC',
        input: { warehouseId: 'wh-main' },
      });
      const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
      const schedule = await client.getSchedule('steady');
      if (!schedule) throw new Error('The schedule is gone.');
      // A page whose clock is a week ahead of the engine still starts the list at `nextFireAt`.
      const [first] = upcomingFires(schedule, 2, clock + 7 * 86_400_000);
      expect(first?.at).toBe(schedule.nextFireAt ?? -1);
    } finally {
      await server.stop();
    }
  });
});
