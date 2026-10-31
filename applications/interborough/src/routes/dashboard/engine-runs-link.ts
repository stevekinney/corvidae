/**
 * Where a count opens: the engine's own run list at `/health/runs`, narrowed by the same filter the
 * count was made with. The list reads `weft.workflows.list` and the counts read
 * `weft.workflows.aggregate`, and both take one filter, so a count and the list its link opens are
 * the same set. `/runs` is the Bureau's task list, which has five states of its own, and is never
 * where an engine count goes.
 */
import { serializeWorkflowListFilter, type WorkflowListQuery } from '../../lib/filters.ts';
import { ENGINE_RUNS_PATH } from '../../lib/workflow-type-paths.ts';

/** The address of the engine run list narrowed by `filter`, or the whole list when it names nothing. */
export function engineRunsPath(filter: WorkflowListQuery = {}): string {
  const query = serializeWorkflowListFilter(filter).toString();
  return query === '' ? ENGINE_RUNS_PATH : `${ENGINE_RUNS_PATH}?${query}`;
}
