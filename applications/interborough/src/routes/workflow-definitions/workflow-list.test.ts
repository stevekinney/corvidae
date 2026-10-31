/**
 * `/workflows`: the workflows a person can read, joined from the engine's definitions and the
 * Bureau's files. Each row says what the workflow is for, its kind, its agent, what starts it, and
 * how busy it is; the types the Bureau runs for itself sit in a collapsed disclosure; a file the
 * Bureau cannot use is listed with its error and its path, a source that failed to load shows its
 * category, and a source with no file is left out. With no workflow besides the engine's, the page
 * says there are none yet.
 */
import type { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
import { STUB_REMOTE_WORKFLOW_DIRECTORY } from '../../lib/bureau-stub.test-support.ts';
import { queryKeys } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  invalidFile,
  readyFile,
  runFixture,
  scheduleFixture,
  sourceDefinition,
  STUB_WORKFLOW_DIRECTORY,
  type WorkflowStub,
  type World,
} from '../../lib/workflow-world.test-support.ts';
import RouteOutletHarness from './area-harness.test-harness.svelte';

let stub: WorkflowStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function open(overrides: Partial<World> = {}, onQueryClient?: (queryClient: QueryClient) => void) {
  stub = installWorkflowWorld(
    emptyWorld({
      definitions: [
        codeDefinition('order-processing'),
        codeDefinition('agentRun'),
        codeDefinition('goalRun'),
        codeDefinition('durableHeartbeatTick'),
        sourceDefinition('digest'),
        sourceDefinition('flaky', {
          state: 'failed',
          lastFailureCategory: 'timeout',
          contract: null,
          description: null,
        }),
        sourceDefinition('deleted-yesterday'),
      ],
      files: [
        readyFile('digest', {
          agent: 'writer',
          description: 'Writes the daily digest.',
          trigger: { kind: 'schedule', spec: '1h' },
          runs: { active: 1, last24Hours: 12, lastRunAt: new Date(NOW - 3 * MINUTE).toISOString() },
        }),
        readyFile('flaky', {
          agent: null,
          trigger: { kind: 'signal', name: 'deploy' },
          runs: { active: 0, last24Hours: 0, lastRunAt: null },
        }),
        invalidFile('broken'),
      ],
      schedules: [
        scheduleFixture('every-5', 'order-processing', { cronExpression: '*/5 * * * *' }),
      ],
      runs: [
        runFixture('order-1', 'order-processing', { createdAt: NOW - 2 * HOUR }),
        runFixture('order-2', 'order-processing', { createdAt: NOW - 10 * MINUTE }),
        runFixture('order-3', 'order-processing', {
          createdAt: NOW - 30 * HOUR,
          updatedAt: NOW - 30 * HOUR,
        }),
        runFixture('order-4', 'order-processing', { createdAt: NOW - HOUR, status: 'running' }),
      ],
      ...overrides,
    }),
  );
  router.navigate('/workflows', { replace: true });
  return render(RouteOutletHarness, {
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES, onQueryClient },
  } as never);
}

const rowCount = (container: HTMLElement) =>
  container.querySelectorAll('[data-workflow]:not([data-engine])').length;

