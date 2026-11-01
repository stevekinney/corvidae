/**
 * The rows of a schedule's "Past runs" table: the runs it started and the fires it missed, in one
 * list, newest first. A run is placed at the moment it was created and a missed fire at the
 * occurrence it was recorded for, which are the two things a person compares ("did 09:00 run?").
 * Both come from what the engine persisted, so the list is the same after a reload.
 */
import type { WorkflowSummary } from '@lostgradient/weft';

import type { MissedFire } from '../../lib/bureau-schedules.ts';

/** One row of the table. */
export type PastRow =
  | {
      readonly kind: 'run';
      readonly at: number;
      readonly key: string;
      readonly run: WorkflowSummary;
    }
  | {
      readonly kind: 'missed';
      readonly at: number;
      readonly key: string;
      readonly missed: MissedFire;
    };

/**
 * The runs and the missed fires as rows, newest first. Two missed fires of one occurrence and
 * reason are two rows only when the schedule recorded them twice, so each is keyed by its
 * occurrence, reason and recording time.
 */
export function pastRows(
  runs: readonly WorkflowSummary[],
  missed: readonly MissedFire[],
): readonly PastRow[] {
  const rows: PastRow[] = [
    ...runs.map((run) => ({ kind: 'run' as const, at: run.createdAt, key: `run:${run.id}`, run })),
    ...missed.map((row) => ({
      kind: 'missed' as const,
      at: row.occurrence,
      key: `missed:${String(row.occurrence)}:${row.reason}:${String(row.recordedAt)}`,
      missed: row,
    })),
  ];
  return rows.toSorted((first, second) => second.at - first.at);
}
