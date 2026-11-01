/**
 * Component tests for the Workers route root (`index.svelte`, plan §9.4)
 * covering the happy-path tab renders, worker/queue selection via URL,
 * drain/resume mutations, dead-letter clearing, and loading skeletons.
 * Split out of `index.test.ts` (which owns the fault-title-mapping
 * regression coverage) purely to stay under this repo's `max-lines` lint
 * budget — both files exercise the same `index.svelte` route root and share
 * the same `ScriptedFetch`/harness support (`workers-route-test-support.test-support.ts`,
 * `workers-route-test-harness.test-harness.svelte`).
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window, type DetachedWindowAPI } from 'happy-dom';

import { createQueryClient, queryKeys } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import WorkersRoute from './index.svelte';
import {
  DEFAULT_TASK_DIAGNOSTICS_INPUT,
  TASK_HEARTBEAT_STALE_AFTER_MS,
} from './worker-catalog-types.ts';
import WorkersRouteTestHarness from './workers-route-test-harness.test-harness.svelte';
import {
  parseJsonObject,
  realClient,
  ScriptedFetch,
  taskLedgerDetailFixture,
} from './workers-route-test-support.test-support.ts';

import {
  diagnosticItem,
  EMPTY_DIAGNOSTICS_SUMMARY,
  queue,
  routeHappyPaths,
  worker,
} from './index-actions.test-support.ts';

let scripted: ScriptedFetch | undefined;

function happyDomAPI(): DetachedWindowAPI {
  if (!(window instanceof Window)) {
    throw new Error('expected the test window to be backed by happy-dom');
  }
  return window.happyDOM;
}

/** Same convention `system/api-reference-sections.test.ts` (Track E2) and `router.svelte.test.ts` (T1.3) establish: give the window a real origin before the reactive `router` singleton is touched. */
function resetLocation(path = '/health/workers'): void {
  happyDomAPI().setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => {
  resetLocation();
});

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

async function renderWorkersRoute(
  principalScopes: readonly ('system:read' | 'system:admin' | 'events:read')[] = [
    'system:read',
    'system:admin',
  ],
) {
  const queryClient = createQueryClient();
  const view = render(WorkersRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient,
      component: WorkersRoute,
      principalScopes,
    },
  });
  return { ...view, queryClient };
}

