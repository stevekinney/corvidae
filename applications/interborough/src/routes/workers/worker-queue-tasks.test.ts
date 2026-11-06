import { fireEvent, render, within } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { ScopeGate } from '../../lib/scopes.svelte.ts';
import type { QueueTask, QueueTaskTab } from './queue-tasks-data.ts';
import WorkerQueueTasks from './worker-queue-tasks.svelte';

const NOW = Date.UTC(2026, 10, 2, 15, 0);
const OPEN_GATE: ScopeGate = { disabled: false, title: undefined };
const DISABLED_GATE: ScopeGate = { disabled: true, title: 'Requires system:admin' };

const failed = (id: string, activityName: string, error: string): QueueTask => ({
  operationId: id,
  status: 'failed',
  workflowId: 'run-1',
  workflowType: 'release-notes',
  activityName,
  attempt: 5,
  at: Date.UTC(2026, 9, 30, 20, 0),
  error,
});

const waiting = (id: string, at: number): QueueTask => ({
  operationId: id,
  status: 'waiting',
  workflowId: 'run-1',
  workflowType: 'release-notes',
  activityName: 'render-digest',
  attempt: 1,
  at,
});

interface Calls {
  tabs: QueueTaskTab[];
  retried: string[];
  cleared: string[];
  payloads: string[];
  retryAll: number;
  clearAll: number;
  loadMore: number;
}

function renderTasks(
  options: {
    tab?: QueueTaskTab;
    counts?: { waiting: number; failed: number } | undefined;
    tasks?: QueueTask[];
    retrying?: Set<string>;
    retryingCount?: number;
    hasMore?: boolean;
    gate?: ScopeGate;
    loading?: boolean;
    error?: unknown;
  } = {},
) {
  const calls: Calls = {
    tabs: [],
    retried: [],
    cleared: [],
    payloads: [],
    retryAll: 0,
    clearAll: 0,
    loadMore: 0,
  };
  const view = render(WorkerQueueTasks, {
    props: {
      queue: 'reports',
      tab: options.tab ?? 'failed',
      onTabChange: (tab: QueueTaskTab) => calls.tabs.push(tab),
      counts: 'counts' in options ? options.counts : { waiting: 12, failed: 2 },
      tasks: options.tasks ?? [
        failed('op-1', 'collect-merged-changes', 'GitHub didn’t answer (HTTP 503)'),
        failed('op-2', 'notify-on-failure', 'The Slack channel #releases no longer exists.'),
      ],
      retrying: options.retrying ?? new Set<string>(),
      retryingCount: options.retryingCount ?? 0,
      loading: options.loading ?? false,
      error: options.error ?? null,
      onReload: () => {},
      hasMore: options.hasMore ?? false,
      loadingMore: false,
      onLoadMore: async () => {
        calls.loadMore += 1;
      },
      adminGate: options.gate ?? OPEN_GATE,
      onRetryAll: () => (calls.retryAll += 1),
      onClearAll: () => (calls.clearAll += 1),
      onRetry: (id: string) => calls.retried.push(id),
      onClear: (id: string) => calls.cleared.push(id),
      onViewPayload: (id: string) => calls.payloads.push(id),
      now: NOW,
    },
  });
  return { view, calls };
}

