/** How the Clean-up row words the host's schedule, its last clean-up and a skipped night (rows 50h and 50j). */
import { describe, expect, test } from 'bun:test';

import type { HostCleanUpRun, HostCleanUpStanding } from '../../../lib/host-clean-up.ts';
import { descriptionWords, nightlyTime, resultWords, scheduleWords } from './clean-up-words.ts';

const ZONE = 'America/Chicago';
/** Mon Nov 2, 2026, 9:48 AM Central (15:48 UTC; Central standard time began on Nov 1). */
const NOW = Date.UTC(2026, 10, 2, 15, 48);

function standing(overrides: Partial<HostCleanUpStanding> = {}): HostCleanUpStanding {
  return {
    schedule: { hour: 3, minute: 0, timeZone: ZONE },
    last: null,
    skipped: null,
    nextAt: new Date(Date.UTC(2026, 10, 3, 9, 0)).toISOString(),
    ...overrides,
  };
}

const run = (overrides: Partial<HostCleanUpRun> = {}): HostCleanUpRun => ({
  at: new Date(NOW).toISOString(),
  trigger: 'manual',
  removed: 31,
  byKind: {
    audit: 31,
    reviews: 0,
    memories: 0,
    logs: 0,
    notifications: 0,
    hookDeliveries: 0,
    chats: 0,
  },
  failed: [],
  ...overrides,
});

describe('nightlyTime', () => {
  test('reads the hour and minute on a 12-hour clock', () => {
    expect(nightlyTime(3, 0)).toBe('3:00 AM');
    expect(nightlyTime(0, 5)).toBe('12:05 AM');
    expect(nightlyTime(12, 30)).toBe('12:30 PM');
    expect(nightlyTime(23, 59)).toBe('11:59 PM');
  });
});

describe('scheduleWords', () => {
  test('names the hour and the host’s zone', () => {
    expect(scheduleWords(standing())).toBe(
      'Interborough does this every night at 3:00 AM Central time.',
    );
  });
});

describe('descriptionWords', () => {
  test('is the schedule alone before the first clean-up', () => {
    expect(descriptionWords(standing(), NOW)).toBe(
      'Interborough does this every night at 3:00 AM Central time.',
    );
  });

  test('adds the last clean-up, and the night the host was off for, as the board words them', () => {
    const words = descriptionWords(
      standing({
        last: run({ at: new Date(Date.UTC(2026, 10, 1, 9, 0)).toISOString(), trigger: 'nightly' }),
        skipped: { at: new Date(Date.UTC(2026, 10, 2, 9, 0)).toISOString() },
      }),
      NOW,
    );
    expect(words).toBe(
      'Interborough does this every night at 3:00 AM Central time. Last cleaned up Sun Nov 1, 3:00 AM. Skipped today while Interborough was off.',
    );
  });

  test('says today for a clean-up that ran today, and names the day of an earlier skipped night', () => {
    const words = descriptionWords(
      standing({
        last: run({ at: new Date(Date.UTC(2026, 10, 2, 14, 30)).toISOString() }),
        skipped: { at: new Date(Date.UTC(2026, 10, 1, 9, 0)).toISOString() },
      }),
      NOW,
    );
    expect(words).toContain('Last cleaned up today, 8:30 AM.');
    expect(words).toContain('Skipped Sun Nov 1, 3:00 AM while Interborough was off.');
  });
});

describe('resultWords', () => {
  test('says how many records were removed, in the singular for one', () => {
    expect(resultWords(run())).toEqual({
      text: 'Cleaned up just now. Removed 31 records.',
      failed: false,
    });
    expect(resultWords(run({ removed: 1 })).text).toBe('Cleaned up just now. Removed 1 record.');
  });

  test('says so when nothing was past its window', () => {
    expect(resultWords(run({ removed: 0 })).text).toBe(
      'Cleaned up just now. Nothing was past its retention window.',
    );
  });

  test('names the kinds that could not be removed and counts it as a failure', () => {
    expect(resultWords(run({ removed: 4, failed: ['chats', 'hookDeliveries'] }))).toEqual({
      text: 'Cleaned up just now, but chats, hook deliveries could not be removed. Removed 4 records.',
      failed: true,
    });
  });
});
