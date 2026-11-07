import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkerSummary } from './worker-catalog-types.ts';
import WorkerConfirmations, { type WorkerConfirmation } from './worker-confirmations.svelte';

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
    connectedAt: 0,
    lastHeartbeatAt: 0,
    startedAt: 0,
    heartbeatAgeMs: 0,
    capabilities: {},
    health: 'active',
    ...overrides,
  };
}

function renderConfirmation(
  confirmation: WorkerConfirmation,
  workers: WorkerSummary[],
  counts?: { waiting: number; failed: number },
) {
  const calls = { confirmed: 0, cancelled: 0 };
  const view = render(WorkerConfirmations, {
    props: {
      confirmation,
      workers,
      counts,
      busy: false,
      onConfirm: () => (calls.confirmed += 1),
      onCancel: () => (calls.cancelled += 1),
    },
  });
  return { view, calls };
}

describe('Drain', () => {
  test('says what happens to the running work and where new work goes, with a primary button', async () => {
    const subject = worker();
    const other = worker({ id: 'payments-worker-2', name: 'Payments worker 2', inFlight: 2 });
    const { view, calls } = renderConfirmation({ kind: 'drain', worker: subject }, [
      subject,
      other,
    ]);

    expect(view.getByRole('dialog', { name: 'Drain Payments worker 1?' })).not.toBeNull();
    expect(
      view.getByText(
        'It finishes the 3 tasks it is running, takes no new ones, and then stops. New payments tasks go to Payments worker 2.',
      ),
    ).not.toBeNull();
    const confirm = view.getByRole('button', { name: 'Drain worker' });
    expect(confirm.className).not.toContain('danger');
    await fireEvent.click(confirm);
    expect(calls.confirmed).toBe(1);
  });

  test('says new tasks wait when no other worker takes the queue', () => {
    const subject = worker({ inFlight: 1 });
    const { view } = renderConfirmation({ kind: 'drain', worker: subject }, [subject]);
    expect(
      view.getByText(
        'It finishes the 1 task it is running, takes no new ones, and then stops. New payments tasks wait until a payments worker connects.',
      ),
    ).not.toBeNull();
  });

  test('Cancel confirms nothing', async () => {
    const subject = worker();
    const { view, calls } = renderConfirmation({ kind: 'drain', worker: subject }, [subject]);
    await fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(calls).toEqual({ confirmed: 0, cancelled: 1 });
  });
});

describe('Forget', () => {
  const gone = worker({
    id: 'reports-worker',
    name: 'Reports worker',
    queue: 'reports',
    inFlight: 0,
    disconnectedAt: 1,
  });

  test('says the waiting and failed tasks stay on the queue, and the worker shows up again', async () => {
    const { view, calls } = renderConfirmation({ kind: 'forget', worker: gone }, [gone], {
      waiting: 12,
      failed: 2,
    });

    expect(view.getByRole('dialog', { name: 'Forget Reports worker?' })).not.toBeNull();
    expect(
      view.getByText(
        'Interborough stops listing it. The 12 waiting tasks and the 2 that failed for good stay on the reports queue and continue when a reports worker connects. If the worker is still running, it shows up again the next time it checks in.',
      ),
    ).not.toBeNull();
    const confirm = view.getByRole('button', { name: 'Forget worker' });
    expect(confirm.className).not.toContain('danger');
    await fireEvent.click(confirm);
    expect(calls.confirmed).toBe(1);
  });

  test('says nothing is waiting when nothing is', () => {
    const { view } = renderConfirmation({ kind: 'forget', worker: gone }, [gone], {
      waiting: 0,
      failed: 0,
    });
    expect(view.getByText(/Nothing is waiting on the reports queue\./)).not.toBeNull();
  });

  test('names only the tasks there are', () => {
    const { view } = renderConfirmation({ kind: 'forget', worker: gone }, [gone], {
      waiting: 0,
      failed: 1,
    });
    expect(
      view.getByText(/The 1 that failed for good stays on the reports queue and continues when/),
    ).not.toBeNull();
  });
});
