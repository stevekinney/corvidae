/**
 * `/workflows`: the workflows a person can read, joined from the engine's definitions and the
 * Bureau's files, as Cinder's status-first rows. Each row has a status word only when the workflow
 * is paused or cannot load, its title with the identifier beside it, when it last ran at the right
 * edge, and its steps and counts under it. Segments (All, Paused, Problems) count the rows they show;
 * one card below the rows leads to the types the Bureau runs for itself, counted from the same
 * catalog; a file the Bureau cannot use is listed first with its file and its problem, a source that
 * failed to load shows its category, and a source with no file is left out. With no workflow
 * besides the engine's, the page is its first-use state under its own header.
 */
import type { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
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

const TWO_STEPS = [
  { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'One.' } },
  { kind: 'sleep', duration: '5m' },
];

/** The three types the sample world's Bureau registers for itself, and one code-defined workflow. */
function sampleWorld(overrides: Partial<World> = {}): World {
  return emptyWorld({
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
        title: 'Daily digest',
        agent: 'writer',
        description: 'Writes the daily digest.',
        trigger: { kind: 'schedule', spec: '1h' },
        steps: TWO_STEPS,
        runs: { active: 1, last24Hours: 12, lastRunAt: new Date(NOW - 3 * MINUTE).toISOString() },
      }),
      readyFile('flaky', {
        agent: null,
        trigger: { kind: 'signal', name: 'deploy' },
        runs: { active: 0, last24Hours: 0, lastRunAt: null },
      }),
      invalidFile('broken'),
    ],
    schedules: [scheduleFixture('every-5', 'order-processing', { cronExpression: '*/5 * * * *' })],
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
  });
}

function open(
  overrides: Partial<World> = {},
  onQueryClient?: (queryClient: QueryClient) => void,
  path = '/workflows',
) {
  stub = installWorkflowWorld(sampleWorld(overrides));
  router.navigate(path, { replace: true });
  return render(RouteOutletHarness, {
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES, onQueryClient },
  } as never);
}

const rowCount = (container: HTMLElement) =>
  container.querySelectorAll('[data-workflow]:not([data-engine])').length;

const names = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-workflow]:not([data-engine])')].map((node) =>
    node.getAttribute('data-workflow'),
  );

function row(container: HTMLElement, name: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-workflow="${name}"]`);
  if (found === null) throw new Error(`No row for ${name}.`);
  return found;
}

const testId = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** The parts of line two of a row, in order. */
const partsOf = (root: HTMLElement) =>
  [...root.querySelectorAll('.ib-workflow-line__part')].map((part) => part.textContent?.trim());

/** A filter segment by its word and its count, whose accessible name is "All, 4". */
function segment(view: ReturnType<typeof within>, word: string, count: number): HTMLElement {
  return view.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*${String(count)}$`) });
}

