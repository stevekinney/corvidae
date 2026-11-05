import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import type { ScopeGate } from '../../lib/scopes.svelte.ts';
import type { WorkerSummary } from './worker-catalog-types.ts';
import WorkerDetailView from './worker-detail-view.svelte';

const NOW = Date.UTC(2026, 10, 2, 16, 41);
const OPEN_GATE: ScopeGate = { disabled: false, title: undefined };
const DISABLED_GATE: ScopeGate = { disabled: true, title: 'Requires system:admin' };
const tasks = createRawSnippet(() => ({ render: () => '<p data-testid="tasks-slot">tasks</p>' }));

function worker(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  return {
    id: 'payments-worker-1',
    name: 'Payments worker 1',
    transport: 'websocket',
    queue: 'payments',
    activities: [],
    concurrency: 4,
    inFlight: 3,
    availableCapacity: 1,
    connectedAt: NOW - 10_000,
    lastHeartbeatAt: NOW - 1_000,
    startedAt: 0,
    heartbeatAgeMs: 1_000,
    capabilities: {},
    health: 'active',
    workflows: ['release-notes'],
    buildId: '2.4.1',
    ...overrides,
  };
}

/** A worker that reports no build and declares no workflows. */
function bare(): WorkerSummary {
  const { buildId: _build, workflows: _workflows, ...rest } = worker();
  return rest;
}

interface Handlers {
  drained: number;
  resumed: number;
  forgotten: number;
}

function renderDetail(
  subject: WorkerSummary,
  options: {
    workers?: WorkerSummary[];
    gate?: ScopeGate;
    counts?: { waiting: number; failed: number };
  } = {},
) {
  const handlers: Handlers = { drained: 0, resumed: 0, forgotten: 0 };
  const view = render(WorkerDetailView, {
    props: {
      worker: subject,
      workers: options.workers ?? [subject],
      adminGate: options.gate ?? OPEN_GATE,
      counts: options.counts,
      onDrain: () => (handlers.drained += 1),
      onResume: () => (handlers.resumed += 1),
      onForget: () => (handlers.forgotten += 1),
      tasks,
      now: NOW,
    },
  });
  return { view, handlers };
}

describe('a connected worker', () => {
  test('is headed by its name with its id small beside it, Connected, and last heard from just now', () => {
    const { view } = renderDetail(worker());
    expect(view.getByRole('heading', { level: 2 }).textContent).toBe('Payments worker 1');
    expect(view.getByTestId('worker-id').textContent).toBe('payments-worker-1');
    expect(view.getByTestId('worker-status-line').textContent).toBe('Last heard from just now');
    expect(view.getByTestId('worker-detail').dataset['status']).toBe('Connected');
  });

  test('offers Drain, and Drain asks the page rather than draining', async () => {
    const { view, handlers } = renderDetail(worker());
    await fireEvent.click(view.getByRole('button', { name: 'Drain this worker' }));
    expect(handlers).toEqual({ drained: 1, resumed: 0, forgotten: 0 });
    expect(view.queryByRole('button', { name: 'Forget this worker' })).toBeNull();
  });

  test('shows the facts row: its queue, what it runs now, what it serves, and its version', () => {
    const { view } = renderDetail(worker());
    const facts = view.getByTestId('worker-facts');
    expect([...facts.querySelectorAll('dt')].map((term) => term.textContent)).toEqual([
      'Queues',
      'Running now',
      'Serves',
      'Version',
    ]);
    expect([...facts.querySelectorAll('dd')].map((value) => value.textContent?.trim())).toEqual([
      'payments',
      '3 tasks',
      'Release notes',
      '2.4.1',
    ]);
    expect(facts.querySelector('code')?.textContent).toBe('2.4.1');
  });

  test('has no notice, and renders the tasks the route supplies', () => {
    const { view } = renderDetail(worker());
    expect(view.queryByTestId('worker-notice')).toBeNull();
    expect(view.getByTestId('tasks-slot')).not.toBeNull();
  });

  test('says a missing version and workflow with a dash', () => {
    const { view } = renderDetail(bare());
    const values = [...view.getByTestId('worker-facts').querySelectorAll('dd')].map((value) =>
      value.textContent?.trim(),
    );
    expect(values.slice(2)).toEqual(['—', '—']);
  });
});

