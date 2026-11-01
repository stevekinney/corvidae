import type { WorkflowState, WorkflowSummary } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import {
  RELATED_LIMIT,
  fetchRelatedRuns,
  hasRelatedRuns,
  relatedRunsQueryKey,
  type RelatedRunsClient,
} from './run-related-data.ts';

function summary(id: string, overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    id,
    type: 'child-type',
    status: 'completed',
    version: '1',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function state(id: string, overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id,
    type: 'parent-type',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1' },
    createdAt: 500,
    updatedAt: 500,
    ...overrides,
  };
}

/** A client over a small tree: `parent` started `a`, `b` and `c`, and `a` started `a1`. */
function client(overrides: { parent?: WorkflowState | null; siblingTotal?: number } = {}): {
  client: RelatedRunsClient;
  lists: unknown[];
} {
  const lists: unknown[] = [];
  const byParent: Record<string, WorkflowSummary[]> = {
    parent: [summary('a'), summary('b'), summary('c', { status: 'failed' })],
    a: [summary('a1')],
  };
  return {
    lists,
    client: {
      get: async (id: string) =>
        overrides.parent !== undefined
          ? overrides.parent
          : id === 'parent'
            ? state('parent')
            : null,
      list: async (filter: { parentWorkflowId?: string }) => {
        lists.push(filter);
        const items = byParent[filter.parentWorkflowId ?? ''] ?? [];
        return {
          items,
          total:
            filter.parentWorkflowId === 'parent' && overrides.siblingTotal !== undefined
              ? overrides.siblingTotal
              : items.length,
        };
      },
    } as unknown as RelatedRunsClient,
  };
}

describe('fetchRelatedRuns', () => {
  test('lists a run’s parent, its children, and the other runs its parent started', async () => {
    const { client: source } = client();
    const related = await fetchRelatedRuns(source, { id: 'a', parentWorkflowId: 'parent' });
    expect(related.parent).toMatchObject({ id: 'parent', type: 'parent-type', status: 'running' });
    expect(related.children.runs.map((run) => run.id)).toEqual(['a1']);
    expect(related.siblings.runs.map((run) => run.id)).toEqual(['b', 'c']);
    expect(related.siblings.total).toBe(2);
  });

  test('has no parent and no siblings for a run nothing started, and still lists its children', async () => {
    const { client: source, lists } = client();
    const related = await fetchRelatedRuns(source, { id: 'parent', parentWorkflowId: undefined });
    expect(related.parent).toBeUndefined();
    expect(related.siblings).toEqual({ runs: [], total: 0 });
    expect(related.children.runs.map((run) => run.id)).toEqual(['a', 'b', 'c']);
    expect(lists).toEqual([{ parentWorkflowId: 'parent', limit: RELATED_LIMIT }]);
  });

  test('still names a parent the engine no longer holds, by id alone', async () => {
    const { client: source } = client({ parent: null });
    const related = await fetchRelatedRuns(source, { id: 'a', parentWorkflowId: 'parent' });
    expect(related.parent).toEqual({
      id: 'parent',
      type: undefined,
      status: undefined,
      createdAt: undefined,
    });
  });

  test('counts siblings the page does not hold, without counting the run itself', async () => {
    const { client: source } = client({ siblingTotal: 120 });
    const related = await fetchRelatedRuns(source, { id: 'a', parentWorkflowId: 'parent' });
    expect(related.siblings.runs).toHaveLength(2);
    expect(related.siblings.total).toBe(119);
  });
});

describe('hasRelatedRuns', () => {
  test('is true when any side has a run and false when none does', async () => {
    const { client: source } = client();
    expect(
      hasRelatedRuns(await fetchRelatedRuns(source, { id: 'a1', parentWorkflowId: undefined })),
    ).toBe(false);
    expect(
      hasRelatedRuns(await fetchRelatedRuns(source, { id: 'parent', parentWorkflowId: undefined })),
    ).toBe(true);
  });
});

describe('relatedRunsQueryKey', () => {
  test('is under the shared prefix and distinct per run', () => {
    expect(relatedRunsQueryKey('a', 'p').slice(0, 2)).toEqual(['workflows', 'related']);
    expect(relatedRunsQueryKey('a', 'p')).not.toEqual(relatedRunsQueryKey('b', 'p'));
  });
});
