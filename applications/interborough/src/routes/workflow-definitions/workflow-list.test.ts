/**
 * `/workflows`: the workflows a person can read, joined from the engine's definitions and the
 * Bureau's files. Each row says what the workflow is for, its kind, its agent, what starts it, and
 * how busy it is; the types the Bureau runs for itself sit in a collapsed disclosure; a file the
 * Bureau cannot use is listed with its error and its path, a source that failed to load shows its
 * category, and a source with no file is left out. With no workflow besides the engine's, the page
 * says there are none yet.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { WORKFLOW_COPY } from '../../app/copy.ts';
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

function open(overrides: Partial<World> = {}) {
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
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES },
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

  test('keeps the engine’s own types under a collapsed disclosure that counts them', async () => {
    const { container, findByRole } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const trigger = await findByRole('button', { name: WORKFLOW_COPY.list.engineWorkflows(3) });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-workflow="agentRun"]')).toBeNull();

    await fireEvent.click(trigger);
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'));
    const names = [...container.querySelectorAll('[data-workflow][data-engine]')].map((node) =>
      node.getAttribute('data-workflow'),
    );
    expect(names).toEqual(['agentRun', 'durableHeartbeatTick', 'goalRun']);
    expect(container.querySelector('[data-workflow="agentRun"] a')?.getAttribute('href')).toBe(
      '/workflows/agentRun',
    );
  });

  test('has no disclosure when the engine has none of its own types to show', async () => {
    const { container, findByRole } = open({
      definitions: [codeDefinition('order-processing')],
    });
    await findByRole('heading', { level: 1, name: 'Workflows' });
    await waitFor(() => expect(rowCount(container)).toBeGreaterThan(0));
    expect(container.textContent).not.toContain('Engine workflows');
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
    const { container } = open();
    stub?.on('weft.workflows.list', () => {
      throw new Error('The engine did not answer.');
    });
    stub?.on('GET /schedules', () => {
      throw new Error('The engine did not answer.');
    });
    await waitFor(() => expect(rowCount(container)).toBe(4));
    await waitFor(() => expect(stub?.callsTo('weft.workflows.list').length).toBeGreaterThan(0));

    const code = row(container, 'order-processing');
    expect(testId(code, 'workflow-run-counts')).toBeNull();
    expect(testId(code, 'workflow-last-run')).toBeNull();
    expect(testId(code, 'workflow-description')?.textContent).toContain('order-processing');
  });

  test('shows an invalid file with its message, its issues, and its path, and no counts', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const broken = row(container, 'broken');
    expect(broken.dataset['state']).toBe('invalid');
    expect(broken.textContent).toContain(WORKFLOW_COPY.invalidBadge);
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

  test('badges a paused file as paused', async () => {
    const { container } = open({
      files: [readyFile('digest', { paused: true }), invalidFile('broken')],
    });
    await waitFor(() => expect(rowCount(container)).toBeGreaterThan(1));
    expect(row(container, 'digest').textContent).toContain(WORKFLOW_COPY.pausedBadge);
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

describe('a host with no workflow of its own', () => {
  test('says there are none yet and where one is written, and keeps the engine’s types under the disclosure', async () => {
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

    // New workflow is still the page's own action, and the engine's type is still behind its disclosure.
    expect(await findByRole('link', { name: WORKFLOW_COPY.newAction })).toBeTruthy();
    const trigger = await findByRole('button', { name: WORKFLOW_COPY.list.engineWorkflows(1) });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
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