describe('the list of workflows', () => {
  test('has a row for each definition and file, by name, problems first, and leaves out a source with no file and the engine’s own types', async () => {
    const { container, findByRole } = open();
    await findByRole('heading', { level: 1, name: 'Workflows' });
    await waitFor(() => expect(rowCount(container)).toBe(4));

    expect(names(container)).toEqual(['broken', 'flaky', 'digest', 'order-processing']);
    expect(container.querySelector('[data-workflow="deleted-yesterday"]')).toBeNull();
    expect(container.querySelector('[data-workflow="agentRun"]')).toBeNull();
    expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
    // Rows, not a table: no column of kind, starts or runs.
    expect(container.querySelector('table')).toBeNull();
  });

  test('says what the page is under its heading, and offers a secondary icon-only New workflow that opens the builder', async () => {
    const { container, findByRole, findByText } = open();
    await findByRole('heading', { level: 1, name: 'Workflows' });
    expect(await findByText(WORKFLOW_COPY.list.subtitle)).not.toBeNull();

    const action = await findByRole('link', { name: WORKFLOW_COPY.newAction });
    expect(action.getAttribute('href')).toBe('/workflows/new');
    // It is the header's own icon, with its name for a screen reader and no visible words.
    expect(action.textContent?.trim()).toBe('');
    expect(action.closest('.cinder-page-header')).not.toBeNull();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    action.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(router.pathname).toBe('/workflows');
    action.click();
    expect(router.pathname).toBe('/workflows/new');
  });

  test('titles a row from its file with the identifier beside it once, and shows a file with no title by its identifier alone', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const digest = row(container, 'digest');
    expect(digest.textContent).toContain('Daily digest');
    expect(testId(digest, 'workflow-identifier')?.textContent).toBe('digest');
    expect(testId(digest, 'workflow-identifier')?.tagName).toBe('CODE');
    expect(digest.querySelectorAll('[data-testid="workflow-identifier"]')).toHaveLength(1);

    // A file with no title is its identifier alone, in monospace, with nothing beside it.
    const flaky = row(container, 'flaky');
    expect(testId(flaky, 'workflow-identifier')).toBeNull();
    expect(flaky.querySelector('code.ib-workflow-row__id')?.textContent).toBe('flaky');
  });

  test('says when a file last ran at the right edge, what is running first under the title, then its steps and how many runs began lately, and never the date twice', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const digest = row(container, 'digest');
    // A run is going, so the edge says when it began.
    expect(testId(digest, 'workflow-last-run')?.textContent).toMatch(/^Started /);
    expect(partsOf(digest)).toEqual(['Running', '2 steps', '12 runs in 24 hours']);
    // A run does not give the workflow a status word of its own.
    expect(digest.dataset['status']).toBeUndefined();
    expect(digest.textContent).not.toContain('last ran');
  });

  test('says a workflow that never ran has not, at the right edge, and says nothing of runs under it', async () => {
    const { container } = open({
      files: [
        readyFile('quiet', {
          steps: TWO_STEPS,
          runs: { active: 0, last24Hours: 0, lastRunAt: null },
        }),
      ],
      definitions: [sourceDefinition('quiet')],
    });
    await waitFor(() => expect(rowCount(container)).toBe(1));
    const quiet = row(container, 'quiet');
    expect(testId(quiet, 'workflow-last-run')?.textContent).toBe(WORKFLOW_COPY.list.neverRun);
    expect(partsOf(quiet)).toEqual(['2 steps']);
  });

  test('counts a code type from the engine’s own totals, and asks the engine nothing of the types it runs itself', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const code = row(container, 'order-processing');
    await waitFor(() => expect(partsOf(code)).toEqual(['Running', '3 runs in 24 hours']));
    expect(testId(code, 'workflow-last-run')?.textContent).toMatch(/^Started /);
    const asked = stub?.callsTo('weft.workflows.list').map((call) => call.params['type']);
    expect(new Set(asked)).toEqual(new Set(['order-processing']));
  });

  test('says nothing of a code type’s counts or date when the engine would not give them, and never zero or never run', async () => {
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
    expect(testId(code, 'workflow-last-run')).toBeNull();
    expect(partsOf(code)).toEqual([]);
    expect(code.textContent).not.toContain(WORKFLOW_COPY.list.neverRun);
    expect(code.textContent).not.toContain(WORKFLOW_COPY.list.runs(0));
  });

  test('has Can’t load for a file the Bureau cannot use, with its file and its problem under the identifier, and no counts', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const broken = row(container, 'broken');
    expect(broken.dataset['state']).toBe('invalid');
    expect(broken.dataset['status']).toBe(WORKFLOW_COPY.list.statusCantLoad);
    expect(broken.textContent).toContain(WORKFLOW_COPY.list.statusCantLoad);
    expect(testId(broken, 'workflow-last-run')?.textContent).toBe(WORKFLOW_COPY.list.neverRun);
    expect(partsOf(broken)).toEqual(['broken.json', 'The document is not a workflow.']);
    expect(testId(broken, 'workflow-problem')?.textContent).toContain(
      'The document is not a workflow.',
    );
    expect(testId(broken, 'workflow-run-counts')).toBeNull();
    // A file that loaded has none of these.
    expect(testId(row(container, 'digest'), 'workflow-problem')).toBeNull();
  });

  test('has Can’t load for a source that failed to load, with the category of the failure under it', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const flaky = row(container, 'flaky');
    expect(flaky.dataset['state']).toBe('failed');
    expect(flaky.dataset['status']).toBe(WORKFLOW_COPY.list.statusCantLoad);
    expect(testId(flaky, 'workflow-failure')?.textContent?.trim()).toBe(
      WORKFLOW_COPY.sourceFailed('timeout'),
    );
    expect(testId(row(container, 'digest'), 'workflow-failure')).toBeNull();
  });

  test('has Paused in the status column of a paused file, and nothing in the column of any other', async () => {
    const { container } = open({
      files: [readyFile('digest', { paused: true, steps: TWO_STEPS }), invalidFile('broken')],
    });
    await waitFor(() => expect(rowCount(container)).toBeGreaterThan(1));
    expect(row(container, 'digest').dataset['status']).toBe('Paused');
    expect(row(container, 'digest').textContent).toContain('Paused');
    expect(row(container, 'order-processing').dataset['status']).toBeUndefined();
  });

  test('is read once for one visit: the frame’s probe and the page share one load of each service', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));
    expect(stub?.callsTo('weft.workflows.definitions.list')).toHaveLength(1);
    expect(stub?.callsTo('bureau.workflows.list')).toHaveLength(1);
  });

  test('links each row to its page, and leaves a modified click to the browser', async () => {
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
});

