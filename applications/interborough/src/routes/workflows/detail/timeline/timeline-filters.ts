/**
 * Quick filters + step-range pagination for the Timeline tab (plan T3.1).
 * Pure functions, no DOM/Svelte — the tab component owns the `$state`.
 */
import type { WorkflowTimelineEntry } from '@lostgradient/weft';

/**
 * Quick-filter facets a step can be checked against: every step, the ones that failed, and the
 * ones the run is waiting on. A step is waiting when it has begun and has not ended, which is how a
 * run looks while it sleeps, waits for a signal, a review or a child, or a worker is still at it.
 */
export type TimelineQuickFilter = 'all' | 'failed' | 'waiting';

export const TIMELINE_QUICK_FILTERS: readonly TimelineQuickFilter[] = ['all', 'failed', 'waiting'];

const QUICK_FILTER_LABEL: Readonly<Record<TimelineQuickFilter, string>> = {
  all: 'All',
  failed: 'Failed',
  waiting: 'Waiting',
};

export function timelineQuickFilterLabel(filter: TimelineQuickFilter): string {
  return QUICK_FILTER_LABEL[filter];
}

function matchesQuickFilter(
  entry: WorkflowTimelineEntry,
  filter: TimelineQuickFilter,
  openSteps: ReadonlySet<number>,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'failed':
      return entry.status === 'failed' || entry.status === 'timed-out';
    case 'waiting':
      return openSteps.has(entry.step);
    default:
      return false;
  }
}

/**
 * The entries a quick filter keeps. `openSteps` is the steps the run is still in (`openStepNumbers`),
 * which is what Waiting means: an entry the engine kept as `running` is not waiting once the run left it.
 */
export function filterTimelineEntries(
  entries: readonly WorkflowTimelineEntry[],
  filter: TimelineQuickFilter,
  openSteps: ReadonlySet<number>,
): WorkflowTimelineEntry[] {
  return entries.filter((entry) => matchesQuickFilter(entry, filter, openSteps));
}

/**
 * Step-range pagination past ~500 entries (plan T3.1: "step-range pagination
 * past ~500 with jump-to-step"). Below the threshold, everything renders on
 * one page — pagination controls only appear once the timeline is long
 * enough that rendering it flat would be the actual UX problem.
 */
export const TIMELINE_PAGE_THRESHOLD = 500;
export const TIMELINE_PAGE_SIZE = 200;

export interface TimelinePage {
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly startStep: number;
  readonly endStep: number;
}

/** Whether the (already quick-filtered) entry count needs range pagination at all. */
export function needsTimelinePagination(entryCount: number): boolean {
  return entryCount > TIMELINE_PAGE_THRESHOLD;
}

/** Total page count for a given (filtered) entry count at `TIMELINE_PAGE_SIZE`. */
export function timelinePageCount(entryCount: number): number {
  return Math.max(1, Math.ceil(entryCount / TIMELINE_PAGE_SIZE));
}

/** Slices `entries` (already in step order) to the given zero-based page index, clamped to a valid page. */
export function timelineEntriesForPage(
  entries: readonly WorkflowTimelineEntry[],
  pageIndex: number,
): WorkflowTimelineEntry[] {
  const pageCount = timelinePageCount(entries.length);
  const clampedIndex = Math.min(Math.max(pageIndex, 0), pageCount - 1);
  const start = clampedIndex * TIMELINE_PAGE_SIZE;
  return entries.slice(start, start + TIMELINE_PAGE_SIZE);
}

/** Which zero-based page a given step number's index (its position in step order) falls on. */
export function timelinePageForStepIndex(stepIndex: number): number {
  return Math.floor(stepIndex / TIMELINE_PAGE_SIZE);
}

/**
 * Resolves "jump to step N" to a page index, given the entries in step
 * order. Returns `null` when no entry has that step number.
 */
export function timelinePageForStep(
  entries: readonly WorkflowTimelineEntry[],
  step: number,
): number | null {
  const index = entries.findIndex((entry) => entry.step === step);
  if (index === -1) return null;
  return timelinePageForStepIndex(index);
}