describe('the header', () => {
  test('names the queue and puts the counts in the tabs, the open one selected', () => {
    const { view } = renderTasks();
    expect(view.getByRole('heading', { level: 3 }).textContent).toBe('Tasks on the reports queue');
    const radios = view.getAllByRole('radio');
    expect(
      radios.map((radio) => radio.getAttribute('aria-label') ?? radio.textContent?.trim()),
    ).toEqual([
      expect.stringContaining('All'),
      expect.stringContaining('Waiting'),
      expect.stringContaining('Failed for good'),
    ]);
    expect(view.getByRole('radio', { name: /Failed for good/ })).toBeChecked();
    expect(view.getByText('14')).not.toBeNull();
  });

  test('choosing a tab asks the route, which owns the read', async () => {
    const { view, calls } = renderTasks();
    await fireEvent.click(view.getByRole('radio', { name: /Waiting/ }));
    expect(calls.tabs).toEqual(['waiting']);
  });

  test('Retry all and Clear all carry the failed count, and act on the page', async () => {
    const { view, calls } = renderTasks();
    await fireEvent.click(view.getByRole('button', { name: 'Retry all (2)' }));
    await fireEvent.click(view.getByRole('button', { name: 'Clear all (2)' }));
    expect(calls.retryAll).toBe(1);
    expect(calls.clearAll).toBe(1);
  });

  test('has neither on the Waiting tab, where nothing failed', () => {
    const { view } = renderTasks({ tab: 'waiting', tasks: [waiting('w-1', NOW - 3_600_000)] });
    expect(view.queryByRole('button', { name: /Retry all/ })).toBeNull();
    expect(view.queryByRole('button', { name: /Clear all/ })).toBeNull();
  });

  test('while Retry all is in flight both buttons are disabled and the first counts what it is putting back', () => {
    const { view } = renderTasks({ retryingCount: 2 });
    expect(view.getByRole('button', { name: 'Retrying 2…' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Clear all (2)' })).toBeDisabled();
  });

  test('without system:admin they are disabled, with the reason offered', () => {
    const { view } = renderTasks({ gate: DISABLED_GATE });
    expect(view.getByRole('button', { name: 'Retry all (2)' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Clear all (2)' })).toBeDisabled();
  });
});

describe('failed tasks', () => {
  test('lead with the red status word, the activity in monospace, the run it is for, and the day', () => {
    const { view } = renderTasks();
    const row = view.container.querySelector<HTMLElement>('[data-task="op-1"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Failed for good');
    expect(row?.querySelector('code')?.textContent).toBe('collect-merged-changes');
    expect(
      within(row as HTMLElement).getByRole('link', { name: 'Release notes run' }),
    ).not.toBeNull();
    expect(row?.textContent).toContain('Oct 30');
    expect(row?.textContent).toContain('Failed after 5 tries · GitHub didn’t answer (HTTP 503).');
  });

  test('each has Retry, Clear, and View payload that name that task', async () => {
    const { view, calls } = renderTasks();
    const row = view.container.querySelector<HTMLElement>('[data-task="op-2"]') as HTMLElement;
    await fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    await fireEvent.click(within(row).getByRole('button', { name: 'Clear' }));
    await fireEvent.click(within(row).getByRole('button', { name: 'View payload' }));
    expect(calls).toMatchObject({ retried: ['op-2'], cleared: ['op-2'], payloads: ['op-2'] });
  });

  test('are followed by the footnote about Retry and Clear', () => {
    const { view } = renderTasks();
    expect(
      view.getByText(/Retry puts a task back on the queue\. Clear removes the task/),
    ).not.toBeNull();
  });

  test('read Waiting at once, on the next try, while Retry puts them back', () => {
    const { view } = renderTasks({ retrying: new Set(['op-1', 'op-2']), retryingCount: 2 });
    const row = view.container.querySelector<HTMLElement>('[data-task="op-1"]');
    expect(row?.textContent).toContain('Waiting');
    expect(row?.textContent).toContain('Back on the queue · try 6');
    expect(row?.textContent).toContain('Oct 30');
    expect(within(row as HTMLElement).queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('waiting tasks', () => {
  const rows = [
    waiting('w-1', Date.UTC(2026, 10, 2, 13, 12)),
    waiting('w-2', Date.UTC(2026, 10, 2, 13, 40)),
  ];

  test('carry the Waiting status, what they wait for, and no actions', () => {
    const { view } = renderTasks({ tab: 'waiting', tasks: rows });
    const row = view.container.querySelector<HTMLElement>('[data-task="w-1"]') as HTMLElement;
    expect(row.textContent).toContain('Waiting');
    expect(row.textContent).toContain('On the reports queue · waiting for a reports worker');
    expect(within(row).queryByRole('button')).toBeNull();
    expect(view.queryByText(/Retry puts a task back/)).toBeNull();
  });

  test('end in how many are shown of how many wait, and Load more', async () => {
    const { view, calls } = renderTasks({ tab: 'waiting', tasks: rows, hasMore: true });
    expect(view.getByText('Showing 2 of 12 waiting tasks')).not.toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Load more' }));
    expect(calls.loadMore).toBe(1);
  });

  test('have no footer once every one is shown', () => {
    const { view } = renderTasks({
      tab: 'waiting',
      counts: { waiting: 2, failed: 0 },
      tasks: rows,
    });
    expect(view.queryByText(/Showing/)).toBeNull();
  });
});

describe('when there is nothing to list', () => {
  test('the failed tab says none failed and how many still wait, once they are cleared', () => {
    const { view } = renderTasks({ tasks: [], counts: { waiting: 12, failed: 0 } });
    expect(view.getByTestId('worker-tasks-empty').textContent?.trim()).toBe(
      'No failed tasks. 12 are still waiting.',
    );
  });

  test('the Waiting tab says none wait and how many failed', () => {
    const { view } = renderTasks({ tab: 'waiting', tasks: [], counts: { waiting: 0, failed: 2 } });
    expect(view.getByTestId('worker-tasks-empty').textContent?.trim()).toBe(
      'No tasks are waiting. 2 failed for good.',
    );
  });

  test('the All tab says there are none', () => {
    const { view } = renderTasks({ tab: 'all', tasks: [], counts: { waiting: 0, failed: 0 } });
    expect(view.getByTestId('worker-tasks-empty').textContent?.trim()).toBe(
      'No tasks on this queue.',
    );
  });
});

describe('loading and failing', () => {
  test('a read in progress is a skeleton under the real heading', () => {
    const { view } = renderTasks({ loading: true, counts: undefined, tasks: [] });
    expect(view.getByRole('heading', { level: 3 }).textContent).toBe('Tasks on the reports queue');
    expect(view.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(view.queryByRole('radio')).toBeNull();
  });

  test('a failed read says so, with Try again', () => {
    const { view } = renderTasks({ error: new Error('boom'), counts: undefined, tasks: [] });
    expect(view.getByText(/Couldn’t load the tasks on this queue\./)).not.toBeNull();
    expect(view.getByRole('button', { name: 'Try again' })).not.toBeNull();
  });
});