describe('the segments of the list', () => {
  test('count the rows each shows, All 4, Paused 0 and Problems 2 here, and Problems narrows to the two that cannot load', async () => {
    const { container } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));
    const view = within(container);
    expect(segment(view, 'All', 4)).not.toBeNull();
    expect(segment(view, 'Paused', 0)).not.toBeNull();
    expect(segment(view, 'Problems', 2)).not.toBeNull();
    // The types the Bureau runs for itself are not workflows of the list, so they are not counted.
    expect(container.querySelector('[data-workflow="goalRun"]')).toBeNull();

    await fireEvent.click(segment(view, 'Problems', 2));
    await waitFor(() => expect(names(container)).toEqual(['broken', 'flaky']));
    // The counts do not move with the choice, and the header keeps its action.
    expect(segment(view, 'All', 4)).not.toBeNull();
    expect(await view.findByRole('link', { name: WORKFLOW_COPY.newAction })).toBeTruthy();
  });

  test('count a paused file under Paused, and a source that failed under Problems even when its file is paused', async () => {
    const { container } = open({
      files: [
        readyFile('digest', { paused: true, steps: TWO_STEPS }),
        readyFile('flaky', { paused: true }),
        invalidFile('broken'),
      ],
    });
    await waitFor(() => expect(rowCount(container)).toBe(4));
    const view = within(container);
    expect(segment(view, 'All', 4)).not.toBeNull();
    expect(segment(view, 'Paused', 1)).not.toBeNull();
    expect(segment(view, 'Problems', 2)).not.toBeNull();

    await fireEvent.click(segment(view, 'Paused', 1));
    await waitFor(() => expect(names(container)).toEqual(['digest']));
  });

  test('keep the heading, the action and the Internal workflows card over a segment that shows nothing, and Clear filters brings the rows back', async () => {
    const { container, findByRole, findByText } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));
    const view = within(container);

    await fireEvent.click(segment(view, 'Paused', 0));
    await findByRole('heading', { level: 2, name: WORKFLOW_COPY.list.noMatch.title });
    expect(container.querySelector('[data-cinder-kind="filtered"]')).not.toBeNull();
    expect(rowCount(container)).toBe(0);
    expect(await findByText(WORKFLOW_COPY.list.subtitle)).not.toBeNull();
    expect(testId(container, 'internal-workflows-card')).not.toBeNull();

    await fireEvent.click(await findByRole('button', { name: WORKFLOW_COPY.list.clearAction }));
    await waitFor(() => expect(rowCount(container)).toBe(4));
  });
});

