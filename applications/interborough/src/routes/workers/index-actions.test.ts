/**
 * Component tests for the Workers route root (`index.svelte`, plan §9.4)
 * covering the Workers list and its summary line, worker/queue selection via URL,
 * drain/resume mutations, dead-letter clearing, and loading skeletons.
 * Split out of `index.test.ts` (which owns the fault-title-mapping
 * regression coverage) purely to stay under this repo's `max-lines` lint
 * budget — both files exercise the same `index.svelte` route root and share
 * the same `ScriptedFetch`/harness support (`workers-route-test-support.test-support.ts`,
 * `workers-route-test-harness.test-harness.svelte`).
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window, type DetachedWindowAPI } from 'happy-dom';

import { createQueryClient, queryKeys } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import WorkersRoute from './index.svelte';
import WorkersRouteTestHarness from './workers-route-test-harness.test-harness.svelte';
import {
  openAdvanced,
  parseJsonObject,
  realClient,
  ScriptedFetch,
  workersTabs,
} from './workers-route-test-support.test-support.ts';

import { diagnosticsBody, NOW, routing, version } from './deployments-test-support.test-support.ts';
import {
  deployment,
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

/** The JSON-RPC calls made to `method`, with their parameters. */
function callsTo(script: ScriptedFetch, method: string): Record<string, unknown>[] {
  return script.calls.flatMap((call) => {
    if (typeof call.init?.body !== 'string') return [];
    const body = parseJsonObject(call.init.body);
    const params = body?.['params'];
    return body?.['method'] === method && params !== null && typeof params === 'object'
      ? [{ ...params }]
      : [];
  });
}

describe('Workers route — locked', () => {
  test('without system:read, the whole surface says it is locked and shows no tabs', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);

    const view = await renderWorkersRoute([]);

    expect(await view.findByText(/to read the workers/)).not.toBeNull();
    expect(workersTabs(view)).toHaveLength(0);
  });
});

describe('Workers route — the Workers list', () => {
  test('is the page itself, and its counts are one line, not four cards', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [
        worker({ id: 'wkr_listed', inFlight: 2 }),
        worker({ id: 'wkr_gone', health: 'drained', inFlight: 0 }),
      ],
      queues: [queue({ backlog: 12 })],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 2 },
    });

    const view = await renderWorkersRoute();
    const { findByTestId, queryByText } = view;

    const summary = await findByTestId('workers-summary');
    // A worker that finished draining is listed, but it no longer takes work.
    expect(summary.textContent).toBe(
      '1 of 2 connected · 2 running · 12 waiting · 2 failed for good',
    );
    // The page's own tab bar is behind Advanced, closed until an address asks for a tab.
    expect(workersTabs(view)).toHaveLength(0);
    expect(queryByText('Total workers')).toBeNull();
    expect(queryByText('Fleet overview')).toBeNull();
  });

  test('Advanced holds the Task queues, Deployments, Diagnostics and Conformance tabs', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);

    const view = await renderWorkersRoute();
    await openAdvanced(view);

    await waitFor(() =>
      expect(workersTabs(view).map((tab) => tab.textContent?.trim())).toEqual([
        'Task queues',
        'Deployments',
        'Diagnostics',
        'Conformance',
      ]),
    );
  });

  test('a worker is a row; choosing it opens its detail beside the list and writes it to the address', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_listed', queue: 'payments' })] });

    const { findByTestId, container } = await renderWorkersRoute();

    // The rows appear once the fleet has been read, which is when the summary does.
    await findByTestId('workers-summary');
    const row = container.querySelector<HTMLElement>('[data-worker-row="wkr_listed"]');
    expect(row).not.toBeNull();
    // A row is a link to the worker: the address is the selection.
    expect(row!.querySelector('a')?.getAttribute('href')).toContain('worker=wkr_listed');
    router.navigate('/health/workers?worker=wkr_listed');

    const detail = await findByTestId('worker-detail');
    expect(detail.textContent).toContain('payments');
    expect(router.search.get('worker')).toBe('wkr_listed');
  });

  test('an address that names a worker the server does not list says it closed, with the way back', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_listed' })] });

    resetLocation('/health/workers?worker=wkr_gone');
    const { findByText, findByRole } = await renderWorkersRoute();

    expect(await findByText('Worker closed')).not.toBeNull();
    expect(await findByText(/No worker with the ID wkr_gone/)).not.toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Back to all workers' }));
    expect(router.search.get('worker')).toBeNull();
  });
});

