/**
 * What `bureau.runs.timeline` serves of a run's step timeline: the engine's entries cut down to
 * the fields a waterfall is drawn from, with no payload.
 *
 * The engine's `WorkflowTimelineEntry` carries `inputSummary`, `outputSummary`, branch and child
 * detail, and a remote task's operation id. None of that is copied across: an entry is built field by
 * field from an allowlist, so a field the engine adds later is not served until this file names it.
 *
 * @module run-timeline
 */

import type { WorkflowTimelineEntry } from '@lostgradient/weft';

/** The most entries one read returns; a run with more is cut after this many and says so. */
export const RUN_TIMELINE_ENTRY_LIMIT = 1000;

/** One step of a run as `bureau.runs.timeline` serves it. */
export interface RunTimelineEntry {
  /** The step's number: the checkpoint key, which orders the run's steps. */
  readonly step: number;
  /** What the step is: an activity's or a child's name, `sleep`, `await-signal`. */
  readonly label: string;
  /** The kind of operation the step is, such as `activity` or `sleep`. */
  readonly operationType: string;
  /** `running`, `completed`, `failed`, `cancelled` or `timed-out`. */
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';
  /** When the step started, in epoch milliseconds. */
  readonly timestamp: number;
  /** How long the step ran, in milliseconds; absent while it runs and when none was recorded. */
  readonly duration?: number | undefined;
  /**
   * How many times the engine tried the step this entry belongs to, this attempt included: the
   * engine writes one entry for each attempt of an activity, all carrying the activity's
   * `stepIndex`, so it is the count of entries of the run that share this entry's `stepIndex` and
   * `operationType`. `1` for a step that was tried once and for an entry that has no `stepIndex`.
   */
  readonly tries: number;
}

/** A run's timeline as served, and whether the engine held more entries than were returned. */
export interface RunTimeline {
  readonly entries: readonly RunTimelineEntry[];
  readonly truncated: boolean;
}

/**
 * The served timeline of `entries`, in the engine's order and at most {@link RUN_TIMELINE_ENTRY_LIMIT}
 * long. `tries` is counted over all of the engine's entries, so a cut never lowers it.
 */
export function projectRunTimeline(entries: readonly WorkflowTimelineEntry[]): RunTimeline {
  const attempts = new Map<string, number>();
  const identityOf = (entry: WorkflowTimelineEntry): string | undefined =>
    entry.stepIndex === undefined ? undefined : `${String(entry.stepIndex)}:${entry.operationType}`;
  for (const entry of entries) {
    const identity = identityOf(entry);
    if (identity !== undefined) attempts.set(identity, (attempts.get(identity) ?? 0) + 1);
  }
  const served = entries.slice(0, RUN_TIMELINE_ENTRY_LIMIT).map((entry): RunTimelineEntry => {
    const identity = identityOf(entry);
    return {
      step: entry.step,
      label: entry.operationLabel,
      operationType: entry.operationType,
      status: entry.status,
      timestamp: entry.timestamp,
      ...(entry.duration === undefined ? {} : { duration: entry.duration }),
      tries: identity === undefined ? 1 : (attempts.get(identity) ?? 1),
    };
  });
  return { entries: served, truncated: entries.length > served.length };
}