describe('the Internal workflows card', () => {
  test('counts the types the Bureau runs for itself from the catalog, and the whole card is a link to their page', async () => {
    const { container, findByRole } = open();
    await waitFor(() => expect(rowCount(container)).toBe(4));

    const card = testId(container, 'internal-workflows-card');
    expect(card?.tagName).toBe('A');
    expect(card?.getAttribute('href')).toBe('/internal-workflows');
    expect(card?.textContent).toContain(WORKFLOW_COPY.list.internalCard.title);
    expect(card?.textContent).toContain(WORKFLOW_COPY.list.internalCard.description);
    expect(testId(container, 'internal-workflows-count')?.textContent).toBe('3 workflows');
    // The card sits after the rows, not above them.
    const list = container.querySelector('ul');
    expect(list !== null && card !== null && list.compareDocumentPosition(card) === 4).toBe(true);

    card?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(router.pathname).toBe('/workflows');
    card?.click();
    await findByRole('heading', { level: 1, name: WORKFLOW_COPY.internal.title });
    expect(router.pathname).toBe('/internal-workflows');
  });

  test('follows the catalog’s own count, one type or four, and is not drawn when the engine holds none', async () => {
    const one = open({
      definitions: [codeDefinition('order-processing'), codeDefinition('agentRun')],
      files: [],
    });
    await waitFor(() =>
      expect(testId(one.container, 'internal-workflows-count')?.textContent).toBe('1 workflow'),
    );
    // The one type of its own is not a row of the list, and the one workflow is.
    expect(rowCount(one.container)).toBe(1);
    cleanup();
    stub?.restore();

    const four = open({
      definitions: [
        codeDefinition('order-processing'),
        codeDefinition('agentRun'),
        codeDefinition('goalRun'),
        codeDefinition('durableHeartbeatTick'),
        codeDefinition('scheduleTick'),
      ],
    });
    await waitFor(() =>
      expect(testId(four.container, 'internal-workflows-count')?.textContent).toBe('4 workflows'),
    );
    cleanup();
    stub?.restore();

    const none = open({ definitions: [codeDefinition('order-processing')], files: [] });
    await waitFor(() => expect(rowCount(none.container)).toBe(1));
    expect(testId(none.container, 'internal-workflows-card')).toBeNull();
  });
});