describe("Workers route — the open worker's evidence", () => {
  test("a failed registration-rejection read does not hide the open worker's manifest", async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_selected' })] });
    scripted.routeJsonRpcMethodError(
      'weft.workers.rejections',
      422,
      'rejection log unavailable',
      'invalid-request',
    );

    resetLocation('/health/workers?worker=wkr_selected&tab=queues');
    const { findByTestId, queryClient } = await renderWorkersRoute();

    const detail = await findByTestId('worker-technical-details');
    // Whichever the panel settles on first: the manifest read succeeded (the server has no manifest
    // for the worker), so it must say that and never the unrelated rejection read's fault.
    const rejectionFailed = () =>
      queryClient.getQueryState(queryKeys.workers.rejections())?.status === 'error';
    const panelSettled = () =>
      detail.textContent.includes('Worker no longer connected') ||
      detail.textContent.includes('rejection log unavailable');
    await waitUntil(() => rejectionFailed() && panelSettled(), {
      message: 'the rejection read to fail and the manifest panel to settle',
    });
    expect(detail.textContent).toContain('Worker no longer connected');
    expect(detail.textContent).not.toContain('rejection log unavailable');
  });
});

describe('Workers route — drain and resume from the worker detail', () => {
  test('Drain asks first, saying what happens to its work, and then calls weft.workers.drain', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [worker({ id: 'wkr_selected', queue: 'payments', health: 'active', inFlight: 3 })],
    });
    scripted.routeJsonRpcMethod('weft.workers.drain', { ok: true });

    resetLocation('/health/workers?worker=wkr_selected');
    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Drain this worker' }));
    expect(await findByText('Drain Wkr selected?')).not.toBeNull();
    expect(
      await findByText(
        'It finishes the 3 tasks it is running, takes no new ones, and then stops. New payments tasks wait until a payments worker connects.',
      ),
    ).not.toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Drain worker' }));

    // load-proof: the scripted JSON-RPC fetch resolves in memory, so the call is issued inside the click handler promise chain
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callsTo(scripted, 'weft.workers.drain')).toEqual([{ workerId: 'wkr_selected' }]);
  });

  test('cancelling the Drain confirmation drains nothing', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_selected', health: 'active' })] });
    scripted.routeJsonRpcMethod('weft.workers.drain', { ok: true });

    resetLocation('/health/workers?worker=wkr_selected');
    const { findByRole } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Drain this worker' }));
    await fireEvent.click(await findByRole('button', { name: 'Cancel' }));

    // load-proof: nothing is sent, so there is no event to wait for; one turn lets a stray call show.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callsTo(scripted, 'weft.workers.drain')).toEqual([]);
  });

  test('resuming a draining worker calls weft.workers.resume directly, no dialog', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_draining', health: 'draining' })] });
    scripted.routeJsonRpcMethod('weft.workers.resume', { ok: true });

    resetLocation('/health/workers?worker=wkr_draining');
    const { findByRole, queryByRole } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Resume this worker' }));

    // load-proof: the scripted JSON-RPC fetch resolves in memory, so the call is issued inside the click handler promise chain
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callsTo(scripted, 'weft.workers.resume')).toEqual([{ workerId: 'wkr_draining' }]);
    expect(queryByRole('dialog')).toBeNull();
  });

  test('a worker that finished draining reads Stopped and offers Forget alone', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_idle', health: 'drained' })] });

    resetLocation('/health/workers?worker=wkr_idle');
    const { findByRole, queryByRole } = await renderWorkersRoute();

    expect(await findByRole('button', { name: 'Forget this worker' })).not.toBeNull();
    expect(queryByRole('button', { name: 'Drain this worker' })).toBeNull();
    expect(queryByRole('button', { name: 'Resume this worker' })).toBeNull();
  });

  test('Forget asks first, then calls weft.workers.forget and leaves the worker’s page', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [worker({ id: 'wkr_gone', queue: 'reports', disconnectedAt: 1, inFlight: 0 })],
    });
    scripted.routeJsonRpcMethod('weft.workers.forget', { workerId: 'wkr_gone', forgotten: true });

    resetLocation('/health/workers?worker=wkr_gone');
    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Forget this worker' }));
    expect(await findByText('Forget Wkr gone?')).not.toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Forget worker' }));

    // load-proof: the scripted JSON-RPC fetch resolves in memory, so the call is issued inside the click handler promise chain
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callsTo(scripted, 'weft.workers.forget')).toEqual([{ workerId: 'wkr_gone' }]);
    await waitFor(() => expect(router.search.get('worker')).toBeNull());
  });

  test('a worker that changed while the drain dialog was open is not drained, and the refusal says so', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_moving', health: 'active' })] });
    scripted.routeJsonRpcMethod('weft.workers.drain', { ok: true });

    resetLocation('/health/workers?worker=wkr_moving');
    const { findByRole, findByText, queryClient } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Drain this worker' }));
    const confirm = await findByRole('button', { name: 'Drain worker' });

    // Someone else drains it first; the fleet is read again before the dialog is confirmed.
    scripted.routeJsonRpcMethod('weft.workers.list', {
      items: [worker({ id: 'wkr_moving', health: 'draining' })],
      deployments: [deployment()],
      routingPolicy: 'least-loaded',
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.workers.list() });
    await fireEvent.click(confirm);

    expect(await findByText(/That worker changed while the dialog was open/)).not.toBeNull();
    expect(callsTo(scripted, 'weft.workers.drain')).toEqual([]);
  });
});

