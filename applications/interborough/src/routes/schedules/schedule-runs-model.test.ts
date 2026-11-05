/**
 * What the Runs list of a schedule's page says, worked out without a DOM (COR-2018, rows 72k,
 * 72v, 72w, 73a, 73f, 73g, 73l, 73m and 73p): the upcoming rows, the band the missed fires fold
 * into, each past run as a row, and the break where the viewer's clock changed.
 */
import { describe, expect, test } from 'bun:test';

import type { ScheduleSummary, WorkflowSummary } from '@lostgradient/weft';

import type { MissedFire } from '../../lib/bureau-schedules.ts';
import type { RowBlocker } from './schedule-row-model.ts';
import {
  clockBreak,
  missedBand,
  pastSection,
  spacedDuration,
  UPCOMING_RUN_LIMIT,
  upcomingRows,
} from './schedule-runs-model.ts';

// Monday, Nov 2, 2026, 10:46 AM in Central time.
const NOW = Date.parse('2026-11-02T16:46:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function schedule(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: 'daily',
    workflowType: 'agentRun',
    status: 'active',
    cronExpression: '0 9 * * *',
    timeZone: 'UTC',
    overlap: 'skip',
    backfill: false,
    revisionPolicy: 'active-at-fire',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    missedFireCount: 0,
    skippedCount: 0,
    nextFireAt: Date.parse('2026-11-03T09:00:00.000Z'),
    queuedRuns: [],
    ...overrides,
  };
}

const ACTIVE = { status: 'active', allBlockers: [] } as const;

describe('upcomingRows', () => {
  test('lists the next three, farthest first, so the nearest sits against the Now marker', () => {
    const rows = upcomingRows(schedule(), ACTIVE, NOW);

    expect(UPCOMING_RUN_LIMIT).toBe(3);
    expect(rows.map((row) => row.at)).toEqual([
      Date.parse('2026-11-05T09:00:00.000Z'),
      Date.parse('2026-11-04T09:00:00.000Z'),
      Date.parse('2026-11-03T09:00:00.000Z'),
    ]);
    expect(rows.map((row) => row.relative)).toEqual(['in 3 days', 'in 2 days', 'in 16 hours']);
    expect(rows.every((row) => /^[A-Z][a-z]{2} Nov \d, /.test(row.absolute))).toBe(true);
  });

  test('marks every skipped run, the next or a later one, and only those', () => {
    const later = Date.parse('2026-11-04T09:00:00.000Z');
    const rows = upcomingRows(schedule({ skippedOccurrences: [later] }), ACTIVE, NOW);

    expect(rows.map((row) => row.skipped)).toEqual([false, true, false]);
    const both = upcomingRows(
      schedule({ skippedOccurrences: [Date.parse('2026-11-03T09:00:00.000Z'), later] }),
      ACTIVE,
      NOW,
    );
    expect(both.map((row) => row.skipped)).toEqual([false, true, true]);
  });

  test('leaves out a run further off than the horizon, so a weekly schedule lists this week and next', () => {
    const weekly = schedule({
      cronExpression: '0 17 * * 1',
      nextFireAt: Date.parse('2026-11-09T17:00:00.000Z'),
    });

    expect(upcomingRows(weekly, ACTIVE, NOW).map((row) => row.at)).toEqual([
      Date.parse('2026-11-09T17:00:00.000Z'),
    ]);
    const further = schedule({
      cronExpression: '0 17 * * 5',
      nextFireAt: Date.parse('2026-11-06T17:00:00.000Z'),
    });
    expect(upcomingRows(further, ACTIVE, NOW).map((row) => row.at)).toEqual([
      Date.parse('2026-11-06T17:00:00.000Z'),
    ]);
  });

  test('always lists the next run, however far off, as a monthly schedule’s is', () => {
    const monthly = schedule({
      cronExpression: '0 9 1 * *',
      nextFireAt: Date.parse('2026-12-01T09:00:00.000Z'),
    });

    expect(upcomingRows(monthly, ACTIVE, NOW).map((row) => row.at)).toEqual([
      Date.parse('2026-12-01T09:00:00.000Z'),
    ]);
  });

  test('has no upcoming rows for a paused schedule', () => {
    expect(upcomingRows(schedule(), { status: 'paused', allBlockers: [] }, NOW)).toEqual([]);
  });

  test('lists the runs of a schedule held for its workflow, which the Bureau reads as Active', () => {
    const held = schedule({ status: 'paused' });

    expect(upcomingRows(held, ACTIVE, NOW)).toHaveLength(3);
  });

  test('says on the run that is due why it will not start', () => {
    const blockers: RowBlocker[] = [
      { kind: 'cannot-load', workflowType: 'order-refund', label: 'Order refund' },
      { kind: 'provider' },
    ];
    const due = schedule({
      cronExpression: '0 17 * * 1',
      nextFireAt: Date.parse('2026-11-02T17:00:00.000Z'),
    });
    const rows = upcomingRows(due, { status: 'active', allBlockers: blockers }, NOW);

    expect(rows.map((row) => row.note)).toEqual([
      undefined,
      'won’t start · Order refund can’t load · no provider',
    ]);
  });

  test('says no relative time for a run so far off that its date would be said twice', () => {
    const far = schedule({ nextFireAt: NOW + 9 * DAY });

    expect(upcomingRows(far, ACTIVE, NOW).at(-1)?.relative).toBe('');
  });
});

