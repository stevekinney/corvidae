/**
 * Component tests for the Dashboard route's page-level state machine
 * (default/loading/empty/unreachable, plan §9.1, Appendix B). Uses a real
 * `HttpClient` scripted at the `fetch` layer (`./dashboard-test-support.
 * test-support.ts`) rather than the real in-process test server — see that
 * module's doc for why `client.operations[...]` (JSON-RPC) needs this
 * instead.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
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

  test('renders the health line, four counts and recent activity once health and aggregate data resolve', async () => {
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

    const { findByRole, getByText, queryByText } = render(DashboardIndexHarness, {
      props: { client },
    });

    await waitFor(() => expect(getByText('Working now')).not.toBeNull());
    expect(getByText('Recent activity')).not.toBeNull();
    // The four counts, each a link that opens the list it counted.
    const counts = await findByRole('navigation', { name: 'Health counts' });
    const links = Array.from(counts.querySelectorAll('a')).map((link) => [
      link.querySelector('.weft-health-count__label')?.textContent,
      link.getAttribute('href'),
    ]);
    expect(links.map(([label]) => label)).toEqual([
      'Working now',
      'Needs you',
      'Failed in 24h',
      'Schedules',
    ]);
    const hrefs = Object.fromEntries(links as [string, string][]);
    // Working now counts the running runs, and opens the engine's list on that status, in the
    // engine's own word. None goes to the Bureau's `/runs`.
    expect(hrefs['Working now']).toBe('/health/runs?status=running');
    expect(within(counts).getByRole('link', { name: /^Working now\s+9$/ })).not.toBeNull();
    // Failed in 24h counts failed and timed-out runs that changed in the last day, and its link
    // carries the same filter, so the list holds as many runs as the count says.
    const failedHref = new URL(hrefs['Failed in 24h'] ?? '', 'http://localhost');
    expect(failedHref.pathname).toBe('/health/runs');
    expect(failedHref.searchParams.getAll('status')).toEqual(['failed', 'timed-out']);
    expect(Number(failedHref.searchParams.get('updated_at_gte'))).toBeGreaterThan(
      Date.now() - 25 * 60 * 60 * 1000,
    );
    expect(hrefs['Needs you']).toBe('/reviews');
    expect(hrefs['Schedules']).toBe('/schedules?status=active');
    for (const link of document.querySelectorAll('a')) {
      expect(link.getAttribute('href')?.startsWith('/runs?status='), link.outerHTML).toBe(false);
    }
    const failed = counts.querySelector(`a[href="${hrefs['Failed in 24h']}"]`) as HTMLAnchorElement;
    expect(await fireEvent.click(failed, { button: 0, metaKey: true })).toBe(true);
    expect(await fireEvent.click(failed, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/health/runs');
    expect(router.search.getAll('status')).toEqual(['failed', 'timed-out']);
    // The engine runs its work in-process, so no card counts remote workers, and the old
    // status card and its per-status cells are gone.
    expect(queryByText('Runs by status')).toBeNull();
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
