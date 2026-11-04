/**
 * COR-2009 — the host's nightly clean-up: 3:00 AM in its time zone across a daylight-saving change,
 * a night the host was off for reported as skipped and not made up, the last clean-up kept in
 * storage, and "Clean up now" reporting what it removed. The clock is injected; the one timer test
 * waits on the state the timer changes, never on wall time.
 */
import type { ExpiredRecordRemoval } from '@lostgradient/bureau';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  CLEAN_UP_RECORD_KEY,
  cleanUpTimeAfter,
  cleanUpTimeAtOrBefore,
  type HostCleanUpRun,
  type NightlyCleanUp,
  skippedCleanUpTime,
  startNightlyCleanUp,
} from './nightly-clean-up.ts';

const CENTRAL = 'America/Chicago';
/** The sample world's now: Mon Nov 2, 2026, 10:46 AM Central (standard time, UTC-6). */
const SAMPLE_NOW = Date.parse('2026-11-02T16:46:00.000Z');
/** The sample world's start: 9:00 AM Central the same day. */
const SAMPLE_START = Date.parse('2026-11-02T15:00:00.000Z');

const removal = (removed: number): ExpiredRecordRemoval => ({
  removed,
  byKind: {
    audit: removed,
    reviews: 0,
    memories: 0,
    logs: 0,
    notifications: 0,
    hookDeliveries: 0,
  },
  failed: [],
});

const lastAt = (at: string): HostCleanUpRun => ({
  at,
  trigger: 'nightly',
  removed: 0,
  byKind: removal(0).byKind,
  failed: [],
});

const running: NightlyCleanUp[] = [];

afterEach(async () => {
  for (const cleanUp of running.splice(0)) await cleanUp.close();
});

function start(options: Partial<Parameters<typeof startNightlyCleanUp>[0]> = {}) {
  const warnings: string[] = [];
  const cleanUp = startNightlyCleanUp({
    storage: new MemoryStorage(),
    removeExpiredRecords: async () => removal(31),
    timeZone: CENTRAL,
    now: () => SAMPLE_NOW,
    warn: (message) => warnings.push(message),
    ...options,
  });
  running.push(cleanUp);
  return { cleanUp, warnings };
}

describe('the nightly clean-up time', () => {
  test('is 3:00 AM Central on either side of the end of daylight saving time', () => {
    // Sun Nov 1, 2026 ends daylight saving time at 2:00 AM, so its 3:00 AM is already standard time.
    expect(new Date(cleanUpTimeAtOrBefore(SAMPLE_NOW, CENTRAL)).toISOString()).toBe(
      '2026-11-02T09:00:00.000Z',
    );
    expect(
      new Date(
        cleanUpTimeAtOrBefore(Date.parse('2026-11-02T08:00:00.000Z'), CENTRAL),
      ).toISOString(),
    ).toBe('2026-11-01T09:00:00.000Z');
    expect(
      new Date(
        cleanUpTimeAtOrBefore(Date.parse('2026-10-31T12:00:00.000Z'), CENTRAL),
      ).toISOString(),
    ).toBe('2026-10-31T08:00:00.000Z');
    expect(new Date(cleanUpTimeAfter(SAMPLE_NOW, CENTRAL)).toISOString()).toBe(
      '2026-11-03T09:00:00.000Z',
    );
  });

  test('is 3:00 AM daylight time on the day daylight saving time starts', () => {
    // Sun Mar 8, 2026 skips 2:00 to 3:00 AM; 3:00 AM exists, in daylight time (UTC-5).
    expect(
      new Date(cleanUpTimeAfter(Date.parse('2026-03-08T06:00:00.000Z'), CENTRAL)).toISOString(),
    ).toBe('2026-03-08T08:00:00.000Z');
  });

  test('crosses a month and a year boundary', () => {
    expect(
      new Date(cleanUpTimeAfter(Date.parse('2026-12-31T12:00:00.000Z'), 'UTC')).toISOString(),
    ).toBe('2027-01-01T03:00:00.000Z');
    expect(
      new Date(cleanUpTimeAtOrBefore(Date.parse('2027-01-01T01:00:00.000Z'), 'UTC')).toISOString(),
    ).toBe('2026-12-31T03:00:00.000Z');
  });
});

