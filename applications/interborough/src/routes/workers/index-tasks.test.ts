/**
 * The Workers page's list and the tasks on the open worker's queue, through the route root
 * (COR-2018, rows 78g to 78u, 79a to 79e): the status-first rows and their filter, the failed tasks
 * with Retry all and Clear all, the Undo that holds a clear until the toast is gone, and the payload
 * of a failed task. Run with `--conditions browser --conditions svelte`.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  EMPTY_DIAGNOSTICS_SUMMARY,
  queue,
  routeHappyPaths,
  worker,
} from './index-actions.test-support.ts';
import WorkersRoute from './index.svelte';
import type { QueueTask } from './queue-tasks-data.ts';
import WorkersRouteTestHarness from './workers-route-test-harness.test-harness.svelte';
import {
  parseJsonObject,
  realClient,
  ScriptedFetch,
} from './workers-route-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate('/health/workers', { replace: true });
});

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

const GONE = worker({
  id: 'reports-worker',
  name: 'Reports worker',
  queue: 'reports',
  inFlight: 0,
  disconnectedAt: Date.now() - 3_600_000,
  lastHeartbeatAt: Date.now() - 3_600_000,
  workflows: ['release-notes'],
  buildId: '2.4.1',
});
const PAYMENTS = worker({
  id: 'payments-worker-1',
  name: 'Payments worker 1',
  queue: 'payments',
  inFlight: 3,
});

const failedTask = (id: string, activityName: string): QueueTask => ({
  operationId: id,
  status: 'failed',
  workflowId: 'run-1',
  workflowType: 'release-notes',
  activityName,
  attempt: 5,
  at: Date.UTC(2026, 9, 30, 20, 0),
  error: 'GitHub didn’t answer (HTTP 503)',
});

/** Scripts the queue's tasks: two failed and, when `waiting` says so, as many waiting as it names. */
function routeTasks(script: ScriptedFetch, state: { failed: QueueTask[]; waiting: number }): void {
  script.routeJsonRpcMethodBy('weft.task.queues.tasks', (params) => {
    const status = params['status'];
    const waitingItems: QueueTask[] = Array.from({ length: state.waiting }, (_, index) => ({
      operationId: `w-${String(index)}`,
      status: 'waiting',
      workflowType: 'release-notes',
      activityName: 'render-digest',
      attempt: 1,
      at: Date.UTC(2026, 10, 2, 13, index),
    }));
    return {
      queue: params['queue'],
      counts: { waiting: state.waiting, failed: state.failed.length },
      items:
        status === 'failed'
          ? state.failed
          : status === 'waiting'
            ? waitingItems
            : [...state.failed, ...waitingItems],
      nextCursor: null,
    };
  });
}

function renderRoute() {
  const queryClient = createQueryClient();
  const view = render(WorkersRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient,
      component: WorkersRoute,
      principalScopes: ['system:read', 'system:admin'],
    },
  });
  return { ...view, queryClient };
}

function callsTo(script: ScriptedFetch, method: string): Record<string, unknown>[] {
  return script.calls.flatMap((call) => {
    if (typeof call.init?.body !== 'string') return [];
    const body = parseJsonObject(call.init.body);
    const params = body?.['params'];
    return body?.['method'] === method && params !== null && typeof params === 'object'
      ? [{ ...params }]
      : [];
  });
}

