/**
 * The Workers route when it has no worker to list (COR-2018, rows 78c to 78e and 78x to 78z): work
 * runs inside Interborough and no worker is connected, the workers are still being read, or they
 * could not be read. Each keeps the page's heading and draws one Cinder state under it. The full
 * page is back as soon as there is a worker, a deployment, a task queue, or an address that names
 * one of them. The timings the placeholders keep run under fake timers, never a sleep.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import { flushSync } from 'svelte';

import { quietFor } from '@lostgradient/testing/wait-until';
import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  EMPTY_DIAGNOSTICS_SUMMARY,
  queue,
  routeHappyPaths,
  worker,
} from './index-actions.test-support.ts';
import WorkersRoute from './index.svelte';
import { WORKER_COPY } from './worker-copy.ts';
import WorkersRouteTestHarness from './workers-route-test-harness.test-harness.svelte';
import {
  realClient,
  ScriptedFetch,
  workersTabs,
} from './workers-route-test-support.test-support.ts';

const EMPTY_TITLE = 'No workers connected';
const copy = WORKER_COPY.states;

let scripted: ScriptedFetch | undefined;

function openAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => openAt('/health/workers'));

afterEach(() => {
  jest.useRealTimers();
  cleanup();
  scripted?.restore();
  scripted = undefined;
});

/** Renders the route; `retries` turns the app's retry of a server error back on, which a failure test does not wait for. */
function renderRoute() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
  });
  return render(WorkersRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient,
      component: WorkersRoute,
      principalScopes: ['system:read', 'system:admin', 'events:read'],
    },
  });
}

/** Scripts a fleet with nothing in it. */
function emptyFleet(): ScriptedFetch {
  const script = new ScriptedFetch();
  routeHappyPaths(script, { workers: [], deployments: [], queues: [] });
  return script;
}

/** The state the page is in below its heading, by the region it draws. */
function stateOf(view: ReturnType<typeof renderRoute>): string | undefined {
  return view.queryByTestId('workers-state')?.dataset['state'];
}

describe('Workers route with no connected worker (rows 78c to 78e)', () => {
  test('says where work runs under the heading "Workers", with no tabs, no zero cards and no live toggle', async () => {
    scripted = emptyFleet();

    const view = renderRoute();

    expect(await view.findByRole('heading', { level: 3, name: EMPTY_TITLE })).not.toBeNull();
    expect(stateOf(view)).toBe('empty');
    expect(view.getByRole('heading', { level: 1, name: 'Health' })).not.toBeNull();
    expect(view.getByRole('heading', { level: 2, name: 'Workers' })).not.toBeNull();
    expect(view.getByTestId('workers-summary').textContent).toBe(
      'Work runs inside Interborough, 0 running, 0 waiting',
    );
    expect(view.getByText(copy.empty.description)).not.toBeNull();
    expect(workersTabs(view).length).toBe(0);
    expect(view.queryByText('Total workers')).toBeNull();
    expect(view.queryByLabelText('Live')).toBeNull();
  });

  test('is a bordered Cinder empty state whose one button is secondary and opens the guide in a new tab', async () => {
    scripted = emptyFleet();

    const view = renderRoute();

    await view.findByRole('heading', { level: 3, name: EMPTY_TITLE });
    const region = view.getByTestId('workers-state');
    expect(region.querySelector('.cinder-empty-state[data-cinder-bordered]')).not.toBeNull();
    const link = view.getByRole('link', { name: copy.empty.howToConnect });
    expect(link.getAttribute('href')).toBe(copy.empty.guideAddress);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.querySelector('svg')).not.toBeNull();
    expect(link.getAttribute('data-cinder-variant')).toBe('secondary');
    // The page's only action: nothing else to press, and nothing primary.
    expect(region.querySelectorAll('a, button')).toHaveLength(1);
    expect(region.querySelector('[data-cinder-variant="primary"]')).toBeNull();
  });

  test('draws no worker row, no status word, no alert, and no Advanced disclosure (row 78e)', async () => {
    scripted = emptyFleet();

    const view = renderRoute();

    await view.findByRole('heading', { level: 3, name: EMPTY_TITLE });
    const region = view.getByTestId('workers-state');
    expect(view.container.querySelector('[data-worker-row], [data-status-word]')).toBeNull();
    expect(region.querySelector('.cinder-status-dot')).toBeNull();
    expect(region.querySelector('[role="alert"], .cinder-alert, .cinder-banner')).toBeNull();
    expect(view.queryByTestId('workers-advanced')).toBeNull();
  });

  test('is the loading state, not the empty one, until the workers have been read', () => {
    scripted = emptyFleet();
    scripted.deferJsonRpcMethod('weft.workers.list');

    const view = renderRoute();

    expect(stateOf(view)).toBe('loading');
    expect(view.queryByText(EMPTY_TITLE)).toBeNull();
  });
});

