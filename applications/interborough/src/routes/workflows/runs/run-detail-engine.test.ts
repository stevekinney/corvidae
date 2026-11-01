/**
 * `/runs/:run` for a run the workflow engine holds: the one header and status, the sections it is
 * made of (no tabs), what the engine's actions and its read of the active revision do, and which
 * sections a caller sees by the scopes they hold. The sections' own behavior is tested beside them;
 * this is the page deciding which to draw. The engine answers over scripted HTTP routes and the
 * Bureau over scripted JSON-RPC methods, through one `ScriptedFetch`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window, type DetachedWindowAPI } from 'happy-dom';
import { readFileSync } from 'node:fs';

import { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';

import { TASK_COPY } from '../../../app/copy.ts';
import { contextDetailFixture, taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { queryKeys } from '../../../lib/query.ts';
import { router } from '../../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type Principal } from '../../../lib/scopes.svelte.ts';
import { openStepNumber } from '../detail/steps/open-step.test-support.ts';
import {
  parseJsonObject,
  realClient,
  ScriptedFetch,
} from '../list/workflow-test-support.test-support.ts';
import RunDetailHarness from './run-detail.test-harness.svelte';

function baseWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wf-detail-1',
    type: 'order-fulfillment',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1.0.0' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function principalWith(...scopes: Principal['scopes']): Principal {
  return { scopes, unauthenticatedAccess: null };
}

const GRANTED_PRINCIPAL = principalWith('workflows:read', 'workflows:write');
const ALL_BUT = (...withheld: Principal['scopes']): Principal =>
  principalWith(...AUTHORIZATION_SCOPES.filter((scope) => !withheld.includes(scope)));

function happyDomAPI(): DetachedWindowAPI {
  if (!(window instanceof Window)) {
    throw new Error('expected the test window to be backed by happy-dom');
  }
  return window.happyDOM;
}

function resetLocation(path: string): void {
  happyDomAPI().setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

let fetchScript: ScriptedFetch;

beforeEach(() => {
  fetchScript = new ScriptedFetch();
  // The page subscribes to the shared fleet feed; the stream must stay open (never a finite or
  // closed response) or `FleetEventSource` reconnects in a loop (`routeSseStream` module doc).
  fetchScript.routeSseStream('/v1/events/sse');
  // A run only the engine knows is no task and no goal's attempt.
  fetchScript.routeJsonRpcMethodNotFound('bureau.tasks.get', 'No such task');
  fetchScript.routeJsonRpcMethod('bureau.goals.list', { goals: [], nextOffset: null });
});

afterEach(() => {
  cleanup();
  fetchScript.restore();
  // The address is shared with every test that runs after this file.
  resetLocation('/');
});

function mount(
  id: string,
  principal: Principal = GRANTED_PRINCIPAL,
  queryClient = newQueryClient(),
) {
  resetLocation(`/runs/${id}`);
  return render(RunDetailHarness, {
    props: { client: realClient(), principal, queryClient, runId: id },
  });
}

/**
 * Scripts the engine's reads of one run: its timeline (empty), its pending async activities (none),
 * and the run itself. Substring routes match in registration order, and the run's own route is a
 * substring of the others', so it goes last.
 */
function routeRun(id: string, overrides: Record<string, unknown> = {}): void {
  fetchScript.routeUrl(`/workflows/${id}/timeline`, []);
  fetchScript.routeJsonRpcMethod('weft.workflows.activities.pending.list', { items: [] });
  fetchScript.routeUrl(`/workflows/${id}`, baseWorkflow({ id, ...overrides }));
}

function jsonRpcMethodsCalled(): string[] {
  return fetchScript.calls.flatMap((call) => {
    if (typeof call.init?.body !== 'string') return [];
    try {
      const body = parseJsonObject(call.init.body);
      return typeof body?.['method'] === 'string' ? [body['method']] : [];
    } catch {
      return [];
    }
  });
}

