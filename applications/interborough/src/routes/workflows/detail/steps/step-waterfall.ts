/**
 * The waterfall bar of each step: where it starts and how long it runs, as a share of the run.
 *
 * The bars share one scale. The origin is the run's start, or the first step's start when that is
 * earlier, and the scale ends at the latest end of any step. A step that is still running has no
 * end yet, so it is drawn up to `now` and marked open, and it also stretches the scale to `now`:
 * a run with one slow step in flight shows that step as most of the width, which is what it is.
 * A step that settled without a recorded duration is a point in time, not an interval, and gets a
 * hairline at its start. A step with no usable start time has no bar at all, and the row says so
 * rather than drawing one at the origin.
 */
import type { WorkflowTimelineEntry } from '@lostgradient/weft';

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

/** Whether the step has begun and not yet ended, which is how the page counts a step as waiting. */
function isOpen(entry: WorkflowTimelineEntry): boolean {
  return entry.status === 'running' && !usable(entry.duration);
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
  options: { readonly runStartedAt?: number | undefined; readonly now: number },
): ReadonlyMap<number, WaterfallBar> {
  const bars = new Map<number, WaterfallBar>();
  const origin = waterfallOrigin(entries, options.runStartedAt);
  if (origin === undefined) return bars;

  const now = usable(options.now) ? options.now : origin;
  let end = origin;
  for (const entry of entries) {
    if (!usable(entry.timestamp)) continue;
    const stop = isOpen(entry)
      ? Math.max(now, entry.timestamp)
      : entry.timestamp + (usable(entry.duration) ? Math.max(0, entry.duration) : 0);
    end = Math.max(end, stop);
  }
  const span = end - origin;

  for (const entry of entries) {
    if (!usable(entry.timestamp)) continue;
    const open = isOpen(entry);
    const instant = !open && !usable(entry.duration);
    const startedAfter = Math.max(0, entry.timestamp - origin);
    if (span <= 0) {
      bars.set(entry.step, { offset: 0, width: MINIMUM_BAR_WIDTH, open, instant, startedAfter });
      continue;
    }
    const length = open
      ? Math.max(now, entry.timestamp) - entry.timestamp
      : Math.max(0, entry.duration ?? 0);
    const offset = Math.min(100 - MINIMUM_BAR_WIDTH, (startedAfter / span) * 100);
    const width = Math.min(100 - offset, Math.max(MINIMUM_BAR_WIDTH, (length / span) * 100));
    bars.set(entry.step, { offset, width, open, instant, startedAfter });
  }
  return bars;
}
