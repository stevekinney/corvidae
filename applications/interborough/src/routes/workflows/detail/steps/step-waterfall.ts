/**
 * The waterfall bar of each step: where it starts and how long it runs, as a share of the run.
 *
 * The bars share one scale. The origin is the run's start, or the first step's start when that is
 * earlier, and the scale ends at the latest end of any step. A step that is still running has no
 * end yet, so it is drawn up to `now` and marked open, and it also stretches the scale to `now`:
 * a run with one slow step in flight shows that step as most of the width, which is what it is.
 * A step that settled without a recorded duration is a point in time, not an interval, and gets a
 * hairline at its start.
 *
 * "Still running" is only believed of the run's last step while the run itself is going. The engine
 * keeps a `running` entry as it was written, so a step the run waited in (`waitForSignal`, a sleep)
 * and then left stays `running` for good. An entry is closed when the run has finished or a later
 * entry exists; its end is then the next entry's start, which is when the run moved on, and with no
 * later entry it is a point in time. A step with no usable start time has no bar at all, and the row says so
 * rather than drawing one at the origin.
 */
import type { WorkflowTimelineEntry } from '@lostgradient/weft';

const FINISHED_RUN_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

/** A bar's place on the scale, in percent of the run's width. */
export interface WaterfallBar {
  /** Where the bar starts, 0 to 100. */
  readonly offset: number;
  /** How wide the bar is, never below {@link MINIMUM_BAR_WIDTH} so a short step stays visible. */
  readonly width: number;
  /** True while the step has no end, so the bar runs to the present moment. */
  readonly open: boolean;
  /** True when the step has no duration, so the bar is a mark at its start rather than a span. */
  readonly instant: boolean;
  /** Milliseconds from the origin to the step's start. */
  readonly startedAfter: number;
}

/** The smallest bar, in percent, so that a step of a few milliseconds in a long run is still there. */
export const MINIMUM_BAR_WIDTH = 0.75;

function usable(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The entries in the order the run took them. */
function inStepOrder(entries: readonly WorkflowTimelineEntry[]): WorkflowTimelineEntry[] {
  return entries.toSorted((a, b) => a.step - b.step);
}

/**
 * The numbers of the steps that have begun and not ended, which is how the page counts a step as
 * running or waiting: a `running` entry with no duration, while the run is not finished, and only
 * the last one, since a run that has moved past a step has left it.
 */
export function openStepNumbers(
  entries: readonly WorkflowTimelineEntry[],
  runStatus?: string,
): ReadonlySet<number> {
  const open = new Set<number>();
  if (runStatus !== undefined && FINISHED_RUN_STATUSES.has(runStatus)) return open;
  const last = inStepOrder(entries).at(-1);
  if (last !== undefined && last.status === 'running' && !usable(last.duration)) {
    open.add(last.step);
  }
  return open;
}

/** The length of a step that is not open: its duration, or the time until the run moved on from it. */
function closedLength(
  entry: WorkflowTimelineEntry,
  nextStart: number | undefined,
): number | undefined {
  if (usable(entry.duration)) return Math.max(0, entry.duration);
  if (entry.status === 'running' && usable(entry.timestamp) && usable(nextStart)) {
    return Math.max(0, nextStart - entry.timestamp);
  }
  return undefined;
}

/** The run's origin: its start, or the earliest step when that came first. `undefined` with nothing to measure. */
export function waterfallOrigin(
  entries: readonly WorkflowTimelineEntry[],
  runStartedAt: number | undefined,
): number | undefined {
  const starts = entries.map((entry) => entry.timestamp).filter(usable);
  if (usable(runStartedAt)) starts.push(runStartedAt);
  return starts.length === 0 ? undefined : Math.min(...starts);
}

/**
 * The bar of every step that has one, by step number. `entries` is every step of the run, not a
 * page or a filtered list, so a bar means the same thing wherever the step is shown.
 */
export function stepWaterfall(
  entries: readonly WorkflowTimelineEntry[],
  options: {
    readonly runStartedAt?: number | undefined;
    readonly now: number;
    /** The run's status; a finished run has no step still going. */
    readonly runStatus?: string | undefined;
  },
): ReadonlyMap<number, WaterfallBar> {
  const bars = new Map<number, WaterfallBar>();
  const origin = waterfallOrigin(entries, options.runStartedAt);
  if (origin === undefined) return bars;

  const now = usable(options.now) ? options.now : origin;
  const open = openStepNumbers(entries, options.runStatus);
  const ordered = inStepOrder(entries);
  // Each step's length and whether it is open, read once for the scale and again for the bars.
  const measured = ordered.map((entry, index) => {
    const isOpen = open.has(entry.step);
    const nextStart = ordered
      .slice(index + 1)
      .map((later) => later.timestamp)
      .find(usable);
    const length = isOpen
      ? usable(entry.timestamp)
        ? Math.max(now, entry.timestamp) - entry.timestamp
        : undefined
      : closedLength(entry, nextStart);
    return { entry, isOpen, length };
  });

  let end = origin;
  for (const { entry, length } of measured) {
    if (usable(entry.timestamp)) end = Math.max(end, entry.timestamp + (length ?? 0));
  }
  const span = end - origin;

  for (const { entry, isOpen, length } of measured) {
    if (!usable(entry.timestamp)) continue;
    const instant = !isOpen && length === undefined;
    const startedAfter = Math.max(0, entry.timestamp - origin);
    if (span <= 0) {
      bars.set(entry.step, {
        offset: 0,
        width: MINIMUM_BAR_WIDTH,
        open: isOpen,
        instant,
        startedAfter,
      });
      continue;
    }
    const offset = Math.min(100 - MINIMUM_BAR_WIDTH, (startedAfter / span) * 100);
    const width = Math.min(100 - offset, Math.max(MINIMUM_BAR_WIDTH, ((length ?? 0) / span) * 100));
    bars.set(entry.step, { offset, width, open: isOpen, instant, startedAfter });
  }
  return bars;
}
