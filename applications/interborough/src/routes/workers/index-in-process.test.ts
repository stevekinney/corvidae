/**
 * The Workers route when no worker is connected (COR-1658): the engine runs its work in-process, so
 * the page says so in one sentence and shows no tabs, and the full page is back as soon as there is
 * a worker, a deployment, a task queue, or an address that names one of them.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

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
import WorkersRouteTestHarness from './workers-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './workers-route-test-support.test-support.ts';

const SENTENCE = 'This engine runs its work in-process. Remote workers are not configured.';

let scripted: ScriptedFetch | undefined;

function openAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => openAt('/workers'));

afterEach(() => {
  cleanup();
  scripted?.restore();
  scripted = undefined;
});

function renderRoute() {
  return render(WorkersRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
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

describe('Workers route with no connected worker', () => {
  test('says the engine runs in-process, with no tabs, no zero cards, and no live toggle', async () => {
    scripted = emptyFleet();

    const view = renderRoute();

    expect(await view.findByText(SENTENCE)).not.toBeNull();
    expect(view.getByRole('heading', { level: 1, name: 'Workers' })).not.toBeNull();
    expect(view.queryAllByRole('tab').length).toBe(0);
    expect(view.queryByText('Total workers')).toBeNull();
    expect(view.queryByText('No workers connected')).toBeNull();
    expect(view.queryByLabelText('Live')).toBeNull();
  });

  test('offers how to connect a worker under a disclosure that is closed to begin with', async () => {
    scripted = emptyFleet();

    const view = renderRoute();

    const trigger = await view.findByRole('button', { name: 'Learn how to connect one' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  test('shows how to connect a worker once the disclosure is opened: the engine option and a snippet for this host', async () => {
    scripted = emptyFleet();

    const view = renderRoute();

    await fireEvent.click(await view.findByRole('button', { name: 'Learn how to connect one' }));

    expect(view.getByText("activityExecution: { mode: 'remote' }")).not.toBeNull();
    expect(view.getByText(/remote-workers\.md/)).not.toBeNull();
    const snippet = view.container.querySelector('pre')?.textContent ?? '';
    expect(snippet).toContain("import { RemoteWorker } from '@lostgradient/weft';");
    expect(snippet).toContain('ws://localhost/v1/tasks/default/stream');
  });

  test('is the loading skeleton, not the sentence, until the workers have been read', () => {
    scripted = emptyFleet();
    scripted.deferJsonRpcMethod('weft.workers.list');

    const view = renderRoute();

    expect(view.getByLabelText('Loading fleet')).not.toBeNull();
    expect(view.queryByText(SENTENCE)).toBeNull();
  });
});

describe('Workers route while the lists are being read', () => {
  test('stays the loading skeleton, with no tabs, when the workers answer before the queues', async () => {
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
    expect(view.getByLabelText('Loading fleet')).not.toBeNull();
    expect(view.queryAllByRole('tab').length).toBe(0);

    queuesGate.resolve({ items: [queue()] });
    await waitFor(() => expect(view.queryAllByRole('tab').length).toBe(6));
  });

  test('stays the loading skeleton, not the sentence, until the diagnostics have been read', async () => {
    scripted = emptyFleet();
    const diagnosticsGate = scripted.deferJsonRpcMethod('weft.tasks.diagnostics');

    const view = renderRoute();

    await quietFor(20);
    expect(view.getByLabelText('Loading fleet')).not.toBeNull();
    expect(view.queryByText(SENTENCE)).toBeNull();

    diagnosticsGate.resolve({
      items: [],
      summary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
    });
    await waitFor(() => expect(view.queryAllByRole('tab').length).toBe(6));
  });
});

describe('Workers route with something to operate', () => {
  test('shows the full page with its tabs once a worker is connected', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);

    const view = renderRoute();

    await waitFor(() => expect(view.queryAllByRole('tab').length).toBe(6));
    expect(view.queryByText(SENTENCE)).toBeNull();
  });

  test('shows the full page while a task queue exists, whose ledger Diagnostics reads', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [], deployments: [], queues: [queue()] });

    const view = renderRoute();

    await waitFor(() => expect(view.queryAllByRole('tab').length).toBe(6));
    expect(view.queryByText(SENTENCE)).toBeNull();
  });

  test('shows the full page for an address that names a diagnostic, as the Overview alerts do', async () => {
    openAt('/workers?diagnostic=stuckQueued');
    scripted = emptyFleet();

    const view = renderRoute();

    await waitFor(() => expect(view.queryAllByRole('tab').length).toBe(6));
    expect(view.queryByText(SENTENCE)).toBeNull();
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

    await waitFor(() => expect(view.queryAllByRole('tab').length).toBe(6));
    expect(view.queryByText(SENTENCE)).toBeNull();
  });

  test('shows the full page for an address that names a worker, even with none connected', async () => {
    openAt('/workers?tab=list&worker=worker-1');
    scripted = emptyFleet();

    const view = renderRoute();

    expect(await view.findByText('Worker closed')).not.toBeNull();
    expect(view.queryByText(SENTENCE)).toBeNull();
  });

  test('keeps the sentence off a page whose worker list failed', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [worker()] });
    scripted.routeJsonRpcMethodError(
      'weft.workers.list',
      401,
      'authentication required',
      'Unauthorized',
    );

    const view = renderRoute();

    await waitFor(() => expect(view.queryAllByRole('tab').length).toBe(6));
    expect(view.queryByText(SENTENCE)).toBeNull();
  });
});