describe('a run nothing holds', () => {
  test('is said not to have been found, with a next step', async () => {
    const bogusId = '00000000-0000-0000-0000-000000000000';
    // `HttpClient.get()` resolves a 404 GET to `null` rather than throwing.
    fetchScript.routeUrlStatus(`/workflows/${bogusId}`, 404);
    fetchScript.routeJsonRpcMethodNotFound('bureau.workflows.runs.get', 'No such run');

    const view = mount(bogusId);

    expect(await view.findByText(TASK_COPY.notFound.title)).not.toBeNull();
    expect(view.queryByText('No workflow found')).toBeNull();
  });
});

describe('a run of a workflow file the engine does not hold', () => {
  // The engine behind the console answers 404 for a run of a workflow file whenever it is not the
  // engine that runs the Bureau's workflows (the end-to-end host's is a fixture engine). The
  // Bureau holds the instance either way, so the page says what the run is.
  test('is drawn from the Bureau’s record: one header, one status, its input and a link to the workflow', async () => {
    const id = 'f3a9c0de-0000-4000-8000-000000000001';
    fetchScript.routeUrlStatus(`/workflows/${id}`, 404);
    fetchScript.routeJsonRpcMethod('bureau.workflows.runs.get', {
      id,
      workflow: 'e2e-approval',
      workflowVersion: 'sha256:abc',
      status: 'running',
      createdAt: '2026-10-31T11:26:19.437Z',
      updatedAt: '2026-10-31T11:26:20.437Z',
      trigger: { kind: 'signal', name: 'e2e-begin', payload: null },
      result: null,
      error: null,
      finishReason: null,
    });

    const view = mount(id);

    expect(await view.findByRole('heading', { level: 1, name: 'e2e-approval' })).not.toBeNull();
    expect(view.container.querySelectorAll('[data-status-word]').length).toBe(1);
    expect(view.container.querySelector('[data-status-word]')?.textContent).toContain('Running');
    expect(view.queryAllByRole('tab').length).toBe(0);
    expect(view.getByRole('heading', { level: 2, name: 'Input and output' })).not.toBeNull();
    const rail = view.getByRole('complementary');
    const link = [...rail.querySelectorAll('a')].find((one) => one.textContent === 'e2e-approval');
    expect(link?.getAttribute('href')).toBe(router.href('/workflows/e2e-approval'));
    expect(view.queryByText('No workflow found')).toBeNull();
  });

  test('says the run could not be loaded when the Bureau fails, rather than that it is missing', async () => {
    const id = 'f3a9c0de-0000-4000-8000-000000000002';
    fetchScript.routeUrlStatus(`/workflows/${id}`, 404);
    fetchScript.routeJsonRpcMethodUnprocessable('bureau.workflows.runs.get', 'The Bureau broke.');

    const view = mount(id);

    expect(await view.findByText(TASK_COPY.loadFailed.title)).not.toBeNull();
    expect(view.queryByText(TASK_COPY.notFound.title)).toBeNull();
  });
});

describe('a run the engine cannot be read for', () => {
  test('a 500 from the workflow fetch is told as a fault with a retry', async () => {
    const id = 'wf-detail-fault-1';
    fetchScript.routeUrlStatus(`/workflows/${id}`, 500);

    const view = mount(id);

    expect(await view.findByRole('alert')).not.toBeNull();
    expect(view.getByRole('button', { name: 'Try again' })).not.toBeNull();
  });
});

