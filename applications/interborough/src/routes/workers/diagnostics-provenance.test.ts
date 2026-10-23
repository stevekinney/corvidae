/**
 * Provenance filters on the Workers route's Diagnostics tab (COR-281): the
 * bounded `weft.tasks.diagnostics` filters live in the URL, are sent to the
 * server (never joined against fleet state client-side), and each filtered
 * result deep-links to the worker the diagnostics report for it.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import { diagnosticItem, routeHappyPaths } from './index-actions.test-support.ts';
import WorkersRoute from './index.svelte';
import {
  hasProvenanceFilters,
  readProvenanceFilters,
  workerDeepLink,
  writeProvenanceFilters,
} from './provenance-filters.ts';
import WorkersRouteTestHarness from './workers-route-test-harness.test-harness.svelte';
import {
  parseJsonObject,
  realClient,
  ScriptedFetch,
} from './workers-route-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

function resetLocation(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => resetLocation('/workers'));
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

/** The parameters of every `weft.tasks.diagnostics` call, in order. */
function diagnosticsParams(fetchScript: ScriptedFetch): Record<string, unknown>[] {
  return fetchScript.calls.flatMap((call) => {
    if (typeof call.init?.body !== 'string') return [];
    const body = parseJsonObject(call.init.body);
    if (body?.['method'] !== 'weft.tasks.diagnostics') return [];
    const params = body['params'];
    return typeof params === 'object' && params !== null ? [{ ...params }] : [];
  });
}

describe('provenance filter parsing', () => {
  test('round-trips every bounded filter through the URL and drops blank values', () => {
    const params = writeProvenanceFilters(new URLSearchParams({ tab: 'diagnostics' }), {
      deploymentName: 'payments',
      buildId: ' build-2 ',
      artifactDigest: 'sha256:abc',
      workerId: 'wkr_7',
      workflowRevision: 'rev-3',
    });
    expect(readProvenanceFilters(params)).toEqual({
      deploymentName: 'payments',
      buildId: 'build-2',
      artifactDigest: 'sha256:abc',
      workerId: 'wkr_7',
      workflowRevision: 'rev-3',
    });
    expect(params.get('tab')).toBe('diagnostics');
    expect(readProvenanceFilters(writeProvenanceFilters(params, { buildId: '   ' }))).toEqual({});
    expect(hasProvenanceFilters({})).toBe(false);
    expect(hasProvenanceFilters({ workerId: 'x' })).toBe(true);
  });

  test('deep-links a worker with the list tab pattern', () => {
    expect(workerDeepLink('wkr 1')).toBe('/workers?tab=list&worker=wkr+1');
  });
});

describe('Workers route — Diagnostics provenance filters', () => {
  test('sends the URL filters to the server and links each result to its worker', async () => {
    resetLocation('/workers?tab=diagnostics&buildId=build-2&deploymentName=payments');
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      diagnosticsItems: [
        diagnosticItem({ operationId: 'op_a', workerId: 'wkr_build_2', kind: 'stale-inflight' }),
        diagnosticItem({ operationId: 'op_b', workerId: 'wkr_build_3', kind: 'stale-inflight' }),
        diagnosticItem({ operationId: 'op_c', workerId: 'wkr_build_4', kind: 'stale-inflight' }),
        diagnosticItem({ operationId: 'op_d', workerId: 'wkr_build_5', kind: 'stale-inflight' }),
      ],
      diagnosticsSummary: {
        stuckQueued: 0,
        staleInflight: 4,
        retryStorms: 0,
        allWorkersAtCapacity: 0,
        deadLettered: 0,
        delayed: 0,
        unadoptedTerminal: 0,
      },
    });

    const { findAllByRole, findByLabelText } = renderRoute();

    // All four are shown (an unfiltered view caps each kind at three).
    const links = await findAllByRole('link', { name: /^Worker / });
    expect(links).toHaveLength(4);
    expect(links[0]?.getAttribute('href')).toContain('worker=wkr_build_2');
    expect(links[0]?.getAttribute('href')).toContain('tab=list');
    expect((await findByLabelText('Build ID')) as HTMLInputElement).toHaveProperty(
      'value',
      'build-2',
    );
    expect(
      diagnosticsParams(scripted).some(
        (params) => params['buildId'] === 'build-2' && params['deploymentName'] === 'payments',
      ),
    ).toBe(true);
  });

  test('applying filters writes them to the URL; clearing removes them', async () => {
    resetLocation('/workers?tab=diagnostics');
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);

    const { findByLabelText, getByRole } = renderRoute();

    const build = (await findByLabelText('Build ID')) as HTMLInputElement;
    await fireEvent.input(build, { target: { value: 'build-9' } });
    await fireEvent.click(getByRole('button', { name: 'Apply filters' }));
    expect(router.search.get('buildId')).toBe('build-9');
    expect(router.search.get('tab')).toBe('diagnostics');

    await fireEvent.click(getByRole('button', { name: 'Clear filters' }));
    expect(router.search.get('buildId')).toBeNull();
  });

  test('a filter that matches nothing says so instead of claiming the fleet is healthy', async () => {
    resetLocation('/workers?tab=diagnostics&workerId=nobody');
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);

    const { findByText } = renderRoute();
    expect(await findByText(/No task matches these provenance filters/)).not.toBeNull();
  });

  test('a failed filtered read keeps the filter bar so the operator can adjust it', async () => {
    resetLocation('/workers?tab=diagnostics&buildId=build-2');
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    scripted.routeJsonRpcMethodError(
      'weft.tasks.diagnostics',
      401,
      'authentication required',
      'Unauthorized',
    );

    const { findByText, getByLabelText, getByRole } = renderRoute();

    expect(await findByText('Not authorized')).not.toBeNull();
    expect((getByLabelText('Build ID') as HTMLInputElement).value).toBe('build-2');
    expect(getByRole('button', { name: 'Apply filters' })).not.toBeNull();
  });

  test('a filtered read stays loading with the filter bar visible', async () => {
    resetLocation('/workers?tab=diagnostics&buildId=build-2');
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    // Only the filtered read is deferred: the page's tabs wait for the unfiltered one.
    const pending = scripted.deferJsonRpcMethod(
      'weft.tasks.diagnostics',
      (params) => params['buildId'] !== undefined,
    );

    const { findByRole, getByLabelText } = renderRoute();

    expect(await findByRole('status', { name: 'Loading diagnostics' })).not.toBeNull();
    expect(getByLabelText('Build ID')).not.toBeNull();
    pending.resolve({ items: [], summary: {} });
  });
});
