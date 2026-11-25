import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window, type DetachedWindowAPI } from 'happy-dom';

import type { WorkflowSummary } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';
import { fireEvent, render, waitFor } from '@testing-library/svelte';

import { router } from '../../../lib/router.svelte.ts';
import type { Principal } from '../../../lib/scopes.svelte.ts';
import WorkflowListHarness from './workflow-list.test-harness.svelte';
import {
  parseJsonObject,
  realClient,
  ScriptedFetch,
} from './workflow-test-support.test-support.ts';

function latestListInput(script: ScriptedFetch): unknown {
  const call = script.calls.findLast(
    (entry) =>
      typeof entry.init?.body === 'string' && entry.init.body.includes('weft.workflows.list'),
  );
  const body = typeof call?.init?.body === 'string' ? parseJsonObject(call.init.body) : undefined;
  return body?.['params'];
}

/**
 * happy-dom's default `window.location` is `about:blank` (no origin), and
 * `history.pushState`/`replaceState` are silent no-ops from a
 * non-hierarchical origin — every test below navigates the real `router`
 * singleton, so it needs a real origin first. Same convention as
 * `src/lib/router.svelte.test.ts`.
 */
function happyDomAPI(): DetachedWindowAPI {
  if (!(window instanceof Window)) {
    throw new Error('expected the test window to be backed by happy-dom');
  }
  return window.happyDOM;
}