describe('a run the engine holds', () => {
  test('is one header with one status and no tabs, whatever sections it has', async () => {
    const id = 'wf-detail-loaded-1';
    fetchScript.routeUrl(`/workflows/${id}/events`, { events: [] });
    routeRun(id, { id });

    const view = mount(id);

    expect(
      await view.findByRole('heading', { level: 1, name: 'order-fulfillment' }),
    ).not.toBeNull();
    expect(view.getAllByRole('heading', { level: 1 }).length).toBe(1);
    expect(view.container.querySelectorAll('[data-status-word]').length).toBe(1);
    expect(view.queryAllByRole('tab').length).toBe(0);
    for (const name of [
      'Input and output',
      'Activity',
      'Change or ask this run',
      'Details',
      'Related runs',
    ]) {
      expect(view.getByRole('heading', { level: 2, name })).not.toBeNull();
    }
  });

  test('opens its events from the Events disclosure, with no address change', async () => {
    const id = 'wf-detail-loaded-2';
    fetchScript.routeUrl(`/workflows/${id}/events`, { events: [] });
    routeRun(id, { id });

    const view = mount(id);
    const trigger = await view.findByRole('button', { name: 'Events' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(trigger);

    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'));
    expect(router.search.get('tab')).toBeNull();
  });

  test('offers the engine’s actions in the More menu, disabled for a caller without workflows:write', async () => {
    const id = 'wf-detail-read-only-1';
    routeRun(id, { id, status: 'running' });

    const view = mount(id, principalWith('workflows:read'));
    await fireEvent.click(await view.findByRole('button', { name: 'More actions' }));

    const suspend = await view.findByRole('menuitem', { name: 'Suspend' });
    expect(
      suspend.getAttribute('aria-disabled') === 'true' || suspend.hasAttribute('disabled'),
    ).toBe(true);
    await fireEvent.click(suspend);
    expect(fetchScript.calls.some((call) => call.url.includes('/suspend'))).toBe(false);
  });

  test('Suspend calls the suspend endpoint without asking first', async () => {
    const id = 'wf-detail-suspend-1';
    fetchScript.routeUrl(`/workflows/${id}/suspend`, {});
    routeRun(id, { id, status: 'running' });

    const view = mount(id);
    await fireEvent.click(await view.findByRole('button', { name: 'More actions' }));
    await fireEvent.click(await view.findByRole('menuitem', { name: 'Suspend' }));

    await waitFor(() => {
      expect(fetchScript.calls.some((call) => call.url.includes(`/workflows/${id}/suspend`))).toBe(
        true,
      );
    });
  });

  test('Cancel asks first, and is the engine’s only for a run no task describes', async () => {
    const id = 'wf-detail-cancel-1';
    routeRun(id, { id, status: 'running' });

    const view = mount(id);
    await fireEvent.click(await view.findByRole('button', { name: 'More actions' }));
    await fireEvent.click(await view.findByRole('menuitem', { name: 'Cancel' }));

    const cancels = () => fetchScript.calls.filter((call) => call.init?.method === 'DELETE');
    expect(cancels()).toEqual([]);
    await fireEvent.click(
      within(await view.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => expect(cancels().length).toBe(1));
  });

  test('Restart is offered for a run that is over, and opens its dialog', async () => {
    const id = 'wf-detail-restart-1';
    routeRun(id, { id, status: 'failed' });

    const view = mount(id);
    await fireEvent.click(await view.findByRole('button', { name: 'More actions' }));
    await fireEvent.click(await view.findByRole('menuitem', { name: 'Restart' }));

    expect(await view.findByRole('dialog')).not.toBeNull();
  });

  test('a cancelled run whose finalizer is still running says so under Cleanup', async () => {
    const id = 'wf-detail-finalizer-1';
    routeRun(id, { id, status: 'cancelled' });
    fetchScript.routeJsonRpcMethod('weft.workflows.finalizer.get', {
      status: 'running',
      attempts: 1,
      startedAt: 1,
    });

    const view = mount(id);

    const finalizing = await view.findAllByText('Finalizing');
    expect(finalizing.length).toBeGreaterThan(0);
    expect(fact(view, 'Cleanup')).toBe('Finalizing');
  });
});

function fact(view: ReturnType<typeof mount>, term: string): string | undefined {
  return [...view.container.querySelectorAll('dt')]
    .find((element) => element.textContent?.trim() === term)
    ?.nextElementSibling?.textContent?.trim();
}

describe('the Details rail of a run the engine holds', () => {
  test('puts each label above its value: the workflow, the ID, the version and an unpinned revision', async () => {
    const id = 'wf-detail-rail-1';
    routeRun(id, {
      versionTuple: { workflowVersion: '2', agentVersion: '3', toolVersions: ['a', 'b'] },
    });

    const view = mount(id);

    await waitFor(() => expect(fact(view, 'Version')).toBe('wf 2 · agent 3 · tools 2'));
    expect(fact(view, 'Workflow')).toBe('order-fulfillment');
    expect(fact(view, 'Revision')).toBe('Unpinned (pre-revision record)');
    expect(view.container.querySelector('dd code.ib-identifier')).not.toBeNull();
  });

  test('says how long until the deadline of a running run, and that it passed once it has', async () => {
    const id = 'wf-detail-rail-2';
    routeRun(id, { executionDeadline: Date.now() + 3_600_000 });
    const running = mount(id);
    await waitFor(() => expect(fact(running, 'Deadline')).toMatch(/^in /));
    cleanup();

    const lateId = 'wf-detail-rail-3';
    routeRun(lateId, { id: lateId, executionDeadline: 1_000 });
    const late = mount(lateId);
    await waitFor(() => expect(fact(late, 'Deadline')).toBe('passed'));
  });

  test('says no deadline of a run that is over', async () => {
    const id = 'wf-detail-rail-4';
    routeRun(id, { status: 'completed', executionDeadline: Date.now() + 3_600_000 });

    const view = mount(id);

    await waitFor(() => expect(fact(view, 'Took')).toBeDefined());
    expect(fact(view, 'Deadline')).toBeUndefined();
  });
});

describe('a run the Bureau describes', () => {
  function describeTask(id: string): void {
    fetchScript.restore();
    fetchScript = new ScriptedFetch();
    fetchScript.routeSseStream('/v1/events/sse');
    fetchScript.routeJsonRpcMethod('bureau.tasks.get', taskFixture({ id, agentName: 'echo' }));
    fetchScript.routeJsonRpcMethod('bureau.contexts.get', contextDetailFixture('session-1'));
    fetchScript.routeJsonRpcMethod('bureau.goals.list', { goals: [], nextOffset: null });
  }

  test('shows the engine sections too when the engine holds it, with one Cancel', async () => {
    describeTask('task-1');
    routeRun('task-1');

    const view = mount('task-1');

    expect(await view.findByRole('heading', { level: 1, name: 'echo' })).not.toBeNull();
    expect(
      await view.findByRole('heading', { level: 2, name: 'Change or ask this run' }),
    ).not.toBeNull();
    expect(fetchScript.calls.some((call) => call.url.includes('/workflows/task-1'))).toBe(true);
    // The task's own Cancel run stands; the engine's cancel is not offered a second time.
    expect(view.getAllByRole('button', { name: 'Cancel run' })).toHaveLength(1);
    await fireEvent.click(await view.findByRole('button', { name: 'More actions' }));
    expect(view.queryByRole('menuitem', { name: 'Cancel' })).toBeNull();
    expect(await view.findByRole('menuitem', { name: 'Suspend' })).not.toBeNull();
  });

  test('has no engine sections when the engine does not hold it', async () => {
    describeTask('task-2');
    fetchScript.routeUrlStatus('/workflows/task-2', 404);

    const view = mount('task-2');

    expect(await view.findByRole('heading', { level: 1, name: 'echo' })).not.toBeNull();
    await waitFor(() =>
      expect(fetchScript.calls.some((call) => call.url.includes('/workflows/task-2'))).toBe(true),
    );
    expect(view.queryByRole('heading', { level: 2, name: 'Change or ask this run' })).toBeNull();
  });

  test('says the engine could not be read, with Retry, when it fails', async () => {
    describeTask('task-4');
    fetchScript.routeUrlStatus('/workflows/task-4', 500);

    const view = mount('task-4');

    expect(await view.findByRole('heading', { level: 1, name: 'echo' })).not.toBeNull();
    const failure = await view.findByRole('heading', {
      level: 2,
      name: TASK_COPY.engineReadFailed,
    });
    const retry = within(failure.parentElement as HTMLElement).getByRole('button', {
      name: 'Try again',
    });
    const reads = fetchScript.calls.filter((call) => call.url.includes('/workflows/task-4')).length;
    await fireEvent.click(retry);
    await waitFor(() =>
      expect(
        fetchScript.calls.filter((call) => call.url.includes('/workflows/task-4')).length,
      ).toBeGreaterThan(reads),
    );
    expect(view.queryByRole('heading', { level: 2, name: 'Change or ask this run' })).toBeNull();
  });

  test('is not looked up in the workflow engine for a caller without workflows:read', async () => {
    describeTask('task-3');

    const view = mount('task-3', principalWith());

    expect(await view.findByRole('heading', { level: 1, name: 'echo' })).not.toBeNull();
    expect(fetchScript.calls.some((call) => call.url.includes('/workflows/task-3'))).toBe(false);
  });
});

describe('the sections a caller sees', () => {
  test('a caller without workflows:read has the page the Bureau can fill in and no engine section', async () => {
    const id = 'wf-detail-no-engine-1';

    const view = mount(id, principalWith());

    // Nothing the Bureau holds either, so the run is not found; the engine is never asked.
    expect(await view.findByText(TASK_COPY.notFound.title)).not.toBeNull();
    expect(fetchScript.calls.some((call) => call.url.includes(`/workflows/${id}`))).toBe(false);
  });

  test('without events:read the Events disclosure says which scope it needs', async () => {
    const id = 'wf-sections-events-1';
    routeRun(id, { id });

    const view = mount(id, ALL_BUT('events:read'));
    await fireEvent.click(await view.findByRole('button', { name: 'Events' }));

    expect(await view.findByText(/Requires events:read/)).not.toBeNull();
    expect(fetchScript.calls.some((call) => call.url.includes(`/workflows/${id}/events`))).toBe(
      false,
    );
  });

  test('without queries:read the query form is disabled, and without signals:write so is the signal', async () => {
    const id = 'wf-sections-change-1';
    routeRun(id, { id });
    fetchScript.routeUrl(`/workflows/${id}/timeline`, []);

    const view = mount(id, ALL_BUT('queries:read', 'signals:write'));
    await fireEvent.click(await view.findByRole('button', { name: 'Ask a question' }));
    await fireEvent.click(await view.findByRole('button', { name: 'Send a signal' }));

    const run = await view.findByRole('button', { name: 'Run' });
    expect(run.hasAttribute('disabled')).toBe(true);
    const send = await view.findByRole('button', { name: 'Send signal' });
    expect(send.hasAttribute('disabled')).toBe(true);
  });

  test('a query runs from its section and shows the answer, with no dialog', async () => {
    const id = 'wf-sections-query-1';
    fetchScript.routeUrl(`/workflows/${id}/query/getTotal`, { result: { total: 3 } });
    routeRun(id, { id });

    const view = mount(id, ALL_BUT());
    await fireEvent.click(await view.findByRole('button', { name: 'Ask a question' }));
    await fireEvent.input(await view.findByLabelText('Query name'), {
      target: { value: 'getTotal' },
    });
    const run = view.getByRole('button', { name: 'Run' });
    await waitFor(() => expect(run.hasAttribute('disabled')).toBe(false));
    await fireEvent.click(run);

    await waitFor(() =>
      expect(fetchScript.calls.some((call) => call.url.includes('/query/getTotal'))).toBe(true),
    );
    expect(await view.findByText(/"total": 3/)).not.toBeNull();
    expect(view.queryByRole('dialog')).toBeNull();
  });

  test('draws the run’s attributes for a caller who can read them, with edits when it can write', async () => {
    const id = 'wf-sections-attributes-1';
    fetchScript.routeJsonRpcMethod('weft.workflows.attributes.get', { region: 'us-east' });
    routeRun(id, { id });

    const view = mount(id, ALL_BUT());

    expect(await view.findByText('us-east')).not.toBeNull();
    expect(view.getByRole('button', { name: 'Edit region' })).not.toBeNull();
  });

  test('draws them read-only for a caller who can read but not write', async () => {
    const id = 'wf-sections-attributes-2';
    fetchScript.routeJsonRpcMethod('weft.workflows.attributes.get', { region: 'us-east' });
    routeRun(id, { id });

    const view = mount(id, ALL_BUT('attributes:write'));

    expect(await view.findByText('us-east')).not.toBeNull();
    expect(view.queryByRole('button', { name: /^Edit/ })).toBeNull();
  });

  test('draws no attributes, and reads none, without attributes:read', async () => {
    const id = 'wf-sections-attributes-3';
    routeRun(id, { id });

    const view = mount(id, ALL_BUT('attributes:read', 'attributes:write'));
    await view.findByRole('heading', { level: 1, name: 'order-fulfillment' });

    expect(jsonRpcMethodsCalled()).not.toContain('weft.workflows.attributes.get');
  });

  function routeUpdates(id: string): void {
    fetchScript.routeJsonRpcMethod('weft.workflows.updates.list', {
      items: [
        {
          updateId: 'u-1',
          name: 'applyDiscount',
          receivedAt: 1_000,
          outcome: 'failed',
          completedAt: 1_100,
          error: 'insufficient balance',
        },
      ],
    });
    routeRun(id, { id });
  }

  test('lists the run’s updates and draws the send form for a caller holding updates:write', async () => {
    const id = 'wf-sections-updates-1';
    routeUpdates(id);

    const view = mount(id, ALL_BUT());
    await fireEvent.click(await view.findByRole('button', { name: 'Send an update' }));

    expect(await view.findByText('insufficient balance')).not.toBeNull();
    expect(view.getByLabelText('Update name')).not.toBeNull();
  });

  test('still lists them, with no send form, without updates:write', async () => {
    const id = 'wf-sections-updates-2';
    routeUpdates(id);

    const view = mount(id, ALL_BUT('updates:write'));
    await fireEvent.click(await view.findByRole('button', { name: 'Send an update' }));

    expect(await view.findByText('insufficient balance')).not.toBeNull();
    expect(view.container.querySelector('[id^="update-name-"]')).toBeNull();
    expect(view.container.querySelector('[id^="update-payload-"]')).toBeNull();
  });

  function routeTimeline(id: string): void {
    fetchScript.routeJsonRpcMethod('weft.workflows.activities.pending.list', { items: [] });
    fetchScript.routeUrl(`/workflows/${id}/timeline`, [
      {
        step: 1,
        operationType: 'stream',
        operationLabel: 'progress',
        inputSummary: '{"key":"progress"}',
        timestamp: 1_000,
        status: 'completed',
      },
    ]);
    routeRun(id, { id });
  }

  test('links a stream step to its chunks for a caller holding streams:read', async () => {
    const id = 'wf-sections-streams-1';
    routeTimeline(id);

    const view = mount(id, ALL_BUT());

    // The link is in the stream step's detail, so the step is opened first.
    await view.findByText('Stream');
    await openStepNumber(view.container, 1);
    expect(await view.findByRole('button', { name: 'View chunks of progress' })).not.toBeNull();
  });

  test('draws no stream link without streams:read', async () => {
    const id = 'wf-sections-streams-2';
    routeTimeline(id);

    const view = mount(id, ALL_BUT('streams:read'));

    await view.findByText('Stream');
    await openStepNumber(view.container, 1);
    expect(view.queryByRole('button', { name: /View chunks/ })).toBeNull();
  });
});

describe('the lines a run logged', () => {
  function routeLoggedRun(id: string): void {
    fetchScript.routeJsonRpcMethod('weft.workflows.activities.pending.list', { items: [] });
    fetchScript.routeUrl(
      `/workflows/${id}/timeline`,
      [0, 1].map((step) => ({
        step,
        stepIndex: step,
        operationType: 'activity',
        operationLabel: `step${String(step)}`,
        inputSummary: '{}',
        timestamp: 1_000 + step,
        status: 'completed',
      })),
    );
    const line = (sequence: number, step: number, message: string) => ({
      sequence,
      step,
      level: 'info',
      message,
      timestamp: 1_000 + sequence,
      workflowType: 'order-fulfillment',
      truncated: false,
    });
    fetchScript.routeJsonRpcMethod('weft.workflows.logs.list', {
      lines: [line(0, 0, 'charging'), line(1, 1, 'shipping')],
      dropped: 0,
    });
    routeRun(id, { id });
  }

  test('are listed whole in the Details rail and under the step they were logged in front of', async () => {
    const id = 'wf-sections-logs-1';
    routeLoggedRun(id);

    const view = mount(id);

    await fireEvent.click(await view.findByRole('button', { name: /^Logs · 2 lines/ }));
    const rail = await view.findByRole('list', { name: 'Log lines' });
    expect(within(rail).getAllByRole('listitem')).toHaveLength(2);

    await openStepNumber(view.container, 1);
    const step = await view.findByRole('list', { name: 'Log lines of this step' });
    expect(
      within(step)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining('shipping')]);
    // The rail and the step read one query.
    expect(
      jsonRpcMethodsCalled().filter((method) => method === 'weft.workflows.logs.list'),
    ).toHaveLength(1);
  });
});

describe('the revision against the active one (WFT-117)', () => {
  test('is said in the Details rail once the active pointer is read', async () => {
    const id = 'wf-detail-active-rev-1';
    routeRun(id, { id, revision: 'order-rev-a' });
    fetchScript.routeJsonRpcMethod('weft.workflows.active.get', {
      revision: 'order-rev-a',
      generation: 2,
      activatedAt: 500,
    });

    const view = mount(id);

    await waitFor(() =>
      expect(
        [...view.container.querySelectorAll('dt')]
          .find((element) => element.textContent?.trim() === 'Revision')
          ?.nextElementSibling?.textContent?.trim(),
      ).toBe('order-rev-a — active'),
    );
  });

  test('a failed REFETCH does not keep showing the previous successful pointer as current fact (Codex review, PR #978, round 5)', async () => {
    // TanStack Query keeps the previous successful `data` beside `isError: true`; reading `.data`
    // alone would keep labeling a since-superseded run active after the read starts failing.
    const id = 'wf-detail-active-rev-stale-1';
    routeRun(id, { id, revision: 'order-rev-a' });
    // Both calls fall through to the FIFO queue, in order: the first read, then the failed refetch.
    fetchScript.enqueueJson({
      jsonrpc: '2.0',
      id: 1,
      result: { revision: 'order-rev-a', generation: 2, activatedAt: 500 },
    });
    fetchScript.enqueueJson({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32000, message: 'workflows:read required', data: { httpStatus: 403 } },
    });
    const queryClient = newQueryClient();

    const view = mount(id, GRANTED_PRINCIPAL, queryClient);
    await waitFor(() => expect(view.container.textContent).toContain('order-rev-a — active'));

    await queryClient.refetchQueries({ queryKey: queryKeys.catalog.active('order-fulfillment') });

    await waitFor(() => {
      expect(view.container.textContent).toContain('active revision unknown');
    });
  });
});

describe('the page that draws the engine sections', () => {
  test('imports the stylesheet those sections are styled by, which no other module imports', () => {
    const source = readFileSync(new URL('./run-detail.svelte', import.meta.url), 'utf8');
    expect(source).toContain("import '../detail/workflow-detail.css';");
  });
});
