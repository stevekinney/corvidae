/**
 * The engine-run counts on the Health overview, each defined once as a list filter. The count is
 * made with the filter (`weft.workflows.aggregate`) and its link opens the run list on the same
 * filter (`engine-runs-link.ts`), so the number a person reads and the rows they land on agree.
 * Words are the engine's own statuses, never a second vocabulary.
 */
import type { WorkflowStatus } from '@lostgradient/weft';

import type { WorkflowListQuery } from '../../lib/filters.ts';

/** The window "Failed in 24h" counts over, which is also the window of its link. */
export const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;

/** The statuses a person reads as failed: the run broke, or it ran out of time. */
export const FAILED_STATUSES: readonly WorkflowStatus[] = ['failed', 'timed-out'];

/** Runs the engine is executing now. */
export const WORKING_NOW_FILTER: WorkflowListQuery = { status: 'running' };

/**
 * Runs that failed in the last 24 hours, judged by when they last changed: a failed run does not
 * change again until someone retries it. The window starts on a whole minute, so the count's query
 * and its link name the same instant for as long as the page holds them.
 */
export function failedRecentlyFilter(now: number): WorkflowListQuery {
  const since = Math.floor((now - FAILED_WINDOW_MS) / MINUTE_MS) * MINUTE_MS;
  return { status: [...FAILED_STATUSES], updatedAt: { gte: since } };
}

/** A time range with only the bounds it sets, as the aggregate takes it. */
function boundsOf(range: NonNullable<WorkflowListQuery['updatedAt']>) {
  return {
    ...(range.gte === undefined ? {} : { gte: range.gte }),
    ...(range.gt === undefined ? {} : { gt: range.gt }),
    ...(range.lte === undefined ? {} : { lte: range.lte }),
    ...(range.lt === undefined ? {} : { lt: range.lt }),
  };
}

/** The input of `weft.workflows.aggregate` that counts `filter`'s runs. */
export function aggregateInputFor(filter: WorkflowListQuery) {
  return {
    groupBy: 'status' as const,
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(filter.updatedAt === undefined ? {} : { updatedAt: boundsOf(filter.updatedAt) }),
  };
}