describe('spacedDuration', () => {
  test('spaces each unit from its number, as the design writes durations', () => {
    expect(spacedDuration(14_000)).toBe('14 s');
    expect(spacedDuration(0)).toBe('0 s');
    expect(spacedDuration(108_000)).toBe('1 min 48 s');
    expect(spacedDuration(240_000)).toBe('4 min');
    expect(spacedDuration(2 * HOUR + 5 * 60_000)).toBe('2 h 5 min');
    expect(spacedDuration(3 * DAY)).toBe('3 d');
    expect(spacedDuration(DAY + 2 * HOUR)).toBe('1 d 2 h');
  });
});

function fire(occurrence: string, overrides: Partial<MissedFire> = {}): MissedFire {
  const at = Date.parse(occurrence);
  return { occurrence: at, reason: 'late', count: 1, recordedAt: at, ...overrides };
}

describe('missedBand', () => {
  test('is none when nothing was missed', () => {
    expect(missedBand([], NOW)).toBeNull();
  });

  test('folds every miss into one band that says how many and since when, and lists each', () => {
    const band = missedBand(
      [
        fire('2026-10-30T09:00:00.000Z'),
        fire('2026-11-02T09:00:00.000Z'),
        fire('2026-11-01T09:00:00.000Z'),
        fire('2026-10-31T09:00:00.000Z'),
      ],
      NOW,
    );

    expect(band?.title).toMatch(/^Missed 4 times since Oct 30$/);
    expect(band?.detail).toBe('Interborough was off');
    expect(band?.rows.map((row) => row.at)).toEqual([
      Date.parse('2026-11-02T09:00:00.000Z'),
      Date.parse('2026-11-01T09:00:00.000Z'),
      Date.parse('2026-10-31T09:00:00.000Z'),
      Date.parse('2026-10-30T09:00:00.000Z'),
    ]);
    expect(band?.rows.every((row) => row.text === 'Missed · Interborough was off')).toBe(true);
    expect(band?.newest).toBe(Date.parse('2026-11-02T09:00:00.000Z'));
    expect(band?.oldest).toBe(Date.parse('2026-10-30T09:00:00.000Z'));
  });

  test('counts the times a clock gap swallowed, and says each reason once', () => {
    const band = missedBand(
      [
        fire('2026-03-08T08:00:00.000Z', { reason: 'dst-gap', count: 2 }),
        fire('2026-03-07T08:00:00.000Z'),
      ],
      NOW,
    );

    expect(band?.title).toMatch(/^Missed 3 times since/);
    expect(band?.detail).toBe('The clock skipped this time · Interborough was off');
    expect(band?.rows[0]?.text).toBe('Missed 2 times · The clock skipped this time');
  });

  test('says a single miss by its day', () => {
    expect(missedBand([fire('2026-10-30T09:00:00.000Z')], NOW)?.title).toBe(
      'Missed once on Oct 30',
    );
  });
});

function run(id: string, createdAt: string, status: WorkflowSummary['status'], tookMs: number) {
  const at = Date.parse(createdAt);
  return {
    id,
    type: 'agentRun',
    status,
    version: '1',
    createdAt: at,
    updatedAt: at + tookMs,
  } satisfies WorkflowSummary;
}