describe('a host with no workflow of its own', () => {
  test('is the page’s own first-use state under its header, with two actions and where a file is added, and no filter row or Internal workflows card', async () => {
    const { container, findByRole, findAllByRole, findByText } = open({
      definitions: [codeDefinition('agentRun')],
      files: [],
    });
    await findByRole('heading', { level: 2, name: WORKFLOW_COPY.list.empty.title });
    expect(await findByRole('heading', { level: 1, name: 'Workflows' })).toBeTruthy();
    expect(await findByText(WORKFLOW_COPY.list.subtitle)).not.toBeNull();
    expect(rowCount(container)).toBe(0);
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
    expect(container.textContent).toContain(WORKFLOW_COPY.list.empty.description);

    // Header "+" and the primary action are both New workflow.
    const makers = await findAllByRole('link', { name: WORKFLOW_COPY.newAction });
    expect(makers).toHaveLength(2);
    for (const maker of makers) expect(maker.getAttribute('href')).toBe('/workflows/new');
    const ask = await findByRole('link', { name: WORKFLOW_COPY.list.empty.askAction });
    expect(ask.getAttribute('href')).toBe('/chats/new?from=workflows');
  });

  test('has no filter row and no Internal workflows card, though the engine holds a type of its own', async () => {
    const { container, findByRole } = open({
      definitions: [codeDefinition('agentRun')],
      files: [],
    });
    await findByRole('heading', { level: 2, name: WORKFLOW_COPY.list.empty.title });
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(container.querySelector('.cinder-filter-bar')).toBeNull();
    expect(testId(container, 'internal-workflows-card')).toBeNull();
    expect(container.querySelector('[data-workflow="agentRun"]')).toBeNull();
  });

  test('says where a file is added as plain text, in monospace, naming the host’s own directory when it says', async () => {
    const { container, findByRole } = open({ definitions: [], files: [] });
    await findByRole('heading', { level: 2, name: WORKFLOW_COPY.list.empty.title });
    expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
      'empty',
    );
    const hint = testId(container, 'workflows-empty-hint');
    expect(hint?.textContent).toContain(WORKFLOW_COPY.list.empty.hintBefore);
    expect(hint?.querySelector('a')).toBeNull();
    await waitFor(() =>
      expect(testId(container, 'workflow-directory')?.textContent).toBe(STUB_WORKFLOW_DIRECTORY),
    );
    expect(testId(container, 'workflow-directory')?.tagName).toBe('CODE');
  });

  test('names the usual directory when the host does not say, and the host’s location when it keeps its files in a bucket', async () => {
    const usual = open({ definitions: [], files: [], workflowDirectory: null });
    await usual.findByRole('heading', { level: 2, name: WORKFLOW_COPY.list.empty.title });
    await waitFor(() =>
      expect(testId(usual.container, 'workflow-directory')?.textContent).toBe(
        WORKFLOW_COPY.list.empty.hintDirectory,
      ),
    );
    cleanup();
    stub?.restore();

    const remote = open({ definitions: [], files: [], hostMode: 'remote' });
    await remote.findByRole('heading', { level: 2, name: WORKFLOW_COPY.list.empty.title });
    await waitFor(() =>
      expect(testId(remote.container, 'workflow-directory')?.textContent).toBe(
        STUB_REMOTE_WORKFLOW_DIRECTORY,
      ),
    );
  });
});