describe('Workers route while the workers are being read (rows 78x and 78y)', () => {
  /** Every request waits, so the workers are read for as long as the test runs. */
  function openReading() {
    scripted = emptyFleet();
    scripted.deferJsonRpcMethod('weft.workers.list');
    const view = renderRoute();
    flushSync();
    return view;
  }

  function advance(milliseconds: number): void {
    jest.advanceTimersByTime(milliseconds);
    flushSync();
  }

  test('keeps the heading and "Loading workers…" as real text, and draws nothing for the read until 300 ms, then four rows', () => {
    jest.useFakeTimers();
    const view = openReading();
    const region = view.getByTestId('workers-state');

    expect(stateOf(view)).toBe('loading');
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(within(region).getByRole('heading', { level: 2, name: 'Workers' })).not.toBeNull();
    expect(within(region).getByTestId('workers-loading-line').textContent).toBe('Loading workers…');
    expect(region.querySelector('.cinder-skeleton-row')).toBeNull();

    advance(copy.loadingDelayMilliseconds - 1);
    expect(region.querySelector('.cinder-skeleton-row')).toBeNull();

    advance(1);
    expect(region.querySelectorAll('.cinder-skeleton-row')).toHaveLength(4);
    // The worker-row layout: a dot, a title bar and a meta bar, and a bar at the end; no status word.
    expect(
      region.querySelectorAll('.cinder-skeleton-status-bar[data-cinder-marker="dot"]'),
    ).toHaveLength(4);
    expect(region.querySelectorAll('.cinder-skeleton-title-bar')).toHaveLength(4);
    expect(region.querySelectorAll('.cinder-skeleton-meta-bar')).toHaveLength(4);
    expect(region.querySelectorAll('.cinder-skeleton-time-bar')).toHaveLength(4);
    expect(region.querySelector('[data-cinder-status-column="none"]')).not.toBeNull();
  });

  test('says it is taking longer than usual at 10 s with Cinder’s own line and a ghost Cancel, and not before', () => {
    jest.useFakeTimers();
    const view = openReading();
    const region = view.getByTestId('workers-state');

    advance(copy.stillLoadingMilliseconds - 1);
    expect(region.textContent).not.toContain('Still loading');
    expect(within(region).queryByRole('button', { name: 'Cancel' })).toBeNull();

    advance(1);
    expect(region.querySelector('.cinder-skeleton-status')?.textContent).toContain(
      'Still loading. This is taking longer than usual.',
    );
    const cancel = within(region).getByRole('button', { name: 'Cancel' });
    expect(cancel.getAttribute('data-cinder-variant')).toBe('ghost');
    // Not a banner, and not an alert: the line is the skeleton's own status.
    expect(region.querySelector('.cinder-banner, [role="alert"]')).toBeNull();
  });

  test('Cancel stops the read and says so; Try again reads again and brings the page back', async () => {
    jest.useFakeTimers();
    scripted = emptyFleet();
    const gate = scripted.deferJsonRpcMethod('weft.workers.list');
    const view = renderRoute();
    flushSync();
    advance(copy.stillLoadingMilliseconds);

    await fireEvent.click(
      within(view.getByTestId('workers-state')).getByRole('button', { name: 'Cancel' }),
    );
    flushSync();

    expect(stateOf(view)).toBe('cancelled');
    expect(
      view.getByRole('heading', { level: 3, name: copy.failed.cancelledTitle }),
    ).not.toBeNull();
    // Nothing failed, so it is not announced as an alert.
    expect(view.getByTestId('workers-state').querySelector('[role="alert"]')).toBeNull();

    jest.useRealTimers();
    gate.resolve({ items: [], deployments: [], routingPolicy: 'least-loaded' });
    await fireEvent.click(view.getByRole('button', { name: copy.failed.tryAgain }));

    expect(await view.findByRole('heading', { level: 3, name: EMPTY_TITLE })).not.toBeNull();
    expect(stateOf(view)).toBe('empty');
  });
});

