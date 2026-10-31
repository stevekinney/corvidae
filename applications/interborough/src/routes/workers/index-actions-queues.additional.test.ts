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
