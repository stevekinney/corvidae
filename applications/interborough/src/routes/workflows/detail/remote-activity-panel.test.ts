/** Component tests for `<RemoteActivityPanel>` (COR-274): the ledger's own facts, and every non-success state. */
import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';

import { taskLedgerDetailFixture } from '../../workers/workers-route-test-support.test-support.ts';
import RemoteActivityPanelHarness from './remote-activity-panel.test-harness.svelte';
import { REMOTE_TASK_STATE_LABELS } from './remote-task-view.ts';

function renderPanel(readTask: (input: { operationId: string }) => Promise<unknown>) {
  return render(RemoteActivityPanelHarness, {
    props: { operationId: 'as:wf-1:2:1', readTask, label: 'chargeCard' },
  });
}

function definitionFor(term: HTMLElement): string {
  expect(term.tagName).toBe('DT');
  return (term.nextElementSibling?.textContent ?? '').trim();
}

describe('RemoteActivityPanel', () => {
  test('shows the queue, attempt, retry policy, timeouts, header keys, and execution token the ledger holds', async () => {
    const reads: string[] = [];
    const view = renderPanel(async ({ operationId }) => {
      reads.push(operationId);
      return {
        ...taskLedgerDetailFixture(),
        operationId,
        scheduleToCloseDeadline: 4_000_000_000_000,
      };
    });

    expect(await view.findByText(REMOTE_TASK_STATE_LABELS.queued)).not.toBeNull();
    expect(reads).toEqual(['as:wf-1:2:1']);
    expect(definitionFor(view.getByText('Queue'))).toBe('payments');
    expect(definitionFor(view.getByText('Attempt'))).toBe('2 of 3');
    expect(definitionFor(view.getByText('Retry policy'))).toContain('Up to 3 attempts');
    expect(definitionFor(view.getByText('Visibility timeout'))).toBe('30s');
    expect(definitionFor(view.getByText('Schedule-to-close deadline'))).not.toBe('None');
    expect(definitionFor(view.getByText('Header keys'))).toBe('traceparent');
    expect(definitionFor(view.getByText('Execution token'))).toBe('token_route');
    expect(view.getByRole('link', { name: 'Open the task ledger record' })).not.toBeNull();
  });

  test('says there is no retry policy when the record has none', async () => {
    const view = renderPanel(async () => ({
      ...taskLedgerDetailFixture(),
      retryPolicy: undefined,
    }));

    await view.findByText('Retry policy');

    expect(definitionFor(view.getByText('Retry policy'))).toBe('No retry policy');
  });

  const T = 1_700_000_000_000;
  const holder = {
    leaseDeadline: T + 30_000,
    firstQueuedAt: T,
    lastQueuedAt: T,
    startedAt: T,
    lastHeartbeatAt: T,
    retryCount: 0,
    requeueCount: 0,
  };
  const states = [
    [{ state: 'leased', ...holder }, REMOTE_TASK_STATE_LABELS.leased],
    [
      { state: 'completing', ...holder, pendingStatus: 'completed', resultDigest: 'sha256:r' },
      REMOTE_TASK_STATE_LABELS.completing,
    ],
    [
      {
        state: 'cancelling',
        ...holder,
        cancellationReason: 'workflow cancelled',
        cancellationRequestedAt: T,
      },
      REMOTE_TASK_STATE_LABELS.cancelling,
    ],
    [
      {
        state: 'deadLettered',
        retryCount: 0,
        requeueCount: 0,
        pendingStatus: 'completed',
        resultDigest: 'sha256:r',
        deadLetteredAt: T,
        persistenceFailureReason: 'result-resolution-storage-exhausted',
      },
      REMOTE_TASK_STATE_LABELS.deadLettered,
    ],
    [
      {
        state: 'terminal',
        disposition: 'resolved',
        terminalAt: T,
        adopted: true,
        resultDigest: 'sha256:r',
        resultStatus: 'completed',
      },
      REMOTE_TASK_STATE_LABELS.resolved,
    ],
    [
      {
        state: 'terminal',
        disposition: 'cancelled',
        terminalAt: T,
        adopted: false,
        cancellationReason: 'workflow cancelled',
      },
      REMOTE_TASK_STATE_LABELS.cancelled,
    ],
    [
      {
        state: 'terminal',
        disposition: 'retryExhausted',
        terminalAt: T,
        adopted: false,
        error: 'boom',
      },
      REMOTE_TASK_STATE_LABELS.retryExhausted,
    ],
  ] as const;

  for (const [fields, label] of states) {
    test(`a ${fields.state} record ${'disposition' in fields ? `(${fields.disposition}) ` : ''}reads "${label}"`, async () => {
      const view = renderPanel(async () => {
        const { availableAt: _availableAt, ...base } = taskLedgerDetailFixture();
        return { ...base, ...fields };
      });

      expect(await view.findByText(label)).not.toBeNull();
      expect(view.queryByText(/ran locally/i)).toBeNull();
    });
  }

  test('shows a loading status before the record arrives', () => {
    const view = renderPanel(() => new Promise(() => {}));

    expect(view.getByRole('status', { name: 'Loading remote task' })).not.toBeNull();
  });

  test('says no task record exists when the ledger has none', async () => {
    const view = renderPanel(async () => {
      throw new HttpClientError(404, 'no such task');
    });

    expect(await view.findByText('No task record')).not.toBeNull();
  });

  test('names a denied read', async () => {
    const view = renderPanel(async () => {
      throw new HttpClientError(403, 'forbidden');
    });

    expect(await view.findByText('The remote task is locked')).not.toBeNull();
  });

  test('names a malformed record, and shows none of it', async () => {
    const view = renderPanel(async () => ({ state: 'sleeping' }));

    expect(await view.findByText('Malformed server response')).not.toBeNull();
    expect(view.queryByText('Queue')).toBeNull();
  });

  test('names a server fault', async () => {
    const view = renderPanel(async () => {
      throw new HttpClientError(400, 'bad request');
    });

    await waitFor(() =>
      expect(view.queryByRole('status', { name: 'Loading remote task' })).toBeNull(),
    );
    expect(view.queryByText('Queue')).toBeNull();
  });
});