describe('Workers route when the workers could not be read (row 78z)', () => {
  /** The workers list answers with `status`; the rest of the fleet answers as usual. */
  function failing(status: number, message = 'The engine broke.'): ScriptedFetch {
    const script = new ScriptedFetch();
    routeHappyPaths(script, { workers: [worker()] });
    script.routeJsonRpcMethodError('weft.workers.list', status, message, 'EngineFailure');
    return script;
  }

  test('is a bordered Cinder error state in the Workers section with the status named, and no banner', async () => {
    scripted = failing(500);

    const view = renderRoute();

    expect(
      await view.findByRole('heading', { level: 3, name: 'Couldn’t load workers' }),
    ).not.toBeNull();
    expect(stateOf(view)).toBe('failed');
    const region = view.getByTestId('workers-state');
    expect(within(region).getByRole('heading', { level: 2, name: 'Workers' })).not.toBeNull();
    expect(within(region).queryByTestId('workers-summary')).toBeNull();
    expect(
      within(region).getByText(
        'The server answered with an error (500). Nothing you did caused it. Workers keep running while this page is down.',
      ),
    ).not.toBeNull();
    expect(region.querySelector('.cinder-error-state[data-cinder-bordered]')).not.toBeNull();
    // The state's own alert is the only one: no banner beside it.
    expect(region.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(view.container.querySelector('.cinder-banner')).toBeNull();
  });

  test('offers a secondary Try again with a refresh icon and "Open Health" drawn as a link', async () => {
    scripted = failing(500);

    const view = renderRoute();

    const retry = await view.findByRole('button', { name: copy.failed.tryAgain });
    expect(retry.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(retry.querySelector('svg')).not.toBeNull();
    const open = view.getByRole('link', { name: copy.failed.openHealth });
    expect(open.getAttribute('href')).toBe('/health');
    expect(open.getAttribute('data-cinder-variant')).toBe('ghost-accent');
  });

  test('Try again reads the workers again and the page returns when they answer', async () => {
    scripted = failing(500);

    const view = renderRoute();
    await fireEvent.click(await view.findByRole('button', { name: copy.failed.tryAgain }));
    scripted.routeJsonRpcMethod('weft.workers.list', {
      items: [worker({ id: 'wkr_back' })],
      deployments: [],
      routingPolicy: 'least-loaded',
    });
    await fireEvent.click(view.getByRole('button', { name: copy.failed.tryAgain }));

    await waitFor(() => expect(view.queryByTestId('workers-state') === null).toBe(true));
    expect(await view.findByTestId('workers-advanced')).not.toBeNull();
  });

  test('says the server did not answer when the request got no answer at all', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker()] });
    scripted.routeRest(
      (url) => url.pathname.endsWith('/jsonrpc'),
      () => {
        throw new TypeError('Failed to fetch');
      },
    );

    const view = renderRoute();

    expect(await view.findByText(copy.failed.noAnswer)).not.toBeNull();
  });
});

describe('Workers route while the lists are being read', () => {
  test('stays the loading state, with no tabs, when the workers answer before the queues', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    const queuesGate = scripted.deferJsonRpcMethod('weft.task.queues.list');

    const view = renderRoute();

    // The workers have answered (the deferred queues have not), and the page still waits for both.
    const asked = (method: string) =>
      scripted?.calls.some(
        (call) => typeof call.init?.body === 'string' && call.init.body.includes(method),
      );
    await waitFor(() => expect(asked('weft.workers.list')).toBe(true));
    await quietFor(20);
    expect(stateOf(view)).toBe('loading');
    expect(workersTabs(view).length).toBe(0);

    queuesGate.resolve({ items: [queue()] });
    expect(await view.findByTestId('workers-advanced')).not.toBeNull();
  });

  test('stays the loading state, not the empty one, until the diagnostics have been read', async () => {
    scripted = emptyFleet();
    const diagnosticsGate = scripted.deferJsonRpcMethod('weft.tasks.diagnostics');

    const view = renderRoute();

    await quietFor(20);
    expect(stateOf(view)).toBe('loading');
    expect(view.queryByText(EMPTY_TITLE)).toBeNull();

    diagnosticsGate.resolve({
      items: [],
      summary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
    });
    expect(await view.findByTestId('workers-advanced')).not.toBeNull();
  });
});

describe('Workers route with something to operate', () => {
  test('shows the full page with its tabs once a worker is connected', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);

    const view = renderRoute();

    expect(await view.findByTestId('workers-advanced')).not.toBeNull();
    expect(view.queryByTestId('workers-state')).toBeNull();
  });

  test('shows the full page while a task queue exists, whose ledger Diagnostics reads', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [], deployments: [], queues: [queue()] });

    const view = renderRoute();

    expect(await view.findByTestId('workers-advanced')).not.toBeNull();
    expect(view.queryByTestId('workers-state')).toBeNull();
  });

  test('shows the full page for an address that names a diagnostic, as the Overview alerts do', async () => {
    openAt('/health/workers?diagnostic=stuckQueued');
    scripted = emptyFleet();

    const view = renderRoute();

    expect(await view.findByTestId('workers-advanced')).not.toBeNull();
    expect(view.queryByTestId('workers-state')).toBeNull();
  });

  test('shows the full page for a dead letter whose worker disconnected, which no queue lists', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [],
      deployments: [],
      queues: [],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
    });

    const view = renderRoute();

    expect(await view.findByTestId('workers-advanced')).not.toBeNull();
    expect(view.queryByTestId('workers-state')).toBeNull();
  });

  test('shows the full page for an address that names a worker, even with none connected', async () => {
    openAt('/health/workers?worker=worker-1');
    scripted = emptyFleet();

    const view = renderRoute();

    expect(await view.findByText('Worker closed')).not.toBeNull();
    expect(view.queryByTestId('workers-state')).toBeNull();
  });

  test('shows the failed state, never the empty one, for a worker list that failed, and keeps Advanced reachable', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker()] });
    scripted.routeJsonRpcMethodError(
      'weft.workers.list',
      401,
      'authentication required',
      'Unauthorized',
    );

    const view = renderRoute();

    expect(await view.findByTestId('workers-advanced')).not.toBeNull();
    expect(stateOf(view)).toBe('failed');
    expect(view.queryByText(EMPTY_TITLE)).toBeNull();
  });
});
