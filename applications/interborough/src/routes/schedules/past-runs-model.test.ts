/**
 * The rows of a schedule's past runs: the runs it started and the fires it missed, in one list,
 * newest first.
 */
import { describe, expect, test } from 'bun:test';

import type { WorkflowSummary } from '@lostgradient/weft';

import type { MissedFire } from '../../lib/bureau-schedules.ts';
import { pastRows } from './past-runs-model.ts';

function run(id: string, createdAt: number): WorkflowSummary {
  return { id, type: 'report', status: 'completed', version: '1', createdAt, updatedAt: createdAt };
}

function missed(occurrence: number, reason: 'late' | 'dst-gap' = 'late'): MissedFire {
  return { occurrence, reason, count: 1, recordedAt: occurrence + 1 };
}

describe('the rows of the past runs', () => {
  test('put runs and missed fires in one list, newest first', () => {
    const rows = pastRows([run('a', 100), run('c', 300)], [missed(200)]);
    expect(rows.map((row) => `${row.kind}@${String(row.at)}`)).toEqual([
      'run@300',
      'missed@200',
      'run@100',
    ]);
  });

  test('place a run at its creation and a missed fire at its occurrence', () => {
    const [first, second] = pastRows([run('a', 100)], [missed(500)]);
    expect(first?.kind).toBe('missed');
    expect(first?.at).toBe(500);
    expect(second?.kind).toBe('run');
    expect(second?.at).toBe(100);
  });

  test('key two misses of one occurrence apart when they were recorded apart', () => {
    const first = missed(100);
    const second = { ...missed(100), recordedAt: 999 };
    const keys = pastRows([], [first, second]).map((row) => row.key);
    expect(new Set(keys).size).toBe(2);
  });

  test('are empty when nothing ran and nothing was missed', () => {
    expect(pastRows([], [])).toEqual([]);
  });

  test('show only the span both lists cover when the runs stopped at their page', () => {
    // The newest 3 runs end at 700; the missed fires reach back to 100. Rows older than 700 would
    // show missed fires with the runs between them absent, so they are left out.
    const rows = pastRows(
      [run('a', 900), run('b', 800), run('c', 700)],
      [missed(850), missed(650), missed(100)],
      { runs: true },
    );
    expect(rows.map((row) => `${row.kind}@${String(row.at)}`)).toEqual([
      'run@900',
      'missed@850',
      'run@800',
      'run@700',
    ]);
  });

  test('leave out runs older than the oldest missed fire when the missed fires stopped at their page', () => {
    // 100 missed fires since 1000; the runs are older. The table is the newest rows, all missed,
    // and no run older than the oldest missed fire is shown beside them.
    const manyMissed = Array.from({ length: 3 }, (_, index) => missed(1000 + index));
    const rows = pastRows([run('old', 500)], manyMissed, { missed: true });
    expect(rows.map((row) => row.kind)).toEqual(['missed', 'missed', 'missed']);
  });

  test('keep every row when neither list stopped at its page', () => {
    const rows = pastRows([run('a', 900)], [missed(100)], { runs: false, missed: false });
    expect(rows).toHaveLength(2);
  });
});