describe('a worker that went away', () => {
  const gone = () =>
    worker({
      id: 'reports-worker',
      name: 'Reports worker',
      queue: 'reports',
      inFlight: 0,
      disconnectedAt: NOW - 3_600_000,
      lastHeartbeatAt: NOW - 3_600_000,
    });

  test('is Disconnected, last heard from an hour ago at the clock time, with Forget alone', async () => {
    const { view, handlers } = renderDetail(gone());
    expect(view.getByTestId('worker-status-line').textContent).toMatch(
      /^Last heard from an hour ago, at \d{1,2}:41 [AP]M$/u,
    );
    expect(view.queryByRole('button', { name: 'Drain this worker' })).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Forget this worker' }));
    expect(handlers.forgotten).toBe(1);
  });

  test('warns that nothing runs its queue, saying what waits and failed and that it reconnects', () => {
    const { view } = renderDetail(gone(), { counts: { waiting: 12, failed: 2 } });
    const notice = view.getByTestId('worker-notice');
    expect(notice.textContent).toContain('Nothing is running the reports queue.');
    expect(notice.textContent).toContain(
      '12 tasks are waiting for it and 2 failed for good. They continue when a reports worker connects. Start the worker process again on its machine; it reconnects by itself.',
    );
  });

  test('leaves out what it has no tasks to say about', () => {
    const { view } = renderDetail(gone(), { counts: { waiting: 0, failed: 0 } });
    expect(view.getByTestId('worker-notice').textContent).toContain(
      'Start the worker process again on its machine; it reconnects by itself.',
    );
    expect(view.getByTestId('worker-notice').textContent).not.toContain('waiting for it');
  });

  test('has no notice while another worker still runs its queue', () => {
    const peer = worker({ id: 'reports-worker-2', queue: 'reports' });
    const { view } = renderDetail(gone(), { workers: [gone(), peer] });
    expect(view.queryByTestId('worker-notice')).toBeNull();
  });
});

describe('a worker that finished draining', () => {
  test('reads Stopped with the sentence about its tasks, Forget alone, and no notice', () => {
    const stopped = worker({
      id: 'search-worker',
      name: 'Search worker',
      health: 'drained',
      inFlight: 0,
      drainFinishedTasks: 2,
    });
    const { view } = renderDetail(stopped);
    expect(view.getByTestId('worker-status-line').textContent).toBe(
      'It finished its 2 tasks and stopped. Nothing is waiting on it.',
    );
    expect(view.getByRole('button', { name: 'Forget this worker' })).not.toBeNull();
    expect(view.queryByRole('button', { name: 'Drain this worker' })).toBeNull();
    expect(view.queryByTestId('worker-notice')).toBeNull();
  });
});

describe('a draining worker', () => {
  test('says how many tasks it is finishing and offers Resume', async () => {
    const { view, handlers } = renderDetail(worker({ health: 'draining', inFlight: 2 }));
    expect(view.getByTestId('worker-status-line').textContent).toBe(
      'Finishing 2 tasks, then it stops.',
    );
    await fireEvent.click(view.getByRole('button', { name: 'Resume this worker' }));
    expect(handlers.resumed).toBe(1);
  });
});

describe('a worker with a long id', () => {
  const id = 'payments-worker-eu-west-1b-7f3a9c2e-4d81-4b06-a9e2-1c5d0f7b3a68';

  test('wraps the whole id under the heading with a Copy button', () => {
    const { view } = renderDetail(worker({ id, name: 'Payments worker EU' }));
    expect(view.getByRole('heading', { level: 2 }).textContent).toBe('Payments worker EU');
    expect(view.getByTestId('worker-id').textContent).toBe(id);
    expect(view.getByRole('button', { name: 'Copy the worker ID' })).not.toBeNull();
  });

  test('has no Copy button when the id is short enough to sit beside the heading', () => {
    const { view } = renderDetail(worker());
    expect(view.queryByRole('button', { name: 'Copy the worker ID' })).toBeNull();
  });
});

describe('without system:admin', () => {
  test('the action is disabled, with its reason offered', () => {
    const { view } = renderDetail(worker(), { gate: DISABLED_GATE });
    expect(view.getByRole('button', { name: 'Drain this worker' })).toBeDisabled();
  });
});
