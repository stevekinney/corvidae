import { describe, expect, test } from 'bun:test';

import { parseWorkflowListFilter } from '../../lib/filters.ts';
import { ENGINE_RUNS_PATH } from '../../lib/workflow-type-paths.ts';
import { engineRunsPath } from './engine-runs-link.ts';
import { failedRecentlyFilter, WORKING_NOW_FILTER } from './health-counts.ts';

describe('engineRunsPath', () => {
  test('opens the engine run list on the status word the engine uses', () => {
    expect(engineRunsPath(WORKING_NOW_FILTER)).toBe('/health/runs?status=running');
  });

  test('is the whole list when the filter names nothing', () => {
    expect(engineRunsPath()).toBe(ENGINE_RUNS_PATH);
  });

  test('names a filter the engine list reads back as the same filter the count was made with', () => {
    const filter = failedRecentlyFilter(Date.UTC(2026, 9, 31, 12, 30, 45));
    const url = new URL(engineRunsPath(filter), 'http://localhost');

    expect(url.pathname).toBe(ENGINE_RUNS_PATH);
    expect(parseWorkflowListFilter(url.searchParams)).toEqual(filter);
  });

  test('never points at the Bureau runs list', () => {
    expect(engineRunsPath(WORKING_NOW_FILTER).startsWith('/runs')).toBe(false);
    expect(engineRunsPath(failedRecentlyFilter(0)).startsWith('/runs')).toBe(false);
  });
});