describe('Workers route — Task queues tab, queue selection and dead-letter clear', () => {
  test('no queue selected renders QueueListView', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { queues: [queue({ queue: 'payments' })] });

    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('tab', { name: 'Task queues' }));
    expect(await findByText('payments')).not.toBeNull();
  });

  test("selecting a queue via ?queue= renders QueueDetailView filtered to that queue's workers and dead-lettered items", async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [
        worker({ id: 'wkr_on_queue', queue: 'payments' }),
        worker({ id: 'wkr_other_queue', queue: 'billing' }),
      ],
      queues: [queue({ queue: 'payments' })],
      diagnosticsItems: [
        diagnosticItem({ queue: 'payments', operationId: 'op_on_queue' }),
        diagnosticItem({ queue: 'billing', operationId: 'op_other_queue' }),
      ],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 2 },
    });
    scripted.routeJsonRpcMethod('weft.tasks.get', {
      ...taskLedgerDetailFixture(),
      operationId: 'op_on_queue',
    });

    resetLocation('/health/workers?tab=queues&queue=payments');
    const { findAllByRole, findByText, queryByText } = await renderWorkersRoute();

    expect(await findByText('wkr_on_queue', { exact: false })).not.toBeNull();
    expect(queryByText('wkr_other_queue', { exact: false })).toBeNull();
    expect(await findByText('op_on_queue', { exact: false })).not.toBeNull();
    expect(queryByText('op_other_queue', { exact: false })).toBeNull();

    const inspectButtons = await findAllByRole('button', { name: 'Inspect ledger' });
    await fireEvent.click(inspectButtons[0]!);
    expect(await findByText('Authoritative task ledger')).not.toBeNull();
  });

  test('clearing a dead-lettered item on the selected queue opens the type-to-confirm dialog and calls the DELETE endpoint on confirm', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      queues: [queue({ queue: 'payments' })],
      diagnosticsItems: [diagnosticItem({ queue: 'payments', operationId: 'op_target' })],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
    });
    let deleteCalled = false;
    scripted.routeRest(
      (url, method) =>
        method === 'DELETE' && url.pathname === '/api/v1/tasks/diagnostics/dead-letter/op_target',
      () => {
        deleteCalled = true;
        return new Response(null, { status: 204 });
      },
    );

    resetLocation('/health/workers?tab=queues&queue=payments');
    const { findByLabelText, findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Clear' }));
    // The dialog names what it clears, and the person stays on the queue they were reading.
    expect(
      await findByText(/Clears the retained dead-letter record for ChargeCard on queue payments/),
    ).not.toBeNull();
    expect(router.search.get('tab')).toBe('queues');
    expect(router.search.get('queue')).toBe('payments');
    expect(router.search.get('task')).toBeNull();
    const confirmInput = await findByLabelText(/Type "op_target" to confirm/i);
    await fireEvent.input(confirmInput, { target: { value: 'op_target' } });
    await fireEvent.click(await findByRole('button', { name: 'Clear dead letter' }));

    // load-proof: the scripted JSON-RPC fetch resolves in memory, so the call is issued inside the click handler promise chain
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleteCalled).toBe(true);
    expect(router.search.get('tab')).toBe('queues');
  });

  test('a dead letter cleared elsewhere while the dialog was open is not cleared again, and the refusal says so', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      queues: [queue({ queue: 'payments' })],
      diagnosticsItems: [diagnosticItem({ queue: 'payments', operationId: 'op_target' })],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
    });
    let deleteCalled = false;
    scripted.routeRest(
      (url, method) =>
        method === 'DELETE' && url.pathname === '/api/v1/tasks/diagnostics/dead-letter/op_target',
      () => {
        deleteCalled = true;
        return new Response(null, { status: 204 });
      },
    );

    resetLocation('/health/workers?tab=queues&queue=payments');
    const { findByLabelText, findByRole, findByText, queryClient } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Clear' }));
    await fireEvent.input(await findByLabelText(/Type "op_target" to confirm/i), {
      target: { value: 'op_target' },
    });

    // Someone else clears it first; the diagnostics are read again before the dialog is confirmed.
    scripted.routeJsonRpcMethod('weft.tasks.diagnostics', {
      items: [],
      summary: EMPTY_DIAGNOSTICS_SUMMARY,
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics() });
    await fireEvent.click(await findByRole('button', { name: 'Clear dead letter' }));

    expect(await findByText(/That dead letter was cleared or changed/)).not.toBeNull();
    expect(deleteCalled).toBe(false);
  });

  test('a dead letter recorded again at another moment while the dialog was open is refused too', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      queues: [queue({ queue: 'payments' })],
      diagnosticsItems: [diagnosticItem({ queue: 'payments', operationId: 'op_target' })],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
    });

    resetLocation('/health/workers?tab=queues&queue=payments');
    const { findByLabelText, findByRole, findByText, queryClient } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Clear' }));
    await fireEvent.input(await findByLabelText(/Type "op_target" to confirm/i), {
      target: { value: 'op_target' },
    });

    scripted.routeJsonRpcMethod('weft.tasks.diagnostics', {
      items: [
        diagnosticItem({
          queue: 'payments',
          operationId: 'op_target',
          deadLetteredAt: 1_700_000_999_000,
        }),
      ],
      summary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics() });
    await fireEvent.click(await findByRole('button', { name: 'Clear dead letter' }));

    expect(await findByText(/That dead letter was cleared or changed/)).not.toBeNull();
  });
});

/** The `params` of every JSON-RPC call to `method`, in the order they were made. */
function rpcParams(script: ScriptedFetch, method: string): Record<string, unknown>[] {
  return script.calls.flatMap((call) => {
    const body = typeof call.init?.body === 'string' ? parseJsonObject(call.init.body) : undefined;
    const params = body?.['params'];
    return body?.['method'] === method && typeof params === 'object' && params !== null
      ? [Object.fromEntries(Object.entries(params))]
      : [];
  });
}

const RETRIED = { operationId: 'op_target', state: 'queued', attempt: 3, requeueCount: 2 };