describe('pastSection', () => {
  test('is a status-first row per run, newest first, with how long it took and where it links', () => {
    const past = pastSection(
      [
        run('a', '2026-10-24T13:00:00.000Z', 'completed', 41_000),
        run('b', '2026-10-23T13:00:00.000Z', 'completed', 38_000),
      ],
      [],
      {},
      NOW,
    );

    expect(past.band).toBeNull();
    expect(past.runs.map((row) => [row.status, row.duration, row.needsDetail])).toEqual([
      ['Done', '41 s', false],
      ['Done', '38 s', false],
    ]);
    expect(past.runs[0]?.href).toMatch(/a$/);
  });

  test('says how long a run that is going has gone so far, and reads its detail', () => {
    const past = pastSection([run('now', '2026-11-02T16:45:00.000Z', 'running', 0)], [], {}, NOW);

    expect(past.runs[0]).toMatchObject({
      status: 'Running',
      duration: '1 min so far',
      running: true,
      needsDetail: true,
    });
  });

  test('reads a failed run, a canceled one and a timed-out one by their words', () => {
    const past = pastSection(
      [
        run('f', '2026-10-30T16:00:00.000Z', 'failed', 3_000),
        run('c', '2026-10-29T16:00:00.000Z', 'cancelled', 1_000),
        run('t', '2026-10-28T16:00:00.000Z', 'timed-out', 5_000),
      ],
      [],
      {},
      NOW,
    );

    expect(past.runs.map((row) => row.status)).toEqual(['Failed', 'Canceled', 'Failed']);
    expect(past.runs.every((row) => row.needsDetail)).toBe(true);
  });

  test('holds the misses in one band apart from the runs', () => {
    const past = pastSection(
      [run('a', '2026-10-29T09:00:00.000Z', 'completed', 14_000)],
      [fire('2026-11-02T09:00:00.000Z')],
      {},
      NOW,
    );

    expect(past.band?.rows).toHaveLength(1);
    expect(past.runs).toHaveLength(1);
  });

  test('leaves out what is older than the oldest row of a list that stopped at its page', () => {
    const past = pastSection(
      [run('a', '2026-10-29T09:00:00.000Z', 'completed', 14_000)],
      [fire('2026-11-02T09:00:00.000Z'), fire('2026-10-20T09:00:00.000Z')],
      { runs: true },
      NOW,
    );

    expect(past.band?.rows.map((row) => row.at)).toEqual([Date.parse('2026-11-02T09:00:00.000Z')]);
  });
});

describe('clockBreak', () => {
  const CHICAGO = 'America/Chicago';

  test('marks where daylight saving time ended between two runs of one UTC cadence', () => {
    const found = clockBreak(
      Date.parse('2026-11-01T09:00:00.000Z'),
      Date.parse('2026-10-31T09:00:00.000Z'),
      CHICAGO,
    );

    expect(found?.label).toBe('Daylight saving time ended Nov 1');
    expect(found?.at).toBeGreaterThan(Date.parse('2026-10-31T09:00:00.000Z'));
    expect(found?.at).toBeLessThanOrEqual(Date.parse('2026-11-01T09:00:00.000Z'));
  });

  test('marks where it began, between runs the other way round', () => {
    const found = clockBreak(
      Date.parse('2026-03-09T09:00:00.000Z'),
      Date.parse('2026-03-07T09:00:00.000Z'),
      CHICAGO,
    );

    expect(found?.label).toBe('Daylight saving time started Mar 8');
  });

  test('says nothing between rows that read the same offset', () => {
    expect(
      clockBreak(
        Date.parse('2026-10-31T09:00:00.000Z'),
        Date.parse('2026-10-30T09:00:00.000Z'),
        CHICAGO,
      ),
    ).toBeNull();
  });

  test('says nothing for a cadence that follows the viewer’s own clock, which reads 11:00 either side', () => {
    expect(
      clockBreak(
        Date.parse('2026-11-02T17:00:00.000Z'),
        Date.parse('2026-10-30T16:00:00.000Z'),
        CHICAGO,
      ),
    ).toBeNull();
  });

  test('says nothing for a run started by hand at another time of day', () => {
    expect(
      clockBreak(
        Date.parse('2026-11-02T16:45:00.000Z'),
        Date.parse('2026-10-30T16:00:00.000Z'),
        CHICAGO,
      ),
    ).toBeNull();
  });

  test('says nothing when the older row is not older', () => {
    const at = Date.parse('2026-11-01T09:00:00.000Z');

    expect(clockBreak(at, at, CHICAGO)).toBeNull();
  });
});
