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

/**
 * The served timeline of `entries`, in the engine's order and at most {@link RUN_TIMELINE_ENTRY_LIMIT}
 * long. `tries` is counted over all of the engine's entries, so a cut never lowers it.
 */
function projectRunTimeline(
  entries: readonly WorkflowTimelineEntry[],
): Pick<ServedRunTimeline, 'entries' | 'truncated'> {
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

/**
 * Where a run stands, in the engine's own words for a workflow instance. An agent run's task state
 * is said in the same words ({@link runStatusOfTask}), so a reader draws a run of either kind with
 * one vocabulary: a run that is `completed`, `failed`, `cancelled` or `timed-out` has finished, so
 * no step of it is still going whatever its last entry reads.
 */
export type RunTimelineRunStatus =
  'pending' | 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled' | 'timed-out';

/** The values of {@link RunTimelineRunStatus}, for a schema that lists them. */
export const RUN_TIMELINE_RUN_STATUSES = [
  'pending',
  'running',
  'suspended',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
] as const satisfies readonly RunTimelineRunStatus[];

/** An agent run's task state, said as a {@link RunTimelineRunStatus}. */
export function runStatusOfTask(
  state: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled',
): RunTimelineRunStatus {
  switch (state) {
    case 'submitted':
      return 'pending';
    case 'working':
      return 'running';
    case 'input-required':
      return 'suspended';
    case 'canceled':
      return 'cancelled';
    case 'completed':
    case 'failed':
      return state;
  }
}

/** A run's timeline as `bureau.runs.timeline` and the `runs-timeline` agent tool serve it. */
export interface ServedRunTimeline {
  /** The steps, in the order the run took them. */
  readonly entries: readonly RunTimelineEntry[];
  /** Whether the engine held more entries than were returned. */
  readonly truncated: boolean;
  /** Which kind of run the id named. */
  readonly kind: 'agent' | 'workflow';
  /** Where the run stands as the timeline is read. */
  readonly runStatus: RunTimelineRunStatus;
}

/** The served timeline of the run of `kind` that stands at `runStatus`, from the engine's `entries`. */
export function serveRunTimeline(
  kind: 'agent' | 'workflow',
  runStatus: RunTimelineRunStatus,
  entries: readonly WorkflowTimelineEntry[],
): ServedRunTimeline {
  return { kind, runStatus, ...projectRunTimeline(entries) };
}