describe('Workers route — a worker’s deployment', () => {
  const BILLING = [
    version('build-a', { firstSeenAt: NOW - 300 }),
    version('build-b', { firstSeenAt: NOW - 200 }),
  ];

  function routeBilling(script: ScriptedFetch): void {
    script.routeJsonRpcMethodBy('weft.worker.deployments.diagnostics', (params) =>
      diagnosticsBody(
        BILLING,
        params['deploymentName'] === undefined
          ? null
          : routing({ currentBuildId: 'build-a', generation: 7 }),
      ),
    );
  }

  test('shows the deployment’s routing in the worker detail, and drains the deployment by name', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [worker({ id: 'wkr_billing', deploymentName: 'billing', buildId: 'build-a' })],
      deployments: [deployment({ deploymentName: 'billing' })],
    });
    routeBilling(scripted);
    scripted.routeJsonRpcMethod('weft.worker.deployments.drain', { ok: true });

    resetLocation('/health/workers?worker=wkr_billing&tab=queues');
    const { findByRole, findByText } = await renderWorkersRoute();

    expect(await findByText('Current build')).not.toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Drain deployment' }));
    const dialog = await findByRole('dialog', { name: 'Drain deployment' });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Drain deployment' }));

    // load-proof: the scripted JSON-RPC fetch resolves in memory, so the call is issued inside the click handler promise chain
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callsTo(scripted, 'weft.worker.deployments.drain')).toEqual([
      { deploymentName: 'billing' },
    ]);
  });

  test('Resume deployment calls weft.worker.deployments.resume with the deployment’s name, with no dialog', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [worker({ id: 'wkr_billing', deploymentName: 'billing', buildId: 'build-a' })],
      deployments: [deployment({ deploymentName: 'billing' })],
    });
    routeBilling(scripted);
    scripted.routeJsonRpcMethod('weft.worker.deployments.resume', { ok: true });

    resetLocation('/health/workers?worker=wkr_billing&tab=queues');
    const { findByRole, queryByRole } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Resume deployment' }));

    await waitFor(() =>
      expect(callsTo(scripted, 'weft.worker.deployments.resume')).toEqual([
        { deploymentName: 'billing' },
      ]),
    );
    expect(queryByRole('dialog')).toBeNull();
  });

  test('Promote previews the move against the routing generation before anything is applied', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [worker({ id: 'wkr_billing', deploymentName: 'billing', buildId: 'build-a' })],
      deployments: [deployment({ deploymentName: 'billing' })],
    });
    routeBilling(scripted);
    scripted.routeJsonRpcMethod('weft.worker.deployments.preview', {
      valid: true,
      message: 'Routing targets are available.',
      currentGeneration: 7,
    });
    scripted.routeJsonRpcMethod('weft.worker.deployments.promote', {
      deploymentName: 'billing',
      currentBuildId: 'build-b',
      rampBasisPoints: 10_000,
      generation: 8,
      updatedAt: NOW,
    });

    resetLocation('/health/workers?worker=wkr_billing&tab=queues');
    const { findByRole, findByText } = await renderWorkersRoute();

    await fireEvent.click(await findByRole('button', { name: 'Promote' }));
    expect(await findByText('Routing targets are available.')).not.toBeNull();
    expect(callsTo(scripted, 'weft.worker.deployments.promote')).toEqual([]);

    await fireEvent.click(await findByRole('button', { name: 'Confirm promote build' }));
    // load-proof: the scripted JSON-RPC fetch resolves in memory, so the call is issued inside the click handler promise chain
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callsTo(scripted, 'weft.worker.deployments.promote')).toEqual([
      { deploymentName: 'billing', buildId: 'build-b', expectedGeneration: 7 },
    ]);
  });
});