function resetLocation(path = '/health/runs'): void {
  happyDomAPI().setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

const GRANTED_PRINCIPAL: Principal = {
  scopes: ['workflows:read', 'workflows:write'],
  unauthenticatedAccess: null,
};

function summary(overrides: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    id: 'wf_4a9f1234567890abcdef2c10',
    type: 'order-processing',
    status: 'running',
    version: '1',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 1_000,
    ...overrides,
  };
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

let fetchScript: ScriptedFetch;

beforeEach(() => {
  fetchScript = new ScriptedFetch();
  resetLocation();
});

afterEach(() => {
  fetchScript.restore();
});

describe('WorkflowList', () => {
  // This test navigates the shared `router` singleton to a URL carrying a
  // query string (`?status=failed`), unlike every other test below (plain
  // `/runs`). Ordered FIRST in the file: Svelte's dev-mode batch
  // flush walks every historical reactive consumer of a shared external
  // `$state` source (here, `router`) on each mutation, including deriveds
  // from components unmounted by EARLIER tests in this same process (a
  // real page load never remounts against the same long-lived module
  // instance the way a same-process test file does) — enough accumulated
  // unmounted consumers plus a further `router.navigate()` call trips a
  // harmless `derived_inert` advisory warning (confirmed via a reproduction
  // harness: identical assertions, zero incorrect values, only the ORDER
  // of tests changes whether the dev warning fires). Running the only
  // query-string navigation first keeps this file warning-free without
  // touching the frozen `router.svelte.ts` singleton.
  test('shows the "no workflows match" empty state when a filter is active and nothing matches', async () => {
    resetLocation('/health/runs?status=failed');
    fetchScript.routeJsonRpcMethod('weft.workflows.list', {
      items: [],
      total: 0,
      offset: 0,
      limit: 50,
    });

    const { findByText } = render(WorkflowListHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    expect(await findByText('No workflows match')).not.toBeNull();
  });

  test('correlates provenance by the visible filtered-page id, not a newest-runs page', async () => {
    resetLocation('/health/runs?offset=50');
    const visibleId = 'wf_older_agent_run';
    fetchScript.routeJsonRpcMethod('weft.workflows.list', {
      items: [summary({ id: visibleId, status: 'running', tags: ['origin:agent-run'] })],
      total: 51,
      offset: 50,
      limit: 50,
    });
    fetchScript.routeJsonRpcMethod('bureau.workflows.runs.get', {
      id: visibleId,
      workflow: 'order-processing',
      workflowVersion: 'sha256:older',
      status: 'running',
      createdAt: '2026-10-31T11:26:19.437Z',
      updatedAt: '2026-10-31T11:26:20.437Z',
      trigger: { kind: 'signal', name: 'e2e-begin' },
      origin: { kind: 'agent-run', runId: 'calling-run-older', agentId: 'assistant' },
    });

    const { getByRole, container } = render(WorkflowListHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    await waitFor(() => expect(container.textContent).toContain('order-processing'));
    await waitFor(() => expect(container.textContent).toContain("An agent's tool call, assistant"));
    expect(
      fetchScript.calls.some(
        (call) => typeof call.init?.body === 'string' && call.init.body.includes('runs.get'),
      ),
    ).toBe(true);
    expect(getByRole('link', { name: 'Calling run' }).getAttribute('href')).toBe(
      '/runs/calling-run-older',
    );
    expect(
      fetchScript.calls.filter(
        (call) => typeof call.init?.body === 'string' && call.init.body.includes('runs.list'),
      ),
    ).toHaveLength(0);
  });

  test('renders the table once the list query resolves', async () => {
    fetchScript.routeJsonRpcMethod('weft.workflows.list', {
      items: [summary()],
      total: 1,
      offset: 0,
      limit: 50,
    });

    const { findAllByText } = render(WorkflowListHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    // A cut type is also the text of its tooltip, so the name is found more than once.
    expect(await findAllByText('order-processing')).not.toHaveLength(0);
  });

  test('rows across several types issue one active-pointer fetch per distinct type and render the comparison badges (COR-15)', async () => {
    fetchScript.routeJsonRpcMethod('weft.workflows.list', {
      items: [
        summary({ id: 'wf_a1', type: 'order-processing', revision: 'rev-current' }),
        summary({ id: 'wf_a2', type: 'order-processing', revision: 'rev-old' }),
        summary({ id: 'wf_b1', type: 'payment-failing', revision: 'rev-pay' }),
        summary({ id: 'wf_b2', type: 'payment-failing', revision: 'rev-pay' }),
        summary({ id: 'wf_legacy', type: 'payment-failing' }),
      ],
      total: 5,
      offset: 0,
      limit: 50,
    });
    fetchScript.routeJsonRpcMethod('weft.workflows.active.get', {
      revision: 'rev-current',
      generation: 1,
      activatedAt: 1,
    });

    const { findAllByText } = render(WorkflowListHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    // order-processing: rev-current matches the (shared) scripted pointer,
    // rev-old does not; payment-failing's two pinned rows both differ from
    // it; the legacy row carries no revision and so gets no badge.
    expect(await findAllByText('Differs from active')).toHaveLength(3);
    expect(await findAllByText('Active')).toHaveLength(1);
    const activeCalls = fetchScript.calls.filter(
      (call) => typeof call.init?.body === 'string' && call.init.body.includes('active.get'),
    );
    expect(activeCalls).toHaveLength(2);
  });

  test('filtering from a later page requests and renders the first filtered page', async () => {
    resetLocation('/health/runs?offset=50');
    fetchScript.enqueueJson({
      jsonrpc: '2.0',
      id: 1,
      result: {
        items: [summary({ id: 'wf_later_page', type: 'later-page-workflow' })],
        total: 51,
        offset: 50,
        limit: 50,
      },
    });
    fetchScript.enqueueJson({
      jsonrpc: '2.0',
      id: 1,
      result: {
        items: [
          summary({ id: 'wf_first_filtered', type: 'first-filtered-workflow', status: 'failed' }),
        ],
        total: 1,
        offset: 0,
        limit: 50,
      },
    });

    const { findAllByText, getByRole } = render(WorkflowListHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    expect(await findAllByText('later-page-workflow')).not.toHaveLength(0);
    await fireEvent.click(getByRole('button', { name: 'Failed' }));

    expect(await findAllByText('first-filtered-workflow')).not.toHaveLength(0);
    await waitFor(() => {
      expect(latestListInput(fetchScript)).toMatchObject({ offset: 0, status: 'failed' });
    });
  });

  test('lists every type the engine holds in the status the address names, and stays at the engine list', async () => {
    resetLocation('/health/runs?status=failed');
    fetchScript.routeJsonRpcMethod('weft.workflows.list', {
      items: [
        summary({ id: 'wf_failed_a', type: 'payment-failing', status: 'failed' }),
        summary({ id: 'wf_failed_b', type: 'order-processing', status: 'failed' }),
      ],
      total: 2,
      offset: 0,
      limit: 50,
    });

    const { findAllByText, getByRole } = render(WorkflowListHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    expect(await findAllByText('payment-failing')).not.toHaveLength(0);
    expect(await findAllByText('order-processing')).not.toHaveLength(0);
    expect(getByRole('heading', { level: 1 }).textContent).toBe('Workflow runs');
    expect(latestListInput(fetchScript)).toMatchObject({ status: 'failed' });
    expect(latestListInput(fetchScript)).not.toHaveProperty('type');

    await fireEvent.click(getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(router.search.getAll('status').sort()).toEqual(['completed', 'failed']),
    );
    expect(router.pathname).toBe('/health/runs');
  });

  test('an address carrying Failed at step and Retrying sends both to Weft’s list, opens the builder on them, and counts them (COR-2535)', async () => {
    resetLocation('/health/runs?status=failed&failed_step=charge-card&retrying=false');
    fetchScript.routeJsonRpcMethod('weft.workflows.list', {
      items: [summary({ id: 'wf_charge_failed', type: 'order-processing', status: 'failed' })],
      total: 1,
      offset: 0,
      limit: 50,
    });

    const { findAllByText, getByDisplayValue, getByRole } = render(WorkflowListHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    expect(await findAllByText('order-processing')).not.toHaveLength(0);
    expect(latestListInput(fetchScript)).toMatchObject({
      failedStep: 'charge-card',
      retrying: false,
      status: 'failed',
    });
    // The builder opens on the two conditions, and its toggle counts them.
    expect(getByDisplayValue('charge-card')).not.toBeNull();
    expect(getByRole('button', { name: /Search attributes\s*2/ })).not.toBeNull();
  });

  test('shows the "no workflows yet" empty state when the list is empty and no filter is active', async () => {
    fetchScript.routeJsonRpcMethod('weft.workflows.list', {
      items: [],
      total: 0,
      offset: 0,
      limit: 50,
    });

    const { findByText } = render(WorkflowListHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    expect(await findByText('No workflows yet')).not.toBeNull();
  });

  test('shows the denied lock state without workflows:read', async () => {
    const { findByText } = render(WorkflowListHarness, {
      props: {
        client: realClient(),
        principal: { scopes: [], unauthenticatedAccess: null },
        queryClient: newQueryClient(),
      },
    });

    expect(await findByText('Access restricted')).not.toBeNull();
  });

  test('shows a fault banner when the list request fails', async () => {
    fetchScript.routeUrlStatus('/jsonrpc', 500);

    const { findByText } = render(WorkflowListHarness, {
      props: { client: realClient(), principal: GRANTED_PRINCIPAL, queryClient: newQueryClient() },
    });

    expect(await findByText('Couldn’t load workflows')).not.toBeNull();
  });
});
