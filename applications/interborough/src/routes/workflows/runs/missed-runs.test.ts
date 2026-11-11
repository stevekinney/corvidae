/**
 * The runs a schedule missed, as Runs collapses them into one row (rows 09q, 52n and 52o): how many
 * since when, the occurrences newest first in the viewer's zone, and the schedule's own zone kept in
 * its cadence. Read at the sample world's clock, Monday, Nov 2, 10:50 AM Central time.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import type { BureauSchedule, MissedFire } from '../../../lib/bureau-schedules.ts';
import { installBureauStub, type BureauStub } from '../../../lib/bureau-stub.test-support.ts';
import {
  missedDay,
  missedLineTwo,
  missedRunsOf,
  occurrenceWords,
  readRunSchedules,
} from './missed-runs.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

const ZONE = 'America/Chicago';
const NOW = Date.parse('2026-11-02T10:50:00-06:00');

/** Daily summary: Assistant every day at 9:00 AM UTC, which last fired Oct 29 at 4:00 AM Central. */
const DAILY_SUMMARY: BureauSchedule = {
  id: 'daily-summary',
  owner: 'anonymous:local',
  agentName: 'assistant',
  inputPreview: 'Summarize what happened yesterday.',
  continuesChat: false,
  workflowType: 'agentRun',
  description: 'Daily summary',
  cronExpression: '0 9 * * *',
  intervalMs: null,
  status: 'active',
  overlap: 'skip',
  revision: 1,
  timeZone: 'UTC',
  nextFireAt: null,
  skippedOccurrences: [],
  lastFireAt: '2026-10-29T09:00:00.000Z',
  missedFireCount: 4,
  skippedCount: 0,
  createdAt: '2026-10-28T14:00:00.000Z',
  updatedAt: '2026-10-28T14:00:00.000Z',
  blocker: null,
};

/** When the host that started at 9:00 AM on Nov 2 logged the four misses. */
const LOGGED = Date.parse('2026-11-02T09:00:00-06:00');

/** The four occurrences the host was down for, oldest first, as the schedule might list them. */
const MISSES: readonly MissedFire[] = [
  '2026-10-30T09:00:00.000Z',
  '2026-10-31T09:00:00.000Z',
  '2026-11-01T09:00:00.000Z',
  '2026-11-02T09:00:00.000Z',
].map((occurrence) => ({
  occurrence: Date.parse(occurrence),
  reason: 'late' as const,
  count: 1,
  recordedAt: LOGGED,
}));

describe('missedRunsOf', () => {
  test('counts the misses since the schedule last fired, newest first, logged when the host logged them', () => {
    const missed = missedRunsOf(DAILY_SUMMARY, MISSES, NOW);
    expect(missed).toMatchObject({
      scheduleId: 'daily-summary',
      title: 'Daily summary',
      agentName: 'assistant',
      count: 4,
      since: Date.parse('2026-10-30T09:00:00.000Z'),
      loggedAt: LOGGED,
      schedulePath: '/schedules/daily-summary',
    });
    expect(missed?.occurrences).toEqual(
      MISSES.map((miss) => miss.occurrence).toSorted((left, right) => right - left),
    );
    expect(missed?.cadence.startsWith('every day at ')).toBe(true);
  });

  test('is nothing when the schedule has fired since every miss', () => {
    expect(
      missedRunsOf({ ...DAILY_SUMMARY, lastFireAt: '2026-11-02T09:30:00.000Z' }, MISSES, NOW),
    ).toBeNull();
    expect(missedRunsOf(DAILY_SUMMARY, [], NOW)).toBeNull();
  });
});

describe('the words of the missed row', () => {
  test('say each occurrence in the viewer’s zone, newest first, and the day of the first miss', () => {
    const missed = missedRunsOf(DAILY_SUMMARY, MISSES, NOW);
    if (missed === null) throw new Error('No missed runs were read.');
    // 9:00 AM UTC is 3:00 AM Central after the Nov 1 change, and 4:00 AM before it.
    expect(missed.occurrences.map((at) => occurrenceWords(at, ZONE))).toEqual([
      'Mon, Nov 2, 3:00 AM',
      'Sun, Nov 1, 3:00 AM',
      'Sat, Oct 31, 4:00 AM',
      'Fri, Oct 30, 4:00 AM',
    ]);
    expect(missedDay(missed.since, ZONE)).toBe('Oct 30');
    const line = missedLineTwo(missed, ZONE, (name) => (name === 'assistant' ? 'Assistant' : name));
    expect(line.startsWith('Schedule, Assistant, every day at ')).toBe(true);
    expect(line.endsWith(', missed 4 times since Oct 30')).toBe(true);
    expect(line).not.toContain(String.fromCodePoint(0xb7));
  });
});

describe('readRunSchedules', () => {
  test('names every schedule, and asks for the misses only of one that missed a fire', async () => {
    stub = installBureauStub({
      'bureau.schedules.list': () => ({
        schedules: [
          DAILY_SUMMARY,
          {
            ...DAILY_SUMMARY,
            id: 'weekly-audit',
            description: 'Weekly refund audit',
            missedFireCount: 0,
          },
        ],
        nextOffset: null,
      }),
      'bureau.schedules.missed': () => ({
        missed: MISSES.map((miss) => ({
          occurrence: new Date(miss.occurrence).toISOString(),
          reason: miss.reason,
          count: miss.count,
          recordedAt: new Date(miss.recordedAt).toISOString(),
        })),
      }),
    });

    const read = await readRunSchedules({ now: NOW });

    expect([...read.names]).toEqual([
      ['daily-summary', 'Daily summary'],
      ['weekly-audit', 'Weekly refund audit'],
    ]);
    expect(read.missed.map((missed) => [missed.scheduleId, missed.count])).toEqual([
      ['daily-summary', 4],
    ]);
    expect(stub.callsTo('bureau.schedules.missed').map((call) => call.params)).toEqual([
      { scheduleId: 'daily-summary' },
    ]);
  });
});
