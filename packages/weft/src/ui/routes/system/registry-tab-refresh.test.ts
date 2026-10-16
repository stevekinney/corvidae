/**
 * `<RegistryTab>`'s registry query (COR-162 review): it goes through the
 * validated `loadRegistrySnapshot` loader, refreshes on the worker and
 * manifest queries' cadence, and keeps the last snapshot on screen when a
 * background refresh fails.
 */
import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { createQueryClient, queryKeys } from '../../lib/query.ts';
import RegistryTab from './registry-tab.svelte';
import SystemRouteTestHarness from './system-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './system-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

const SNAPSHOT = {
  registryVersion: 2,
  generatedAt: '2026-01-01T00:00:00.000Z',
  workflows: [
    {
      manifestVersion: 1,
      name: 'order-processing',
      workflowVersion: '1.0.0',
      revision: 'order-rev',
      contractHash: 'order-hash',
      contract: { name: 'order-processing', workflowVersion: '1.0.0' },
    },
  ],
  activeRevisions: { 'order-processing': 'order-rev' },
  activities: {},
};

function renderRegistryTab(fetch: ScriptedFetch, { retry = true } = {}) {
  fetch.routeJsonRpcMethod('weft.workers.list', {
    items: [],
    deployments: [],
    routingPolicy: 'least-loaded',
  });
  fetch.routeJsonRpcMethod('weft.workers.rejections', { items: [], limit: 25 });
  fetch.routeJsonRpcMethod('weft.catalog.sources.list', { sources: [] });
  const queryClient = createQueryClient();
  if (!retry) queryClient.setQueryDefaults(queryKeys.registry(), { retry: false });
  const view = render(SystemRouteTestHarness, {
    props: { client: realClient(), queryClient, component: RegistryTab },
  });
  return { ...view, queryClient };
}

function refetchIntervalOf(
  queryClient: ReturnType<typeof createQueryClient>,
  queryKey: readonly unknown[],
): unknown {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (query === undefined) throw new Error(`No query mounted for ${JSON.stringify(queryKey)}`);
  const interval = query.observers[0]?.options.refetchInterval;
  return typeof interval === 'function' ? interval(query) : interval;
}

describe('RegistryTab registry query', () => {
  test('refreshes on the same cadence as the worker and manifest queries', async () => {
    scripted = new ScriptedFetch();
    scripted.enqueueJsonRpcResult(SNAPSHOT);
    const { findByText, queryClient } = renderRegistryTab(scripted);
    expect(await findByText('order-processing')).not.toBeNull();

    const workersInterval = refetchIntervalOf(queryClient, queryKeys.workers.list());
    expect(workersInterval).toBe(30_000);
    expect(refetchIntervalOf(queryClient, queryKeys.registry())).toBe(workersInterval);
  });

  test('reports a malformed snapshot through the validated loader', async () => {
    scripted = new ScriptedFetch();
    scripted.enqueueJsonRpcResult({
      ...SNAPSHOT,
      workflows: [...SNAPSHOT.workflows, SNAPSHOT.workflows[0]],
    });
    const { findByText } = renderRegistryTab(scripted, { retry: false });

    expect(await findByText('Malformed server response')).not.toBeNull();
    expect(await findByText('The server returned a malformed registry snapshot.')).not.toBeNull();
  });

  test('keeps the last snapshot on screen when a background refresh fails', async () => {
    scripted = new ScriptedFetch();
    scripted.enqueueJsonRpcResult(SNAPSHOT);
    scripted.enqueueJson(
      {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32000, message: 'Forbidden', data: { httpStatus: 403 } },
      },
      { status: 200 },
    );
    const { findByText, getByText, queryClient } = renderRegistryTab(scripted);
    expect(await findByText('order-processing')).not.toBeNull();

    await queryClient.refetchQueries({ queryKey: queryKeys.registry() });

    expect(await findByText('Refresh failed · showing the last registry snapshot')).not.toBeNull();
    expect(getByText('Not authorized')).not.toBeNull();
    expect(getByText('order-processing')).not.toBeNull();
  });
});
