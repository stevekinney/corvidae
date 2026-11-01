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
});