describe('the list', () => {
  test('is the status-first rows, a disconnected worker first, each with what it needs said', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [
        PAYMENTS,
        GONE,
        worker({ id: 'search-worker', queue: 'search', health: 'draining', inFlight: 2 }),
      ],
      queues: [queue({ queue: 'reports', backlog: 12 })],
      diagnosticsSummary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 2 },
    });

    const { findByTestId, container } = renderRoute();
    await findByTestId('workers-summary');

    const rows = [...container.querySelectorAll<HTMLElement>('[data-worker-row]')];
    expect(rows.map((row) => row.dataset['workerRow'])).toEqual([
      'reports-worker',
      'payments-worker-1',
      'search-worker',
    ]);
    expect(rows.map((row) => row.dataset['statusWord'])).toEqual([
      'Disconnected',
      'Connected',
      'Draining',
    ]);
    expect(rows[0]?.textContent).toContain('reports queue');
    expect(rows[1]?.textContent).toContain('payments · 3 running');
    expect(rows[2]?.textContent).toContain('Finishing 2 tasks, then stops');
    const summaryLine = await findByTestId('workers-summary');
    expect(summaryLine.textContent).toBe(
      '2 of 3 connected · 5 running · 12 waiting · 2 failed for good',
    );
  });

  test('a filter that matches nothing keeps the text, names it, keeps the summary, and clears', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [PAYMENTS, GONE] });
    router.navigate('/health/workers?worker=payments-worker-1', { replace: true });

    const { findByTestId, findByRole, findByText, queryByText } = renderRoute();
    const summaryElement = await findByTestId('workers-summary');
    const summary = summaryElement.textContent;
    const field = await findByRole('searchbox', { name: 'Filter workers' });
    await fireEvent.input(field, { target: { value: 'billing' } });

    expect(await findByText('No workers match “billing”')).not.toBeNull();
    expect(queryByText('Workers are matched by name and queue.')).not.toBeNull();
    expect(summaryElement.textContent).toBe(summary);
    // The open worker stays open.
    const detail = await findByTestId('worker-detail');
    expect(detail.textContent).toContain('Payments worker 1');

    await fireEvent.click(await findByRole('button', { name: 'Clear filter' }));
    expect(queryByText('No workers match “billing”')).toBeNull();
  });

  test('filters by queue', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [PAYMENTS, GONE] });

    const { findByTestId, findByRole, container } = renderRoute();
    await findByTestId('workers-summary');
    await fireEvent.input(await findByRole('searchbox', { name: 'Filter workers' }), {
      target: { value: 'reports' },
    });

    await waitFor(() =>
      expect(
        [...container.querySelectorAll<HTMLElement>('[data-worker-row]')].map(
          (row) => row.dataset['workerRow'],
        ),
      ).toEqual(['reports-worker']),
    );
  });
});