describe('Workers route — retrying a dead letter from the queue', () => {
  function routeQueueWithDeadLetter(script: ScriptedFetch): void {
    routeHappyPaths(script, {
      queues: [queue({ queue: 'payments' })],
      diagnosticsItems: [diagnosticItem({ queue: 'payments', operationId: 'op_target' })],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
    });
  }

  test('Retry asks first, then retries that one task, and asks the queue again', async () => {
    scripted = new ScriptedFetch();
    routeQueueWithDeadLetter(scripted);
    scripted.routeJsonRpcMethod('weft.tasks.deadletters.retry', RETRIED);
    resetLocation('/health/workers?tab=queues&queue=payments');
    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Retry' }));
    expect(
      await findByText(
        /Queues ChargeCard on queue payments again under the same ID \(task op_target\)/,
      ),
    ).not.toBeNull();
    expect(rpcParams(scripted, 'weft.tasks.deadletters.retry')).toEqual([]);
    const diagnosticsReads = rpcParams(scripted, 'weft.tasks.diagnostics').length;

    await fireEvent.click(await findByRole('button', { name: 'Retry task' }));
    await waitUntil(() => rpcParams(scripted!, 'weft.tasks.deadletters.retry').length === 1);

    // Diagnostics do not carry the attempt, so none is named; the page stays on the queue.
    expect(rpcParams(scripted, 'weft.tasks.deadletters.retry')).toEqual([
      { operationId: 'op_target' },
    ]);
    await waitUntil(() => rpcParams(scripted!, 'weft.tasks.diagnostics').length > diagnosticsReads);
    expect(router.search.get('queue')).toBe('payments');
  });

  test('cancelling the confirmation retries nothing', async () => {
    scripted = new ScriptedFetch();
    routeQueueWithDeadLetter(scripted);
    resetLocation('/health/workers?tab=queues&queue=payments');
    const { findByRole, queryByRole } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Retry' }));
    await fireEvent.click(await findByRole('button', { name: 'Cancel' }));

    expect(queryByRole('button', { name: 'Retry task' })).toBeNull();
    expect(rpcParams(scripted, 'weft.tasks.deadletters.retry')).toEqual([]);
  });

  test('a dead letter cleared elsewhere while the dialog was open is not retried, and the refusal says so', async () => {
    scripted = new ScriptedFetch();
    routeQueueWithDeadLetter(scripted);
    resetLocation('/health/workers?tab=queues&queue=payments');
    const { findByRole, findByText, queryClient } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Retry' }));
    scripted.routeJsonRpcMethod('weft.tasks.diagnostics', {
      items: [],
      summary: EMPTY_DIAGNOSTICS_SUMMARY,
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics() });
    await fireEvent.click(await findByRole('button', { name: 'Retry task' }));

    expect(await findByText(/That dead letter was cleared, retried or changed/)).not.toBeNull();
    expect(rpcParams(scripted, 'weft.tasks.deadletters.retry')).toEqual([]);
  });

  test('a retry the server refuses says why, in the words of its reason', async () => {
    scripted = new ScriptedFetch();
    routeQueueWithDeadLetter(scripted);
    scripted.routeJsonRpcMethodError('weft.tasks.deadletters.retry', 409, 'refused', 'Conflict', {
      reason: 'workflow-finished',
    });
    resetLocation('/health/workers?tab=queues&queue=payments');
    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Retry' }));
    await fireEvent.click(await findByRole('button', { name: 'Retry task' }));

    expect(await findByText(/The workflow that owns that task has finished/)).not.toBeNull();
  });

  test('Retry is disabled without system:admin and asks nothing', async () => {
    scripted = new ScriptedFetch();
    routeQueueWithDeadLetter(scripted);
    resetLocation('/health/workers?tab=queues&queue=payments');
    const { findByRole, queryByRole } = await renderWorkersRoute(['system:read']);

    const retry = await findByRole('button', { name: 'Retry' });
    expect(retry.hasAttribute('disabled')).toBe(true);
    expect(queryByRole('button', { name: 'Retry task' })).toBeNull();
  });
});

