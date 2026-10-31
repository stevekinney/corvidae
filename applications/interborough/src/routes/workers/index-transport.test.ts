/**
 * The Workers route across both worker transports (COR-160): a long-poll
 * worker appears in the one fleet and brings its limitation notice, a worker
 * that is no longer registered reads as closed, and conformance is its own tab.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import { routeHappyPaths, worker } from './index-actions.test-support.ts';
import WorkersRoute from './index.svelte';
import WorkersRouteTestHarness from './workers-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './workers-route-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

function resetLocation(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => resetLocation('/health/workers'));
afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

function renderRoute() {
  return render(WorkersRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: WorkersRoute,
      principalScopes: ['system:read', 'system:admin'],
    },
  });
}

describe('Workers route — transports', () => {
  test('a long-poll worker in the fleet brings the long-poll limitation notice; a WebSocket-only fleet does not', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [
        worker({ id: 'wkr_ws', transport: 'websocket' }),
        worker({ id: 'wkr_lp', transport: 'long-poll' }),
      ],
    });
    const mixed = renderRoute();
    expect(await mixed.findByText(/1 worker uses the HTTP long-poll transport\./)).not.toBeNull();
    mixed.unmount();
    scripted.restore();

    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_ws', transport: 'websocket' })] });
    const socketOnly = renderRoute();
    expect(await socketOnly.findByTestId('workers-summary')).not.toBeNull();
    expect(socketOnly.queryByText(/HTTP long-poll workers have no server push/)).toBeNull();
  });

  test('a selected worker the server no longer lists reads as closed, not as an error', async () => {
    resetLocation('/health/workers?worker=wkr_gone');
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker({ id: 'wkr_other' })] });

    const { findByText, getByRole } = renderRoute();

    expect(await findByText('Worker closed')).not.toBeNull();
    expect(await findByText(/No worker with the ID wkr_gone is registered/)).not.toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Back to all workers' }));
    expect(router.search.get('worker')).toBeNull();
  });

  test('conformance is its own tab with its own target list', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    scripted.routeJsonRpcMethod('weft.conformance.targets', { targets: [] });

    const { findByRole, findByText } = renderRoute();
    await fireEvent.click(await findByRole('tab', { name: 'Conformance' }));

    expect(await findByText('No conformance targets')).not.toBeNull();
    expect(router.search.get('tab')).toBe('conformance');
  });

  test('deployments are their own tab, fed the fleet list so builds show their workers', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [worker({ id: 'wkr_b1', deploymentName: 'billing', buildId: 'build-1' })],
    });
    scripted.routeJsonRpcMethodBy('weft.worker.deployments.diagnostics', () => ({
      versions: [
        {
          deploymentName: 'billing',
          buildId: 'build-1',
          artifactDigest: 'sha256:a',
          manifestDigest: 'sha256:m',
          state: 'ready',
          firstSeenAt: 1,
          executionReferences: 0,
          manifest: { deployment: {}, workflows: {} },
        },
      ],
      routing: null,
    }));

    const { findByRole, findByText } = renderRoute();
    await fireEvent.click(await findByRole('tab', { name: 'Deployments' }));

    expect(await findByText('build-1')).not.toBeNull();
    expect(await findByText(/1 worker · 1\/4 in flight/)).not.toBeNull();
    expect(router.search.get('tab')).toBe('deployments');
  });
});
