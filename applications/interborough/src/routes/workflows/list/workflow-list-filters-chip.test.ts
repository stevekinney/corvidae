/**
 * The updated window on the workflow list. No control in the bar sets it (a link does, the Health
 * overview's Failed in 24h), so the bar must name it and let the person drop it.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkflowListQuery } from '../../../lib/filters.ts';
import WorkflowListFilters from './workflow-list-filters.svelte';

const DAY_MS = 24 * 60 * 60 * 1000;

function mountWith(filter: WorkflowListQuery) {
  const changes: WorkflowListQuery[] = [];
  const result = render(WorkflowListFilters, {
    props: {
      filter,
      onFilterChange: (next: WorkflowListQuery) => changes.push(next),
      queryBuilderOpen: false,
      onQueryBuilderOpenChange: () => {},
      activeConditionCount: 0,
    },
  });
  return { ...result, changes };
}

describe('the workflow list filters, with an updated window', () => {
  test('name the window in a chip, and drop it with Clear all', async () => {
    const { container, getByRole, changes } = mountWith({
      status: 'failed',
      updatedAt: { gte: Date.now() - DAY_MS },
      limit: 25,
    });

    expect(container.textContent).toContain('Updated');
    expect(container.textContent).toContain('Last 24 hours');

    await fireEvent.click(getByRole('button', { name: /clear all/i }));
    expect(changes).toEqual([{ limit: 25 }]);
  });

  test('show no chip when there is no window, and call an unmatched window a custom range', () => {
    expect(mountWith({ status: 'failed' }).container.textContent).not.toContain('Updated');

    const { container } = mountWith({ updatedAt: { gte: 1, lte: 2 } });
    expect(container.textContent).toContain('Custom range');
  });
});