describe('Workers route — a dead letter on a queue that is not listed', () => {
  const DEAD_ATTEMPT = {
    attempt: 2,
    attemptTokenDigest: 'sha256:t2',
    claimedAt: 1_700_000_000_000,
    disposition: 'deadLettered',
    dispositionAt: 1_700_000_050_000,
  } as const;

  function ghostDeadLetter(overrides: Record<string, unknown> = {}) {
    return {
      ...taskLedgerDetailFixture(),
      state: 'deadLettered',
      operationId: 'op_ghost',
      queue: 'ghost',
      availableAt: undefined,
      attempts: [DEAD_ATTEMPT],
      pendingStatus: 'completed',
      resultDigest: 'sha256:digest',
      deadLetteredAt: 1_700_000_050_000,
      persistenceFailureReason: 'result-resolution-storage-exhausted',
      ...overrides,
    };
  }

  // The queue list and the diagnostics know nothing of the task: its queue is gone and it is
  // beyond the diagnostics' page. Only its own ledger names it.
  function routeUnlisted(script: ScriptedFetch): void {
    routeHappyPaths(script, { queues: [queue({ queue: 'payments' })] });
    script.routeJsonRpcMethod('weft.tasks.get', ghostDeadLetter());
    script.routeJsonRpcMethod('weft.tasks.deliveries', { deliveries: [], droppedCount: 0 });
  }

  test('its ledger offers Retry, which names the attempt that was dead-lettered', async () => {
    scripted = new ScriptedFetch();
    routeUnlisted(scripted);
    scripted.routeJsonRpcMethod('weft.tasks.deadletters.retry', {
      ...RETRIED,
      operationId: 'op_ghost',
    });
    resetLocation('/health/workers?tab=diagnostics&task=op_ghost');
    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Retry this dead letter' }));
    expect(
      await findByText(/Queues ghost on queue ghost|Queues charge.* on queue ghost/),
    ).not.toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Retry task' }));
    await waitUntil(() => rpcParams(scripted!, 'weft.tasks.deadletters.retry').length === 1);

    expect(rpcParams(scripted, 'weft.tasks.deadletters.retry')).toEqual([
      { operationId: 'op_ghost', attemptTokenDigest: 'sha256:t2' },
    ]);
  });

  test('once retried, the ledger is read again and no longer offers a dead letter', async () => {
    scripted = new ScriptedFetch();
    routeUnlisted(scripted);
    scripted.routeJsonRpcMethod('weft.tasks.deadletters.retry', {
      ...RETRIED,
      operationId: 'op_ghost',
    });
    resetLocation('/health/workers?tab=diagnostics&task=op_ghost');
    const { findByRole, queryByRole } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Retry this dead letter' }));
    scripted.routeJsonRpcMethod('weft.tasks.get', {
      ...taskLedgerDetailFixture(),
      operationId: 'op_ghost',
      queue: 'ghost',
      attempts: [DEAD_ATTEMPT],
    });
    await fireEvent.click(await findByRole('button', { name: 'Retry task' }));

    await waitUntil(() => queryByRole('button', { name: 'Retry this dead letter' }) === null);
    expect(rpcParams(scripted, 'weft.tasks.get').length).toBeGreaterThan(1);
  });

  test('Clear reaches it too, and the id is typed to confirm', async () => {
    scripted = new ScriptedFetch();
    routeUnlisted(scripted);
    let deleted = false;
    scripted.routeRest(
      (url, method) =>
        method === 'DELETE' && url.pathname === '/api/v1/tasks/diagnostics/dead-letter/op_ghost',
      () => {
        deleted = true;
        return new Response(null, { status: 204 });
      },
    );
    resetLocation('/health/workers?tab=diagnostics&task=op_ghost');
    const { findByLabelText, findByRole } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Clear this dead letter' }));
    await fireEvent.input(await findByLabelText(/Type "op_ghost" to confirm/i), {
      target: { value: 'op_ghost' },
    });
    await fireEvent.click(await findByRole('button', { name: 'Clear dead letter' }));

    await waitUntil(() => deleted);
  });

  test('a task dead-lettered again while the dialog was open is not retried', async () => {
    scripted = new ScriptedFetch();
    routeUnlisted(scripted);
    resetLocation('/health/workers?tab=diagnostics&task=op_ghost');
    const { findByRole, findByText, queryClient } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Retry this dead letter' }));
    scripted.routeJsonRpcMethod(
      'weft.tasks.get',
      ghostDeadLetter({
        attempt: 3,
        attempts: [{ ...DEAD_ATTEMPT, attempt: 3, attemptTokenDigest: 'sha256:t3' }],
      }),
    );
    await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail('op_ghost') });
    await fireEvent.click(await findByRole('button', { name: 'Retry task' }));

    expect(await findByText(/That dead letter was cleared, retried or changed/)).not.toBeNull();
    expect(rpcParams(scripted, 'weft.tasks.deadletters.retry')).toEqual([]);
  });
});