function row(container: HTMLElement, name: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-workflow="${name}"]`);
  if (found === null) throw new Error(`No row for ${name}.`);
  return found;
}

const testId = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('the list of workflows', () => {
  test('has a row for each definition and file, by name, and leaves out a source with no file and the engine’s own types', async () => {
    const { container, findByRole } = open();
    await findByRole('heading', { level: 1, name: 'Workflows' });
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const names = [...container.querySelectorAll('[data-workflow]')].map((node) =>
      node.getAttribute('data-workflow'),
    );
    expect(names).toEqual(['broken', 'digest', 'flaky', 'order-processing']);
    expect(container.querySelector('[data-workflow="deleted-yesterday"]')).toBeNull();
    expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
  });

  test('links the engine’s own types to a page of their own that counts them, and lists them there with what each does', async () => {
    const { container, findByRole } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const link = await findByRole('link', { name: WORKFLOW_COPY.list.internalWorkflows(3) });
    expect(link.getAttribute('href')).toBe('/internal-workflows');
    expect(container.querySelector('[data-workflow="agentRun"]')).toBeNull();

    link.click();
    await findByRole('heading', { level: 1, name: WORKFLOW_COPY.internal.title });
    await waitFor(() =>
      expect(container.querySelectorAll('[data-workflow][data-engine]').length).toBe(3),
    );
    const names = [...container.querySelectorAll('[data-workflow][data-engine]')].map((node) =>
      node.getAttribute('data-workflow'),
    );
    expect(names).toEqual(['agentRun', 'durableHeartbeatTick', 'goalRun']);
    expect(container.querySelector('[data-workflow="agentRun"] a')?.getAttribute('href')).toBe(
      '/workflows/agentRun',
    );
    // A code name reads as words, with the identifier beside it.
    expect(container.querySelector('[data-workflow="agentRun"] a')?.textContent).toBe('Agent Run');
    expect(container.querySelector('[data-workflow="durableHeartbeatTick"] a')?.textContent).toBe(
      'Durable Heartbeat Tick',
    );
    expect(
      container.querySelector('[data-workflow="agentRun"] [data-testid="workflow-identifier"]')
        ?.textContent,
    ).toBe('agentRun');
    // Each row has a line on what it does: the engine's own, or the words for having none.
    for (const description of container.querySelectorAll(
      '[data-workflow][data-engine] [data-testid="workflow-description"]',
    )) {
      expect(description.textContent?.trim().length).toBeGreaterThan(0);
    }
    expect(container.querySelector('[data-testid="records-count"]')?.textContent).toBe(
      WORKFLOW_COPY.internal.count(3),
    );
  });

  test('says there are no internal workflows on their page when the engine has none of its own', async () => {
    const { container, findByRole } = open({
      definitions: [codeDefinition('order-processing')],
    });
    await findByRole('heading', { level: 1, name: 'Workflows' });
    await waitFor(() => expect(rowCount(container)).toBeGreaterThan(0));
    const link = await findByRole('link', { name: WORKFLOW_COPY.list.internalWorkflows(0) });

    link.click();
    await findByRole('heading', { level: 2, name: WORKFLOW_COPY.internal.empty.title });
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
  });

  test('says the internal workflows could not be loaded, offers Try again, and links back to the workflows', async () => {
    router.navigate('/internal-workflows', { replace: true });
    stub = installWorkflowWorld(emptyWorld({ failBureauFiles: true }));
    const { container, findByRole } = render(RouteOutletHarness, {
      props: { client: stub.client, scopes: AUTHORIZATION_SCOPES },
    } as never);

    await findByRole('heading', { level: 2, name: WORKFLOW_COPY.internal.loadFailed.title });
    expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
    const retry = await findByRole('button', { name: RETRY_LABEL });
    await fireEvent.click(retry);
    await findByRole('heading', { level: 2, name: WORKFLOW_COPY.internal.loadFailed.title });

    const back = await findByRole('link', { name: WORKFLOW_COPY.internal.backToWorkflows });
    back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/internal-workflows');
    back.click();
    expect(router.pathname).toBe('/workflows');
  });

  test('says an internal workflow has no description when the engine gives none', async () => {
    const { container, findByRole } = open({
      definitions: [{ ...codeDefinition('agentRun'), description: null }],
      files: [],
    });
    await findByRole('heading', { level: 1, name: /Workflows|No workflows yet/ });
    router.navigate('/internal-workflows');
    await waitFor(() =>
      expect(
        container.querySelector('[data-workflow="agentRun"] [data-testid="workflow-description"]')
          ?.textContent,
      ).toBe(WORKFLOW_COPY.internal.noDescription),
    );
  });

  test('narrows the rows by a search and by a status word, and says so when none match', async () => {
    const { container, findByRole, findByLabelText } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));
    expect(container.querySelector('[data-testid="records-count"]')?.textContent).toBe(
      WORKFLOW_COPY.list.count(4),
    );

    await fireEvent.change(await findByLabelText(WORKFLOW_COPY.list.statusLabel), {
      target: { value: 'Failed' },
    });
    await waitFor(() => expect(rowCount(container)).toBe(2));
    expect(
      [...container.querySelectorAll('[data-workflow]')].map((node) =>
        node.getAttribute('data-workflow'),
      ),
    ).toEqual(['broken', 'flaky']);

    await fireEvent.input(await findByLabelText(WORKFLOW_COPY.list.searchLabel), {
      target: { value: 'no such workflow' },
    });
    await findByRole('heading', { level: 2, name: WORKFLOW_COPY.list.noMatch.title });
    expect(container.querySelector('[data-cinder-kind="filtered"]')).not.toBeNull();

    const clear = container.querySelector<HTMLButtonElement>(
      '[data-cinder-kind="filtered"] button',
    );
    if (clear === null) throw new Error('The empty state did not offer Clear filters.');
    await fireEvent.click(clear);
    await waitFor(() => expect(rowCount(container)).toBe(4));
  });

  test('badges a file as agent-authored and a code type as code, and shows the agent of a file that names one in monospace', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const digest = row(container, 'digest');
    expect(digest.dataset['kind']).toBe('agent-authored');
    expect(digest.textContent).toContain(WORKFLOW_COPY.agentAuthoredBadge);
    const agent = testId(digest, 'workflow-agent');
    expect(agent?.textContent).toBe('writer');
    expect(agent?.tagName).toBe('CODE');

    const flaky = row(container, 'flaky');
    expect(flaky.textContent).toContain(WORKFLOW_COPY.agentAuthoredBadge);
    expect(testId(flaky, 'workflow-agent')).toBeNull();

    const code = row(container, 'order-processing');
    expect(code.dataset['kind']).toBe('code');
    expect(code.textContent).toContain(WORKFLOW_COPY.codeBadge);
    expect(code.textContent).not.toContain(WORKFLOW_COPY.agentAuthoredBadge);
    expect(testId(code, 'workflow-description')?.textContent).toContain(
      'The order-processing workflow.',
    );
  });

  test('shows a file’s description, its cadence in words, its run counts, and when it last ran', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const digest = row(container, 'digest');
    expect(testId(digest, 'workflow-description')?.textContent).toContain(
      'Writes the daily digest.',
    );
    expect(testId(digest, 'workflow-cadence')?.textContent?.trim()).toBe('Every hour');
    expect(testId(digest, 'workflow-run-counts')?.textContent).toBe(
      '12 runs in 24 hours (1 running)',
    );
    expect(testId(digest, 'workflow-last-run')?.textContent).toBe('last run 3m ago');
  });

  test('names a signal trigger by its signal, in monospace, and says a workflow that never ran has not', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const flaky = row(container, 'flaky');
    const cadence = testId(flaky, 'workflow-cadence');
    expect(cadence?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      `${WORKFLOW_COPY.list.onSignal} deploy`,
    );
    expect(cadence?.querySelector('code')?.textContent).toBe('deploy');
    expect(testId(flaky, 'workflow-run-counts')?.textContent).toBe(WORKFLOW_COPY.list.neverRun);
    expect(testId(flaky, 'workflow-last-run')).toBeNull();
  });

  test('counts a code type from the engine’s own totals, and words its schedule', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const code = row(container, 'order-processing');
    await waitFor(() =>
      expect(testId(code, 'workflow-run-counts')?.textContent).toBe(
        '3 runs in 24 hours (1 running)',
      ),
    );
    expect(testId(code, 'workflow-cadence')?.textContent?.trim()).toBe('Every 5 minutes');
    expect(testId(code, 'workflow-last-run')?.textContent).toBe('last run 10m ago');
    // Nothing is asked of the engine for the types it runs itself, which no one starts.
    const asked = stub?.callsTo('weft.workflows.list').map((call) => call.params['type']);
    expect(new Set(asked)).toEqual(new Set(['order-processing']));
  });

  test('says nothing of a code type’s counts or cadence when the engine would not give them', async () => {
    let queryClient: QueryClient | undefined;
    const { container } = open({ failSchedules: true }, (client) => {
      queryClient = client;
    });
    stub?.on('weft.workflows.list', () => {
      throw new Error('The engine did not answer.');
    });
    await waitFor(() => expect(rowCount(container)).toBe(4));
    // Wait for the query to settle with nothing to show, not merely for the request: until then the
    // page has no counts either way, and a check made before proves nothing.
    const activityKey = queryKeys.workflowCatalog.activity(['order-processing']);
    await waitFor(() =>
      expect(
        queryClient
          ?.getQueryData<ReadonlyMap<string, { runs: unknown; schedules: unknown }>>(activityKey)
          ?.get('order-processing'),
      ).toEqual({ runs: null, schedules: null }),
    );

    const code = row(container, 'order-processing');
    expect(testId(code, 'workflow-run-counts')).toBeNull();
    expect(testId(code, 'workflow-last-run')).toBeNull();
    expect(testId(code, 'workflow-cadence')).toBeNull();
    // A count that failed is left out, never shown as none.
    expect(code.textContent).not.toContain(WORKFLOW_COPY.list.runs(0));
    expect(code.textContent).not.toContain(WORKFLOW_COPY.list.running(0));
    expect(code.textContent).not.toContain(WORKFLOW_COPY.list.neverRun);
    expect(testId(code, 'workflow-description')?.textContent).toContain('order-processing');
  });

  test('shows an invalid file with its message, its issues, and its path, and no counts', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const broken = row(container, 'broken');
    expect(broken.dataset['state']).toBe('invalid');
    expect(broken.dataset['status']).toBe('Failed');
    expect(testId(broken, 'workflow-problem')?.textContent).toContain(
      'The document is not a workflow.',
    );
    expect(testId(broken, 'workflow-issues')?.textContent).toContain('trigger.spec');
    expect(testId(broken, 'workflow-issues')?.textContent).toContain(
      'Not a schedule specification.',
    );
    expect(testId(broken, 'workflow-run-counts')).toBeNull();
    // The path waits for the host to say where the files are, so it is never shown wrong first.
    await waitFor(() =>
      expect(testId(broken, 'workflow-file-path')?.textContent).toBe(
        `${STUB_WORKFLOW_DIRECTORY}/broken.json`,
      ),
    );
    // A file that loaded has none of these.
    expect(testId(row(container, 'digest'), 'workflow-problem')).toBeNull();
  });

  test('shows the category of a source that failed to load, in a label of its own', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const flaky = row(container, 'flaky');
    expect(flaky.dataset['state']).toBe('failed');
    expect(testId(flaky, 'workflow-failure')?.textContent).toBe(
      WORKFLOW_COPY.sourceFailed('timeout'),
    );
    expect(testId(row(container, 'digest'), 'workflow-failure')).toBeNull();
  });

  test('shows a paused file as Paused', async () => {
    const { container } = open({
      files: [readyFile('digest', { paused: true }), invalidFile('broken')],
    });
    await waitFor(() => expect(rowCount(container)).toBeGreaterThan(1));
    expect(row(container, 'digest').dataset['status']).toBe('Paused');
  });

  test('shows the path relative to the state directory when the host does not say where', async () => {
    const { container } = open({ workflowDirectory: null });
    await waitFor(() => expect(rowCount(container)).toBe(4));
    await waitFor(() =>
      expect(testId(row(container, 'broken'), 'workflow-file-path')?.textContent).toBe(
        `${WORKFLOW_COPY.fallbackDirectory}/broken.json`,
      ),
    );
  });

  test('is read once for one visit: the frame’s probe and the page share one load of each service', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));
    expect(stub?.callsTo('weft.workflows.definitions.list')).toHaveLength(1);
    expect(stub?.callsTo('bureau.workflows.list')).toHaveLength(1);
  });

  test('links each name to its page, and leaves a modified click to the browser', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));
    const link = row(container, 'digest').querySelector('a');
    expect(link?.getAttribute('href')).toBe('/workflows/digest');

    link?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(router.pathname).toBe('/workflows');
    link?.click();
    expect(router.pathname).toBe('/workflows/digest');
  });

  test('offers New workflow beside the title, and it opens the editor that makes one', async () => {
    const { container, findByRole } = open();
    const action = await findByRole('link', { name: WORKFLOW_COPY.newAction });
    expect(action.getAttribute('href')).toBe('/workflows/new');
    await waitFor(() => expect(rowCount(container)).toBe(4));
    action.click();
    expect(router.pathname).toBe('/workflows/new');
  });
});

describe('the links the list keeps for the browser', () => {
  test('opens the internal workflows and an engine type’s page, and leaves New workflow to the browser when modified', async () => {
    const { container, findByRole } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const action = await findByRole('link', { name: WORKFLOW_COPY.newAction });
    action.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(router.pathname).toBe('/workflows');

    const internal = await findByRole('link', { name: WORKFLOW_COPY.list.internalWorkflows(3) });
    internal.click();
    expect(router.pathname).toBe('/internal-workflows');
    await waitFor(() =>
      expect(container.querySelector('[data-workflow="agentRun"] a')).not.toBeNull(),
    );
    container.querySelector<HTMLAnchorElement>('[data-workflow="agentRun"] a')?.click();
    expect(router.pathname).toBe('/workflows/agentRun');
  });
});

describe('a host with no workflow of its own', () => {
  test('says there are none yet and where one is written, and keeps the engine’s types on their own page', async () => {
    const { container, findByRole } = open({
      definitions: [codeDefinition('agentRun')],
      files: [],
    });
    await findByRole('heading', { level: 2, name: WORKFLOW_COPY.list.emptyTitle });
    expect(rowCount(container)).toBe(0);

    const guide = container.querySelector('[data-testid="workflows-empty"]');
    expect(guide?.textContent).toContain(WORKFLOW_COPY.list.emptyTool);
    await waitFor(() =>
      expect(testId(container, 'workflow-directory')?.textContent).toBe(STUB_WORKFLOW_DIRECTORY),
    );
    expect(guide?.querySelector('code')?.textContent).toBe(WORKFLOW_COPY.list.emptyTool);

    // New workflow is still the page's own action, and the engine's type is still on its own page.
    expect(await findByRole('link', { name: WORKFLOW_COPY.newAction })).toBeTruthy();
    expect(
      await findByRole('link', { name: WORKFLOW_COPY.list.internalWorkflows(1) }),
    ).toBeTruthy();
    expect(container.querySelector('[data-workflow="agentRun"]')).toBeNull();
  });

  test('is the frame’s own empty state, with the same action, when the engine has no type at all', async () => {
    const { container, findByRole } = open({ definitions: [], files: [] });
    await findByRole('heading', { level: 1, name: 'No workflows yet' });
    expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
      'empty',
    );
    const action = await findByRole('link', { name: 'New workflow' });
    expect(action.getAttribute('href')).toBe('/workflows/new');
  });
});

describe('the list of workflows on a remote host', () => {
  test('shows an invalid file’s location as the host gave it, an s3:// location, with no introduction', async () => {
    const { container } = open({ hostMode: 'remote' });
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const broken = row(container, 'broken');
    await waitFor(() =>
      expect(testId(broken, 'workflow-file-path')?.textContent).toBe(
        `${STUB_REMOTE_WORKFLOW_DIRECTORY}broken.json`,
      ),
    );
    expect(testId(broken, 'workflow-file-path')?.textContent).toMatch(/^s3:\/\//);
    expect(broken.textContent).not.toContain(WORKFLOW_COPY.remote.fileLabel);
  });
});
