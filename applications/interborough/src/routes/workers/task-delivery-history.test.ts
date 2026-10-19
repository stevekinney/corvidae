import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { createQueryClient } from '../../lib/query.ts';
import TaskDeliveryHistory from './task-delivery-history.svelte';
import TaskEvidenceHarness from './task-evidence-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './workers-route-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;
afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

const NOW = 1_700_000_000_000;

function renderHistory() {
  return render(TaskEvidenceHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: TaskDeliveryHistory,
      componentProps: { operationId: 'op_1' },
    },
  });
}

describe('TaskDeliveryHistory', () => {
  test('lists each submission, oldest first, with its outcome spelled out', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.deliveries', {
      operationId: 'op_1',
      historyLimit: 20,
      droppedCount: 0,
      deliveries: [
        {
          outcome: 'rejected',
          rejectionCode: 'stale-attempt',
          reason: 'attempt 2 owns this task',
          attemptTokenDigest: 'sha256:stale-token',
          transport: 'longPoll',
          submittedStatus: 'failed',
          receivedAt: NOW,
        },
        {
          outcome: 'acknowledged',
          disposition: 'dead-lettered',
          attempt: 2,
          attemptTokenDigest: 'sha256:good-token',
          transport: 'webSocket',
          workerId: 'worker-b',
          submittedStatus: 'completed',
          receivedAt: NOW + 5_000,
        },
      ],
    });

    const { findByText, getByText } = renderHistory();

    expect(await findByText('Rejected · stale-attempt')).not.toBeNull();
    expect(getByText('attempt 2 owns this task')).not.toBeNull();
    expect(getByText('No ledger attempt carries this token')).not.toBeNull();
    expect(getByText('HTTP long-poll')).not.toBeNull();
    expect(getByText('Acknowledged · dead-lettered')).not.toBeNull();
    expect(getByText('worker-b')).not.toBeNull();
  });

  test('says when the server dropped older history', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.deliveries', {
      operationId: 'op_1',
      historyLimit: 1,
      droppedCount: 3,
      deliveries: [
        {
          outcome: 'acknowledged',
          disposition: 'applied',
          attempt: 4,
          attemptTokenDigest: 'sha256:t',
          transport: 'webSocket',
          submittedStatus: 'completed',
          receivedAt: NOW,
        },
      ],
    });
    const { findByText } = renderHistory();
    expect(await findByText(/3 older entries were dropped/)).not.toBeNull();
  });

  test('an empty history is not an error', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.deliveries', {
      operationId: 'op_1',
      historyLimit: 20,
      droppedCount: 0,
      deliveries: [],
    });
    const { findByText } = renderHistory();
    expect(await findByText('No results submitted')).not.toBeNull();
  });

  test('loading, denied, malformed, and server-fault states are each explicit', async () => {
    scripted = new ScriptedFetch();
    const pending = scripted.deferJsonRpcMethod('weft.tasks.deliveries');
    const loading = renderHistory();
    expect(
      await loading.findByRole('status', { name: 'Loading result delivery history' }),
    ).not.toBeNull();
    pending.resolve({ operationId: 'op_1', historyLimit: 20, droppedCount: 0, deliveries: [] });
    scripted.restore();

    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethodError('weft.tasks.deliveries', 403, 'forbidden', 'Forbidden');
    const denied = renderHistory();
    expect(await denied.findByText('Result delivery history is locked')).not.toBeNull();
    scripted.restore();

    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.deliveries', { operationId: 'op_1' });
    const malformed = renderHistory();
    expect(await malformed.findByText('Malformed server response')).not.toBeNull();
    scripted.restore();

    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethodError(
      'weft.tasks.deliveries',
      401,
      'authentication required',
      'Unauthorized',
    );
    const fault = renderHistory();
    expect(await fault.findByText('Not authorized')).not.toBeNull();
  });
});

describe('TaskDeliveryHistory — alike submissions', () => {
  const rejected = {
    outcome: 'rejected',
    rejectionCode: 'stale-attempt',
    reason: 'attempt 2 owns this task',
    attemptTokenDigest: 'sha256:stale-token',
    transport: 'webSocket',
    submittedStatus: 'failed',
    receivedAt: NOW,
  };

  test('two identical submissions in one millisecond both render', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.tasks.deliveries', {
      operationId: 'op_1',
      historyLimit: 20,
      droppedCount: 0,
      deliveries: [rejected, { ...rejected }],
    });
    const view = renderHistory();
    const rendered = await view.findAllByText('Rejected · stale-attempt');
    expect(rendered).toHaveLength(2);
  });
});