describe('the internal workflows page', () => {
  function openInternal(overrides: Partial<World> = {}, onQueryClient?: (q: QueryClient) => void) {
    return open(overrides, onQueryClient, '/internal-workflows');
  }

  test('is an operator table in its own box of the types the Bureau runs, in the words Interborough gives them, each name a link to that workflow’s runs and its code name under it', async () => {
    const { container, findByRole } = openInternal();
    await findByRole('heading', { level: 1, name: WORKFLOW_COPY.internal.title });
    await waitFor(() =>
      expect(container.querySelectorAll('[data-workflow][data-engine]').length).toBe(3),
    );
    expect([...container.querySelectorAll('th')].map((cell) => cell.textContent?.trim())).toEqual([
      'Workflow',
      'What it does',
      'Runs',
      'Last run',
    ]);
    expect(container.textContent).toContain(WORKFLOW_COPY.internal.description);

    const names = [...container.querySelectorAll('[data-workflow][data-engine]')].map((node) =>
      node.getAttribute('data-workflow'),
    );
    expect(names).toEqual(['agentRun', 'durableHeartbeatTick', 'goalRun']);

    const chat = row(container, 'agentRun');
    expect(chat.querySelector('a')?.textContent).toBe('Chat with an agent');
    expect(chat.querySelector('a')?.getAttribute('href')).toBe('/workflows/agentRun/runs');
    // The code name is small, monospaced and not a link.
    expect(testId(chat, 'workflow-identifier')?.textContent).toBe('agentRun');
    expect(testId(chat, 'workflow-identifier')?.tagName).toBe('CODE');
    expect(testId(chat, 'workflow-identifier')?.closest('a')).toBeNull();
    expect(testId(chat, 'workflow-description')?.textContent?.trim()).toBe(
      WORKFLOW_COPY.internal.types.agentRun.description,
    );
    expect(row(container, 'goalRun').querySelector('a')?.textContent).toBe('Goal attempts');
    expect(row(container, 'durableHeartbeatTick').querySelector('a')?.textContent).toBe(
      'Schedule tick',
    );
  });

  test('has no Start run, Edit or Pause action, no “+”, and no link back to Workflows', async () => {
    const { container, findByRole, queryByRole } = openInternal();
    await findByRole('heading', { level: 1, name: WORKFLOW_COPY.internal.title });
    await waitFor(() =>
      expect(container.querySelectorAll('[data-workflow][data-engine]').length).toBe(3),
    );
    expect(queryByRole('button')).toBeNull();
    expect(queryByRole('link', { name: WORKFLOW_COPY.newAction })).toBeNull();
    expect(container.querySelector('a[href="/workflows"]')).toBeNull();
    // Only the three names are links.
    expect(container.querySelectorAll('a')).toHaveLength(3);
    expect(container.querySelector('[data-testid="records-toolbar"]')).toBeNull();
  });

  test('counts each type’s runs and says when it last ran, from the engine’s own totals, and says never run for one that has not', async () => {
    const { container, findByRole } = openInternal({
      runs: [
        runFixture('a-1', 'agentRun', { createdAt: NOW - 10 * MINUTE }),
        runFixture('a-2', 'agentRun', { createdAt: NOW - 3 * 24 * HOUR }),
      ],
    });
    await findByRole('heading', { level: 1, name: WORKFLOW_COPY.internal.title });
    await waitFor(() =>
      expect(testId(row(container, 'agentRun'), 'workflow-run-counts')?.textContent).toBe('2'),
    );

    const chat = row(container, 'agentRun');
    expect(testId(chat, 'workflow-last-run')?.textContent).toMatch(
      /^(Today, |[A-Z][a-z]{2} \d{1,2}, )\d{1,2}:\d{2} [AP]M$/,
    );
    const goal = row(container, 'goalRun');
    expect(testId(goal, 'workflow-run-counts')?.textContent).toBe('0');
    expect(testId(goal, 'workflow-last-run')?.textContent).toBe(WORKFLOW_COPY.internal.neverRun);
    // Only the types the page lists are counted, one read of one item each.
    const asked = stub?.callsTo('weft.workflows.list');
    expect(new Set(asked?.map((call) => call.params['type']))).toEqual(
      new Set(['agentRun', 'durableHeartbeatTick', 'goalRun']),
    );
    for (const call of asked ?? []) expect(call.params['limit']).toBe(1);
  });

  test('leaves the Runs and Last run cells blank when the engine would not count, never zero', async () => {
    let queryClient: QueryClient | undefined;
    const { container, findByRole } = openInternal({}, (client) => {
      queryClient = client;
    });
    stub?.on('weft.workflows.list', () => {
      throw new Error('The engine did not answer.');
    });
    await findByRole('heading', { level: 1, name: WORKFLOW_COPY.internal.title });
    const key = queryKeys.workflowCatalog.internalActivity([
      'agentRun',
      'durableHeartbeatTick',
      'goalRun',
    ]);
    await waitFor(() =>
      expect(
        queryClient?.getQueryData<ReadonlyMap<string, unknown>>(key)?.get('agentRun'),
      ).toBeNull(),
    );
    for (const name of ['agentRun', 'durableHeartbeatTick', 'goalRun']) {
      expect(testId(row(container, name), 'workflow-run-counts')?.textContent).toBe('');
      expect(testId(row(container, name), 'workflow-last-run')?.textContent).toBe('');
    }
  });

  test('says why there are none in terms of the engine, not as a promise, when it registered none', async () => {
    const { findByRole, container } = openInternal({
      definitions: [codeDefinition('order-processing')],
    });
    await findByRole('heading', { level: 2, name: WORKFLOW_COPY.internal.empty.title });
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
    expect(container.textContent).toContain(WORKFLOW_COPY.internal.empty.description);
    expect(container.textContent).not.toContain('This installation does not run');
  });

  test('says the internal workflows could not be loaded, and offers Try again, with no link back', async () => {
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
    expect(container.querySelector('a[href="/workflows"]')).toBeNull();
  });
});
