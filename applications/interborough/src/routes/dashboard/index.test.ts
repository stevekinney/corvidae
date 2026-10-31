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
  test('is the engine’s page: one level-1 heading, Health', async () => {
    scripted = new ScriptedFetch();
    scripted.routeUrlStatus('/v1/health', 503);

    const { findByRole, queryByText } = render(DashboardIndexHarness, {
      props: { client: realClient() },
    });

    const heading = await findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Health');
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
      total: 27,
      groups: [
        { key: 'running', count: 9 },
        { key: 'pending', count: 1 },
        { key: 'suspended', count: 2 },
        { key: 'completed', count: 5 },
        { key: 'cancelled', count: 3 },
        { key: 'failed', count: 3 },
        { key: 'timed-out', count: 4 },
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
    // Each status opens the engine's own run list on that status, in the engine's own word, and a
    // modified click is the browser's. None goes to the Bureau's `/runs`.
    const targets: Readonly<Record<string, string>> = {
      Running: '/health/runs?status=running',
      Pending: '/health/runs?status=pending',
      Suspended: '/health/runs?status=suspended',
      Completed: '/health/runs?status=completed',
      Cancelled: '/health/runs?status=cancelled',
      Failed: '/health/runs?status=failed',
      'Timed out': '/health/runs?status=timed-out',
    };
    for (const [label, target] of Object.entries(targets)) {
      expect(getByText(label).closest('a')?.getAttribute('href'), label).toBe(target);
    }
    for (const link of document.querySelectorAll('a')) {
      expect(link.getAttribute('href')?.startsWith('/runs?status='), link.outerHTML).toBe(false);
    }
    const failed = getByText('Failed').closest('a') as HTMLAnchorElement;
    expect(getByText('View all →').closest('a')?.getAttribute('href')).toBe('/health/runs');
    expect(await fireEvent.click(failed, { button: 0, metaKey: true })).toBe(true);
    expect(await fireEvent.click(failed, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/health/runs');
    expect(router.search.get('status')).toBe('failed');
    // The engine runs its work in-process, so no card counts remote workers, and failures are one
    // count among the statuses rather than a chart of their own.
    expect(queryByText('Failures by category')).toBeNull();
    // The one mention of workers is the link to their page, beside the heading.
    expect(getByText('Workers').closest('nav')?.getAttribute('aria-label')).toBe('Health sections');
  });

  test('links the engine’s other pages beside its heading, each opened in place', async () => {
    scripted = new ScriptedFetch();
    scripted.routeUrlStatus('/v1/health', 503);

    const { findByRole } = render(DashboardIndexHarness, { props: { client: realClient() } });

    const sections = await findByRole('navigation', { name: 'Health sections' });
    const links = Array.from(sections.querySelectorAll('a')).map((link) => [
      link.textContent?.trim(),
      link.getAttribute('href'),
    ]);
    expect(links).toEqual([
      ['Workers', '/health/workers'],
      ['Storage', '/health/storage'],
      ['Audit log', '/health/audit'],
    ]);
    const audit = sections.querySelector('a[href="/health/audit"]') as HTMLAnchorElement;
    expect(await fireEvent.click(audit, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/health/audit');
  });

  // COR-124 admits a critical-alerts chip only when it is backed by
  // `weft.workers.diagnostics` or `weft.tasks.get` fields. Engine lease health
  // lives on the Health tab of the Health page's diagnostics, so even a contested
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

    await findByText('2 dead-lettered tasks', undefined);
    expect(queryByText(/lease contested/i)).toBeNull();
    const requestBodies = scripted.calls.map((call) =>
      typeof call.init?.body === 'string' ? call.init.body : '',
    );
    expect(requestBodies.some((body) => body.includes('weft.system.lease'))).toBe(false);
  });
});
