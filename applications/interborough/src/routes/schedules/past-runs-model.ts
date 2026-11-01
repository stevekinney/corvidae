/**
 * The rows of a schedule's "Past runs" table: the runs it started and the fires it missed, in one
 * list, newest first. A run is placed at the moment it was created and a missed fire at the
 * occurrence it was recorded for, which are the two things a person compares ("did 09:00 run?").
 * Both come from what the engine persisted, so the list is the same after a reload.
 */
import type { WorkflowSummary } from '@lostgradient/weft';

import type { MissedFire } from '../../lib/bureau-schedules.ts';

/** How many missed fires one read returns at most: the engine's own page (`SCHEDULE_MISSED_FIRE_LIMIT`). */
export const SCHEDULE_MISSED_FIRE_LIMIT = 100;

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

/** Which of the two lists stopped at its page, so older rows of that kind exist and were not read. */
export type PastRowsTruncation = {
  readonly runs?: boolean;
  readonly missed?: boolean;
};

/**
 * The runs and the missed fires as rows, newest first. Two missed fires of one occurrence and
 * reason are two rows only when the schedule recorded them twice, so each is keyed by its
 * occurrence, reason and recording time.
 *
 * Each list is a page of the newest, so a list that stopped at its page says nothing about the
 * time before its oldest row. The table shows only the span both lists cover: a row older than the
 * oldest row of a truncated list is left out, so a long history reads as a table of the newest rows
 * of both kinds and never as one kind with the other missing.
 */
export function pastRows(
  runs: readonly WorkflowSummary[],
  missed: readonly MissedFire[],
  truncated: PastRowsTruncation = {},
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
  const sorted = rows.toSorted((first, second) => second.at - first.at);
  const oldest = (kind: PastRow['kind']): number =>
    Math.min(...sorted.filter((row) => row.kind === kind).map((row) => row.at));
  const floors = [
    ...(truncated.runs === true && runs.length > 0 ? [oldest('run')] : []),
    ...(truncated.missed === true && missed.length > 0 ? [oldest('missed')] : []),
  ];
  if (floors.length === 0) return sorted;
  const floor = Math.max(...floors);
  return sorted.filter((row) => row.at >= floor);
}
