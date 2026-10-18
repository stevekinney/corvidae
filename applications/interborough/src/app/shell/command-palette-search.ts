/**
 * The command palette's search: ID-prefix search across workflows, schedules,
 * workers, and reviews via each domain's list operation.
 *
 * Each domain search runs independently and swallows its own failure (a 403
 * from a scope this principal lacks, a transient network error) rather than
 * failing the whole palette — a search-as-you-type surface degrading one
 * section to "no results" beats it going blank. Schedules are not searched at
 * all without `schedules:read`, which `weft.schedules.list` requires.
 */
import type {
  HttpClient,
  ReviewListEntry,
  ScheduleSummary,
  WorkflowSummary,
} from '@lostgradient/weft';

import type { ScopeGate } from '../../lib/scopes.svelte.ts';

export interface ConsoleSearchResults {
  readonly workflows: WorkflowSummary[];
  readonly schedules: ScheduleSummary[];
  readonly workers: { id: string; queue: string }[];
  readonly reviews: ReviewListEntry[];
}

export interface ConsoleSearchOptions {
  /** Whether the principal holds `schedules:read`; without it schedules are not searched. */
  readonly scheduleReadGate: ScopeGate;
}

/** Where a schedule's own page is: the schedules view, with the schedule selected. */
export function schedulePath(scheduleId: string): string {
  return `/schedules?id=${encodeURIComponent(scheduleId)}`;
}

/** Where a worker's own page is: the workers view, on its list, with the worker selected. */
export function workerPath(workerId: string): string {
  return `/workers?tab=list&worker=${encodeURIComponent(workerId)}`;
}

const WORKFLOW_ID_PREFIX_PATTERN = /^[A-Za-z0-9_-]+$/;

function containsQuery(needle: string, id: string): boolean {
  return id.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Search every domain for `query`. An empty query returns empty results.
 *
 * `client.list({ idPrefix })` is server-side filtering per its documented
 * `ListFilter.idPrefix` contract — but `HttpClient`'s own query-string builder
 * (`buildWorkflowListSearchParams`) never serializes `idPrefix` into the
 * request, so the server always receives an unfiltered `limit`-only query and
 * the prefix is silently dropped. Workaround, not a weft fork: still pass
 * `idPrefix` (free once the bug is fixed, and lets the server apply `limit`
 * meaningfully today), but also re-filter client-side so the palette is
 * correct regardless.
 */
export async function searchConsole(
  client: HttpClient,
  query: string,
  options: ConsoleSearchOptions,
): Promise<ConsoleSearchResults> {
  if (query.length === 0) return { workflows: [], schedules: [], workers: [], reviews: [] };

  const idPrefix = WORKFLOW_ID_PREFIX_PATTERN.test(query) ? query : undefined;

  const [workflows, schedules, workers, reviews] = await Promise.all([
    idPrefix
      ? client.list({ idPrefix, limit: 50 }).then(
          (result) =>
            result.items.filter((workflow) => workflow.id.startsWith(idPrefix)).slice(0, 5),
          () => [] as WorkflowSummary[],
        )
      : Promise.resolve([] as WorkflowSummary[]),
    options.scheduleReadGate.disabled
      ? Promise.resolve([] as ScheduleSummary[])
      : client.listSchedules({ limit: 100 }).then(
          (result) =>
            result.items.filter((schedule) => containsQuery(query, schedule.id)).slice(0, 5),
          () => [] as ScheduleSummary[],
        ),
    client.operations['weft.workers.list']({}).then(
      (result) => result.items.filter((worker) => containsQuery(query, worker.id)).slice(0, 5),
      () => [] as { id: string; queue: string }[],
    ),
    client.listReviews({}).then(
      (result) => result.filter((review) => containsQuery(query, review.reviewId)).slice(0, 5),
      () => [] as ReviewListEntry[],
    ),
  ]);
  return { workflows, schedules, workers, reviews };
}