describe('the open worker’s tasks', () => {
  test('a disconnected worker opens on its failed tasks, with the notice and the counts', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [GONE, PAYMENTS] });
    routeTasks(scripted, {
      failed: [
        failedTask('op-1', 'collect-merged-changes'),
        failedTask('op-2', 'notify-on-failure'),
      ],
      waiting: 12,
    });
    router.navigate('/health/workers?worker=reports-worker', { replace: true });

    const { findByTestId, findByRole } = renderRoute();

    const tasks = await findByTestId('worker-tasks');
    await waitFor(() => expect(tasks.textContent).toContain('collect-merged-changes'));
    expect(await findByRole('radio', { name: /Failed for good/ })).toBeChecked();
    const notice = await findByTestId('worker-notice');
    expect(notice.textContent).toContain('12 tasks are waiting for it and 2 failed for good.');
    expect(
      callsTo(scripted, 'weft.task.queues.tasks').every((call) => call['queue'] === 'reports'),
    ).toBe(true);
  });

  test('a worker with nothing failed opens on every task', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [PAYMENTS] });
    routeTasks(scripted, { failed: [], waiting: 3 });
    router.navigate('/health/workers?worker=payments-worker-1', { replace: true });

    const { findByRole } = renderRoute();
    expect(await findByRole('radio', { name: /^All/ })).toBeChecked();
  });

  test('Retry all puts each failed task back with no confirmation, and says so in a toast', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [GONE] });
    routeTasks(scripted, {
      failed: [
        failedTask('op-1', 'collect-merged-changes'),
        failedTask('op-2', 'notify-on-failure'),
      ],
      waiting: 12,
    });
    scripted.routeJsonRpcMethod('weft.tasks.deadletters.retry', {
      operationId: 'x',
      state: 'queued',
      attempt: 6,
      requeueCount: 1,
    });
    router.navigate('/health/workers?worker=reports-worker', { replace: true });

    const { findByRole, findByText, queryByRole } = renderRoute();
    await fireEvent.click(await findByRole('button', { name: 'Retry all (2)' }));

    expect(
      await findByText(
        'Put 2 tasks back on the reports queue. They run when a reports worker connects.',
      ),
    ).not.toBeNull();
    expect(
      callsTo(scripted, 'weft.tasks.deadletters.retry')
        .map((call) => String(call['operationId']))
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(['op-1', 'op-2']);
    expect(queryByRole('dialog')).toBeNull();
  });

  test('Clear all hides the tasks and offers Undo; nothing is sent until the page is left', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [GONE] });
    routeTasks(scripted, {
      failed: [
        failedTask('op-1', 'collect-merged-changes'),
        failedTask('op-2', 'notify-on-failure'),
      ],
      waiting: 12,
    });
    const deleted: string[] = [];
    scripted.routeRest(
      (url, method) =>
        method === 'DELETE' && url.pathname.includes('/tasks/diagnostics/dead-letter/'),
      () => {
        deleted.push('x');
        return new Response(null, { status: 204 });
      },
    );
    router.navigate('/health/workers?worker=reports-worker', { replace: true });

    const view = renderRoute();
    await fireEvent.click(await view.findByRole('button', { name: 'Clear all (2)' }));

    expect(await view.findByText('Cleared 2 failed tasks from the reports queue.')).not.toBeNull();
    const empty = await view.findByTestId('worker-tasks-empty');
    expect(empty.textContent?.trim()).toBe('No failed tasks. 12 are still waiting.');
    expect(view.container.querySelector('[data-task="op-1"]')).toBeNull();
    expect(deleted).toEqual([]);

    view.unmount();
    await waitUntil(() => deleted.length === 2, { message: 'both clears to be sent on leaving' });
  });

  test('Undo puts the tasks back and nothing is ever deleted', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [GONE] });
    routeTasks(scripted, {
      failed: [
        failedTask('op-1', 'collect-merged-changes'),
        failedTask('op-2', 'notify-on-failure'),
      ],
      waiting: 0,
    });
    const deleted: string[] = [];
    scripted.routeRest(
      (_url, method) => method === 'DELETE',
      () => {
        deleted.push('x');
        return new Response(null, { status: 204 });
      },
    );
    router.navigate('/health/workers?worker=reports-worker', { replace: true });

    const view = renderRoute();
    await fireEvent.click(await view.findByRole('button', { name: 'Clear all (2)' }));
    await fireEvent.click(await view.findByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(view.container.querySelector('[data-task="op-1"]')).not.toBeNull());
    view.unmount();
    // load-proof: nothing is sent, so there is no event to wait for; one turn lets a stray call show.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleted).toEqual([]);
  });

  test('View payload opens the retained result in the inspector', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, { workers: [GONE] });
    routeTasks(scripted, { failed: [failedTask('op-1', 'collect-merged-changes')], waiting: 0 });
    scripted.routeJsonRpcMethod('weft.tasks.deadletters.get', {
      operationId: 'op-1',
      attempt: 5,
      attemptTokenDigest: 'digest',
      pendingStatus: 'failed',
      resultDigest: 'sha256:r',
      deadLetteredAt: 1,
      persistenceFailureReason: 'storage',
      payload: { kind: 'value', value: { repository: 'interborough' }, serializedBytes: 30 },
    });
    router.navigate('/health/workers?worker=reports-worker', { replace: true });

    const { findByRole, findByText } = renderRoute();
    await fireEvent.click(await findByRole('button', { name: 'View payload' }));

    const dialog = await findByRole('dialog', { name: 'Payload of collect-merged-changes' });
    expect(await within(dialog).findByText('interborough')).not.toBeNull();
    await fireEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    await waitUntil(() => document.querySelector('[role="dialog"]') === null);
    expect(await findByText('Tasks on the reports queue')).not.toBeNull();
  });

  describe('the payload dialog when the retained result is not a value', () => {
    const DEAD_LETTER = {
      operationId: 'op-1',
      attempt: 5,
      attemptTokenDigest: 'digest',
      pendingStatus: 'failed',
      resultDigest: 'sha256:r',
      deadLetteredAt: 1,
      persistenceFailureReason: 'storage',
    };

    /** Opens the payload of the one failed task, with the dead-letter read scripted by `route`. */
    async function openPayload(route: (script: ScriptedFetch) => void) {
      scripted = new ScriptedFetch();
      routeHappyPaths(scripted, { workers: [GONE] });
      routeTasks(scripted, { failed: [failedTask('op-1', 'collect-merged-changes')], waiting: 0 });
      route(scripted);
      router.navigate('/health/workers?worker=reports-worker', { replace: true });
      const view = renderRoute();
      await fireEvent.click(await view.findByRole('button', { name: 'View payload' }));
      return within(await view.findByRole('dialog', { name: 'Payload of collect-merged-changes' }));
    }

    test('a payload over the inline size says how large it is and shows nothing', async () => {
      const dialog = await openPayload((script) =>
        script.routeJsonRpcMethod('weft.tasks.deadletters.get', {
          ...DEAD_LETTER,
          payload: {
            kind: 'omitted',
            reason: 'exceeds-max-bytes',
            serializedBytes: 5_242_880,
            maxBytes: 1_048_576,
          },
        }),
      );
      expect(
        await dialog.findByText(/The payload is .*MB, over the .*MB this view reads inline/),
      ).not.toBeNull();
    });

    test('a task that kept no payload says the worker returned none', async () => {
      const dialog = await openPayload((script) =>
        script.routeJsonRpcMethod('weft.tasks.deadletters.get', {
          ...DEAD_LETTER,
          payload: { kind: 'absent' },
        }),
      );
      expect(
        await dialog.findByText('The worker returned no payload for this task.'),
      ).not.toBeNull();
    });

    test('is loading until the read answers', async () => {
      let deferred: { resolve: (result: unknown) => void } | undefined;
      const dialog = await openPayload((script) => {
        deferred = script.deferJsonRpcMethod('weft.tasks.deadletters.get');
      });
      expect(dialog.getByRole('status', { name: 'Payload' })).not.toBeNull();
      deferred?.resolve({ ...DEAD_LETTER, payload: { kind: 'absent' } });
      expect(
        await dialog.findByText('The worker returned no payload for this task.'),
      ).not.toBeNull();
    });

    test('a refusal locks the payload and names the scope', async () => {
      const dialog = await openPayload((script) =>
        script.routeJsonRpcMethodError('weft.tasks.deadletters.get', 403, 'no', 'Forbidden'),
      );
      expect(await dialog.findByText('The payload is locked')).not.toBeNull();
    });

    test('a task the server no longer holds says the payload is gone', async () => {
      const dialog = await openPayload((script) =>
        script.routeJsonRpcMethodError('weft.tasks.deadletters.get', 404, 'gone', 'NotFound'),
      );
      expect(await dialog.findByText('The payload is gone')).not.toBeNull();
    });

    test('any other failure offers to try again, and the retry reads again', async () => {
      const dialog = await openPayload((script) =>
        script.routeJsonRpcMethodError('weft.tasks.deadletters.get', 500, 'broke', 'Internal'),
      );
      const retry = await dialog.findByRole('button', { name: /try again|retry/i });
      const before = scripted?.calls.length ?? 0;
      await fireEvent.click(retry);
      await waitFor(() => expect(scripted?.calls.length ?? 0).toBeGreaterThan(before));
    });
  });
});
