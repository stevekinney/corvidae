/**
 * The Workers route when a read fails or a list narrows to nothing: a failed list is a fault with
 * Retry (never an empty state), a filtered Diagnostics list with nothing in it clears its filters,
 * a refused drain can be dismissed, and a diagnostic on an open worker opens that task's ledger.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { createQueryClient, queryKeys } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  diagnosticItem,
  EMPTY_DIAGNOSTICS_SUMMARY,
  routeHappyPaths,
  worker,
} from './index-actions.test-support.ts';
import WorkersRoute from './index.svelte';
import WorkersRouteTestHarness from './workers-route-test-harness.test-harness.svelte';
import {
  realClient,
  ScriptedFetch,
  taskLedgerDetailFixture,
} from './workers-route-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

function resetLocation(path = '/health/workers'): void {
  if (!(window instanceof Window)) throw new Error('expected the test window to be happy-dom');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => resetLocation());
afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

function renderRoute() {
  const queryClient = createQueryClient();
  const view = render(WorkersRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient,
      component: WorkersRoute,
      principalScopes: ['system:read', 'system:admin'],
    },
  });
  return { ...view, queryClient };
}

describe('Workers route — a read that failed', () => {
  test('the Workers tab shows the fault with Retry, and Retry reads the fleet again', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_back' })] });
    scripted.routeJsonRpcMethodError(
      'weft.workers.list',
      401,
      'authentication required',
      'Unauthorized',
    );

    const view = renderRoute();

    expect(await view.findByText('Not authorized')).not.toBeNull();
    scripted.routeJsonRpcMethod('weft.workers.list', {
      items: [worker({ id: 'wkr_back' })],
      deployments: [],
      routingPolicy: 'least-loaded',
    });
    await fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
    const summary = await view.findByTestId('workers-summary');
    expect(summary.textContent).toContain('1 of 1 connected');
  });

  test('the Task queues tab shows its fault with Retry', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    scripted.routeJsonRpcMethodError(
      'weft.task.queues.list',
      401,
      'authentication required',
      'Unauthorized',
    );

    const view = renderRoute();
    await fireEvent.click(await view.findByRole('tab', { name: 'Task queues' }));

    expect(await view.findByText('Not authorized')).not.toBeNull();
    scripted.routeJsonRpcMethod('weft.task.queues.list', { items: [] });
    await fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
    expect(await view.findByRole('tab', { name: 'Task queues', selected: true })).not.toBeNull();
  });
});

describe('Workers route — a task ledger that failed to read', () => {
  test('shows the fault with Retry, and Retry reads the ledger again', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    scripted.routeJsonRpcMethodError(
      'weft.tasks.get',
      401,
      'authentication required',
      'Unauthorized',
    );
    resetLocation('/health/workers?tab=diagnostics&task=op_1');

    const view = renderRoute();

    expect(await view.findByText('Not authorized')).not.toBeNull();
    scripted.routeJsonRpcMethod('weft.tasks.get', {
      ...taskLedgerDetailFixture(),
      operationId: 'op_1',
    });
    await fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
    expect(await view.findByText('Authoritative task ledger')).not.toBeNull();
  });
});

describe('Workers route — Diagnostics', () => {
  test('a filter that matches nothing offers to clear the filters, and clearing them drops them from the address', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    resetLocation('/health/workers?tab=diagnostics&buildId=no-such-build');

    const view = renderRoute();

    await fireEvent.click(await view.findByRole('button', { name: 'Clear filters' }));
    expect(router.search.get('buildId')).toBeNull();
    expect(router.search.get('tab')).toBe('diagnostics');
  });
});

describe('Workers route — an open worker', () => {
  test('a diagnostic for the worker opens that task’s ledger in the Diagnostics tab', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [worker({ id: 'wkr_busy' })],
      diagnosticsItems: [diagnosticItem({ operationId: 'op_dead_9', workerId: 'wkr_busy' })],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
    });
    resetLocation('/health/workers?worker=wkr_busy');

    const view = renderRoute();

    await fireEvent.click(await view.findByRole('button', { name: 'Inspect ledger' }));
    expect(router.search.get('tab')).toBe('diagnostics');
    expect(router.search.get('task')).toBe('op_dead_9');
  });

  test('a refused drain can be dismissed', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_moving' })] });
    resetLocation('/health/workers?worker=wkr_moving');

    const view = renderRoute();
    await fireEvent.click(await view.findByRole('button', { name: 'Drain' }));
    const confirm = await view.findByRole('button', { name: 'Drain worker' });
    scripted.routeJsonRpcMethod('weft.workers.list', {
      items: [worker({ id: 'wkr_moving', health: 'draining' })],
      deployments: [],
      routingPolicy: 'least-loaded',
    });
    await view.queryClient.invalidateQueries({ queryKey: queryKeys.workers.list() });
    await fireEvent.click(confirm);

    expect(await view.findByText(/That worker changed while the dialog was open/)).not.toBeNull();
    await fireEvent.click(await view.findByRole('button', { name: /dismiss/i }));
    expect(view.queryByText(/That worker changed while the dialog was open/)).toBeNull();
  });
});
