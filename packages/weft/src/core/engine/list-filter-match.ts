/**
 * The match every list, aggregate and bulk path applies to a loaded run: {@link matchesListFilter}
 * on the state, then the one dimension that lives in a record of its own, `retrying`
 * (COR-2530). Every caller that loads a candidate goes through this function, so a filter field
 * is never honored by one path and dropped by another.
 *
 * @module core/engine/list-filter-match
 */
import type { ListFilter, SearchAttributeValue, WorkflowState } from '../types.ts';
import { matchesRetryingFilter } from './activity-retrying-record.ts';
import type { EngineInternals } from './internals.ts';
import { matchesListFilter } from './state-utilities.ts';

/**
 * Whether `state` satisfies `filter`. The cheap state checks run first, so the retrying record is
 * read (one small read, only for a running run) just for a run that already matches the rest.
 */
export async function matchesListFilterAndRecords(
  internals: EngineInternals,
  state: WorkflowState,
  filter: ListFilter | undefined,
  constrainedIds: Set<string> | null,
  normalizedTagFilters: readonly string[] | undefined,
  searchAttributes?: Readonly<Record<string, SearchAttributeValue>> | null,
): Promise<boolean> {
  if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters, searchAttributes)) {
    return false;
  }
  return matchesRetryingFilter(internals, state, filter?.retrying);
}
