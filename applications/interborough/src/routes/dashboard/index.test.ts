/**
 * Component tests for the Dashboard route's page-level state machine
 * (default/loading/empty/unreachable, plan §9.1, Appendix B). Uses a real
 * `HttpClient` scripted at the `fetch` layer (`./dashboard-test-support.
 * test-support.ts`) rather than the real in-process test server — see that
 * module's doc for why `client.operations[...]` (JSON-RPC) needs this
 * instead.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { router } from '../../lib/router.svelte.ts';
import DashboardIndexHarness from './dashboard-index-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './dashboard-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

describe('Dashboard', () => {
  test('is the engine’s page: one level-1 heading, Engine', async () => {
    scripted = new ScriptedFetch();
    scripted.routeUrlStatus('/v1/health', 503);

    const { findByRole, queryByText } = render(DashboardIndexHarness, {
      props: { client: realClient() },
    });

    expect((await findByRole('heading', { level: 1 })).textContent).toBe('Engine');
    expect(queryByText('Operations overview')).toBeNull();
    expect(queryByText(/Cross-domain/)).toBeNull();
  });

  test('shows the unreachable state when the health probe fails', async () => {
    scripted = new ScriptedFetch();
    scripted.routeUrlStatus('/v1/health', 503);
    const client = realClient();

    const { getByText } = render(DashboardIndexHarness, { props: { client } });

    await waitFor(() => expect(getByText('Server unreachable')).not.toBeNull());
    expect(getByText('The health probe failed to respond.')).not.toBeNull();
  });

  test('shows the onboarding empty state when the workflow status aggregate totals zero', async () => {
    scripted = new ScriptedFetch();
    scripted.routeUrl('/v1/health', { status: 'ok' });
    scripted.routeJsonRpcMethod('weft.workflows.aggregate', {
      total: 0,
      groups: [],
      truncated: false,
    });
    const client = realClient();

    const { getByText } = render(DashboardIndexHarness, { props: { client } });

    await waitFor(() => expect(getByText('No runs yet')).not.toBeNull());
    expect(
      getByText('Runs from chats, schedules, and workflows show up here once one has started.'),
    ).not.toBeNull();
    expect(getByText('Start a run')).not.toBeNull();
  });

  test('renders the three bands with real counts once health and aggregate data resolve', async () => {
    scripted = new ScriptedFetch();
    scripted.routeUrl('/v1/health', { status: 'ok' });
    scripted.routeJsonRpcMethod('weft.workflows.aggregate', {
      total: 12,
      groups: [
        { key: 'running', count: 9 },
        { key: 'failed', count: 3 },
      ],
      truncated: false,
    });
    scripted.routeJsonRpcMethod('weft.tasks.diagnostics', {
      items: [],
      summary: {
        stuckQueued: 0,
        staleInflight: 0,
        retryStorms: 0,
        allWorkersAtCapacity: 0,
        deadLettered: 0,
        delayed: 0,
        unadoptedTerminal: 0,
      },
      limit: 50,
    });
    scripted.routeUrl('/reviews', { items: [] });
    const client = realClient();

    const { getByText, getAllByText, queryByText } = render(DashboardIndexHarness, {
      props: { client },
    });

    await waitFor(() => expect(getByText('Runs by status')).not.toBeNull());
    expect(getAllByText('9').length).toBeGreaterThan(0);
    expect(getByText('Recent activity')).not.toBeNull();
    // Each status opens the runs list on a state it has, and a modified click is the browser's.
    const failed = getByText('Failed').closest('a') as HTMLAnchorElement;
    expect(failed.getAttribute('href')).toBe('/runs?status=failed');
    expect(getByText('View all →').closest('a')?.getAttribute('href')).toBe('/runs');
    expect(await fireEvent.click(failed, { button: 0, metaKey: true })).toBe(true);
    expect(await fireEvent.click(failed, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/runs');
    expect(router.search.get('status')).toBe('failed');
    // The engine runs its work in-process, so no card counts remote workers, and failures are one
    // count among the statuses rather than a chart of their own.
    expect(queryByText('Failures by category')).toBeNull();
    expect(queryByText('Workers')).toBeNull();
  });

  // COR-124 admits a critical-alerts chip only when it is backed by
  // `weft.workers.diagnostics` or `weft.tasks.get` fields. Engine lease health
  // lives on the System route's Health & lease tab, so even a contested
  // `weft.system.lease` never reaches the band, and the Dashboard never asks.
  test('never shows or requests a weft.system.lease chip, even when the lease is contested', async () => {
    scripted = new ScriptedFetch();
    scripted.routeUrl('/v1/health', { status: 'ok' });
    scripted.routeJsonRpcMethod('weft.workflows.aggregate', {
      total: 1,
      groups: [{ key: 'running', count: 1 }],
      truncated: false,
    });
    scripted.routeJsonRpcMethod('weft.tasks.diagnostics', {
      items: [],
      summary: {
        stuckQueued: 0,
        staleInflight: 0,
        retryStorms: 0,
        allWorkersAtCapacity: 0,
        deadLettered: 2,
        delayed: 0,
        unadoptedTerminal: 0,
      },
      limit: 50,
    });
    scripted.routeUrl('/reviews', { items: [] });
    scripted.routeJsonRpcMethod('weft.system.lease', {
      mode: 'lease',
      status: 'contested',
      holdsLease: false,
      lossReason: 'deposed',
    });
    const client = realClient();

    const { findByText, queryByText } = render(DashboardIndexHarness, { props: { client } });

    await findByText('2 dead-lettered tasks', undefined, { timeout: 3_000 });
    expect(queryByText(/lease contested/i)).toBeNull();
    const requestBodies = scripted.calls.map((call) =>
      typeof call.init?.body === 'string' ? call.init.body : '',
    );
    expect(requestBodies.some((body) => body.includes('weft.system.lease'))).toBe(false);
  });
});
