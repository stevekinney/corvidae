/**
 * Component tests for the card of reasons a schedule will not start: each reason says what is
 * wrong in its own words, and one that can be fixed somewhere links to where.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { router } from '../../lib/router.svelte.ts';
import { workflowEditPath } from '../../lib/workflow-type-paths.ts';
import ScheduleBlockers from './schedule-blockers.svelte';
import type { RowBlocker } from './schedule-row-model.ts';

afterEach(cleanup);

function renderBlockers(blockers: readonly RowBlocker[], problems = new Map<string, string>()) {
  return render(ScheduleBlockers, { props: { blockers, problems, id: 'why' } });
}

describe('the reasons a schedule will not start', () => {
  test('a workflow that cannot load names its file problem and links to the workflow', () => {
    const view = renderBlockers(
      [{ kind: 'cannot-load', workflowType: 'order-refund', label: 'Order refund' }],
      new Map([['order-refund', 'order-refund.json line 12']]),
    );
    const list = view.getByRole('list', { name: 'Why this schedule will not start' });
    expect(list.id).toBe('why');
    expect(view.getByText('Order refund can’t load')).not.toBeNull();
    expect(view.getByText('order-refund.json line 12')).not.toBeNull();
    expect(view.getByRole('link', { name: 'Open workflow' }).getAttribute('href')).toBe(
      router.href(workflowEditPath('order-refund')),
    );
  });

  test('a workflow with no known problem shows its type, and a deleted one has no link', () => {
    const view = renderBlockers([
      { kind: 'cannot-load', workflowType: 'order-refund', label: 'Order refund' },
      { kind: 'deleted', workflowType: 'release-notes' },
    ]);
    expect(view.getByText('order-refund')).not.toBeNull();
    expect(view.getByText(/release-notes was deleted/)).not.toBeNull();
    expect(view.getAllByRole('link')).toHaveLength(1);
  });

  test('a missing provider is a warning that links to the providers', () => {
    const view = renderBlockers([{ kind: 'provider' }]);
    expect(view.getByText('No model provider is connected.')).not.toBeNull();
    expect(view.getByRole('link', { name: 'Connect a provider' }).getAttribute('href')).toBe(
      router.href('/settings/models'),
    );
    const item = view.getByRole('listitem');
    expect(item.getAttribute('data-kind')).toBe('provider');
    expect(item.querySelector('[data-tone="warning"]')).not.toBeNull();
  });

  test('the reasons keep the order they are given', () => {
    const view = renderBlockers([
      { kind: 'deleted', workflowType: 'a-flow' },
      { kind: 'provider' },
    ]);
    expect(view.getAllByRole('listitem').map((item) => item.getAttribute('data-kind'))).toEqual([
      'deleted',
      'provider',
    ]);
  });
});