describe('a skipped night', () => {
  test('is the night the host was off for, with no clean-up since', () => {
    expect(
      skippedCleanUpTime(lastAt('2026-11-01T09:00:00.000Z'), SAMPLE_START, SAMPLE_NOW, CENTRAL),
    ).toBe(Date.parse('2026-11-02T09:00:00.000Z'));
  });

  test('is none while the host was running at 3:00 AM, after a clean-up since, or before the first', () => {
    const startedBefore = Date.parse('2026-11-02T08:00:00.000Z');
    expect(
      skippedCleanUpTime(lastAt('2026-11-01T09:00:00.000Z'), startedBefore, SAMPLE_NOW, CENTRAL),
    ).toBeNull();
    expect(
      skippedCleanUpTime(lastAt('2026-11-02T16:00:00.000Z'), SAMPLE_START, SAMPLE_NOW, CENTRAL),
    ).toBeNull();
    expect(skippedCleanUpTime(null, SAMPLE_START, SAMPLE_NOW, CENTRAL)).toBeNull();
  });
});

describe('startNightlyCleanUp', () => {
  test('reports the sample world: last cleaned up Sun Nov 1, 3:00 AM, and skipped today', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      CLEAN_UP_RECORD_KEY,
      new TextEncoder().encode(
        JSON.stringify({ schemaVersion: 1, last: lastAt('2026-11-01T09:00:00.000Z') }),
      ),
    );
    const { cleanUp } = start({
      storage,
      now: (() => {
        let first = true;
        return () => {
          if (!first) return SAMPLE_NOW;
          first = false;
          return SAMPLE_START;
        };
      })(),
    });

    expect(await cleanUp.standing()).toEqual({
      schedule: { hour: 3, minute: 0, timeZone: CENTRAL },
      last: lastAt('2026-11-01T09:00:00.000Z'),
      skipped: { at: '2026-11-02T09:00:00.000Z' },
      nextAt: '2026-11-03T09:00:00.000Z',
    });
  });

  test('cleans up now, reports what it removed, keeps it across a restart, and clears the skip', async () => {
    const storage = new MemoryStorage();
    const { cleanUp } = start({ storage });

    const run = await cleanUp.cleanUpNow();

    expect(run).toEqual({
      at: new Date(SAMPLE_NOW).toISOString(),
      trigger: 'manual',
      removed: 31,
      byKind: removal(31).byKind,
      failed: [],
    });
    const { cleanUp: restarted } = start({ storage });
    expect(await restarted.standing()).toMatchObject({ last: run, skipped: null });
  });

  test('joins a clean-up already running instead of starting another', async () => {
    let calls = 0;
    let finish: (value: ExpiredRecordRemoval) => void = () => undefined;
    const { cleanUp } = start({
      removeExpiredRecords: () => {
        calls += 1;
        return new Promise((resolve) => (finish = resolve));
      },
    });

    const first = cleanUp.cleanUpNow();
    const second = cleanUp.cleanUpNow();
    finish(removal(2));

    expect(await first).toEqual(await second);
    expect(calls).toBe(1);
  });

  test('runs at 3:00 AM and arms the next night', async () => {
    let clock = Date.parse('2026-11-03T08:59:59.999Z');
    const runs: number[] = [];
    const storage = new MemoryStorage();
    const { cleanUp } = start({
      storage,
      now: () => clock,
      removeExpiredRecords: async () => {
        runs.push(clock);
        clock = Date.parse('2026-11-03T09:00:01.000Z');
        return removal(4);
      },
    });

    await waitUntil(
      async () => {
        const standing = await cleanUp.standing();
        return standing.last !== null;
      },
      {
        message: 'the nightly clean-up to run',
      },
    );

    expect(runs).toHaveLength(1);
    expect(await cleanUp.standing()).toMatchObject({
      last: { trigger: 'nightly', removed: 4 },
      nextAt: '2026-11-04T09:00:00.000Z',
    });
  });

  test('reports an unreadable record as none, and says so', async () => {
    const storage = new MemoryStorage();
    await storage.put(CLEAN_UP_RECORD_KEY, new TextEncoder().encode('not json'));
    const { cleanUp, warnings } = start({ storage });

    const standing = await cleanUp.standing();
    expect(standing.last).toBeNull();
    expect(warnings).toEqual([
      `The last clean-up record (${CLEAN_UP_RECORD_KEY}) is unreadable, so none is reported.`,
    ]);
  });
});
