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
import {
  realClient,
  ScriptedFetch,
  withContractHashes,
} from './system-test-support.test-support.ts';

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

function renderRegistryTab(
  fetch: ScriptedFetch,
  {
    retry = true,
    seed,
  }: {
    retry?: boolean;
    seed?: (queryClient: ReturnType<typeof createQueryClient>) => void;
  } = {},
) {
  fetch.routeJsonRpcMethod('weft.workers.list', {
    items: [],
    deployments: [],
    routingPolicy: 'least-loaded',
  });
  fetch.routeJsonRpcMethod('weft.workers.rejections', { items: [], limit: 25 });
  fetch.routeJsonRpcMethod('weft.catalog.sources.list', { sources: [] });
  const queryClient = createQueryClient();
  if (!retry) queryClient.setQueryDefaults(queryKeys.registrySnapshot(), { retry: false });
  seed?.(queryClient);
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
    scripted.enqueueJsonRpcResult(await withContractHashes(SNAPSHOT));
    const { findByText, queryClient } = renderRegistryTab(scripted);
    expect(await findByText('order-processing')).not.toBeNull();

    const workersInterval = refetchIntervalOf(queryClient, queryKeys.workers.list());
    expect(workersInterval).toBe(30_000);
    expect(refetchIntervalOf(queryClient, queryKeys.registrySnapshot())).toBe(workersInterval);
  });

  test('reports a malformed snapshot through the validated loader', async () => {
    scripted = new ScriptedFetch();
    scripted.enqueueJsonRpcResult(
      await withContractHashes({
        ...SNAPSHOT,
        workflows: [...SNAPSHOT.workflows, SNAPSHOT.workflows[0]!],
      }),
    );
    const { findByText } = renderRegistryTab(scripted, { retry: false });

    expect(await findByText('Malformed server response')).not.toBeNull();
    expect(await findByText('The server returned a malformed registry snapshot.')).not.toBeNull();
  });

  test('keeps the last snapshot on screen when a background refresh fails', async () => {
    scripted = new ScriptedFetch();
    scripted.enqueueJsonRpcResult(await withContractHashes(SNAPSHOT));
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

    await queryClient.refetchQueries({ queryKey: queryKeys.registrySnapshot() });

    expect(await findByText('Refresh failed. Showing the last registry snapshot.')).not.toBeNull();
    expect(getByText('Not authorized')).not.toBeNull();
    expect(getByText('order-processing')).not.toBeNull();
  });

  test('never renders a raw registry response cached by an unvalidated consumer', async () => {
    // Health, Start workflow and the schedule drawer cache the raw
    // `weft.system.registry` response (or a projection of it) under
    // `queryKeys.registry()`. This one is malformed: the validated loader
    // rejects duplicate workflows, so it must not reach contract verification.
    const raw = await withContractHashes({
      ...SNAPSHOT,
      workflows: [
        { ...SNAPSHOT.workflows[0]!, name: 'unvalidated-workflow' },
        { ...SNAPSHOT.workflows[0]!, name: 'unvalidated-workflow' },
      ],
    });
    scripted = new ScriptedFetch();
    scripted.enqueueJsonRpcResult(await withContractHashes(SNAPSHOT));
    const { findByText, queryByText, queryClient } = renderRegistryTab(scripted, {
      seed: (client) => {
        // Fresh forever under the whole `registry` prefix: if the tab shared the
        // raw entry it would render it without ever calling the loader.
        client.setQueryDefaults(queryKeys.registry(), { staleTime: Infinity });
        client.setQueryData(queryKeys.registry(), raw);
      },
    });

    expect(await findByText('order-processing')).not.toBeNull();
    expect(queryByText('unvalidated-workflow')).toBeNull();
    expect(queryClient.getQueryData<unknown>(queryKeys.registry())).toBe(raw);
  });
});