describe('Workers route — Diagnostics tab', () => {
  test('renders DiagnosticsView with the fetched items and summary', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      diagnosticsItems: [diagnosticItem({ kind: 'retry-storm', queue: 'payments' })],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, retryStorms: 1 },
    });
    scripted.routeJsonRpcMethod('weft.tasks.get', {
      ...taskLedgerDetailFixture(),
      operationId: 'op_dead_1',
    });

    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('tab', { name: 'Diagnostics' }));
    expect(await findByText('Retry storm')).not.toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Inspect ledger' }));
    expect(await findByText('Authoritative task ledger')).not.toBeNull();
  });

  test('a heartbeat 60–120s old reads stale in task detail, as it does in the diagnostics row', async () => {
    const now = Date.now();
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      diagnosticsItems: [diagnosticItem({ kind: 'stale-inflight', queue: 'payments' })],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, staleInflight: 1 },
    });
    scripted.routeJsonRpcMethod('weft.tasks.get', {
      ...taskLedgerDetailFixture(),
      operationId: 'op_dead_1',
      state: 'leased',
      availableAt: undefined,
      leaseDeadline: now + 20_000,
      startedAt: now - 120_000,
      lastHeartbeatAt: now - 90_000,
    });

    const { container, findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('tab', { name: 'Diagnostics' }));
    await fireEvent.click(await findByRole('button', { name: 'Inspect ledger' }));
    expect(await findByText('Authoritative task ledger')).not.toBeNull();
    const heartbeat = container.querySelector<HTMLElement>('[data-clock="heartbeat"]');
    expect(heartbeat?.textContent).not.toContain('Fresh');
    expect(heartbeat?.textContent).toContain(
      `Stale after ${TASK_HEARTBEAT_STALE_AFTER_MS / 60_000}m without a heartbeat.`,
    );
    expect(DEFAULT_TASK_DIAGNOSTICS_INPUT.staleHeartbeatAfterMs).toBe(
      TASK_HEARTBEAT_STALE_AFTER_MS,
    );
  });

  test('a zeroed summary renders the "No diagnostics" empty state', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);

    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('tab', { name: 'Diagnostics' }));
    expect(await findByText('No diagnostics')).not.toBeNull();
  });
});

describe('Workers route — loading skeletons', () => {
  test('the Workers tab shows a loading skeleton before the workers query resolves', () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);

    const { getByLabelText } = render(WorkersRouteTestHarness, {
      props: {
        client: realClient(),
        queryClient: createQueryClient(),
        component: WorkersRoute,
        principalScopes: ['system:read', 'system:admin'],
      },
    });

    // Synchronous assertion, before any awaited microtask lets the
    // scripted fetch's response settle — this is the one moment
    // `fleetLoading` is true.
    expect(getByLabelText('Loading fleet')).not.toBeNull();
  });

  test('the Diagnostics tab shows a loading skeleton before the diagnostics query resolves', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    // Only the filtered read is deferred: the page waits for the unfiltered diagnostics before it
    // shows its tabs (`index-in-process.test.ts`), and a provenance filter is a second read of its own.
    // Deferred, not routed, so the response stays pending through the awaits below instead of being
    // processed by TanStack Query during `findByRole`/`fireEvent.click`'s microtasks.
    const diagnosticsGate = scripted.deferJsonRpcMethod(
      'weft.tasks.diagnostics',
      (params) => params['workerId'] !== undefined,
    );
    resetLocation('/health/workers?tab=diagnostics&workerId=worker-1');

    const { findByLabelText } = render(WorkersRouteTestHarness, {
      props: {
        client: realClient(),
        queryClient: createQueryClient(),
        component: WorkersRoute,
        principalScopes: ['system:read', 'system:admin'],
      },
    });

    expect(await findByLabelText('Loading diagnostics')).not.toBeNull();
    diagnosticsGate.resolve({ items: [], summary: EMPTY_DIAGNOSTICS_SUMMARY });
  });
});
