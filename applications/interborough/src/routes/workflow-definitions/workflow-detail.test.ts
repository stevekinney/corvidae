/**
 * `/workflows/:workflow`: the definition and the schedules that start it, for a code-defined type, and
 * also the steps, trigger, owning agent, file path, revisions that have run, and the actions on
 * the file, for an agent-authored one. Pause, resume, and delete show the new state without a
 * reload, and a file that changed on disk shows the "changed outside Interborough" state and
 * changes nothing. The send-signal form is its own case.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { VIEW_COPY, WORKFLOW_COPY } from '../../app/copy.ts';
import { STUB_REMOTE_WORKFLOW_DIRECTORY, StubFault } from '../../lib/bureau-stub.test-support.ts';
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
  workflowFaults,
  type RevisionFixture,
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

const REVISION: RevisionFixture = {
  workflowVersion: 'version-ran',
  firstRunAt: '2026-10-19T08:00:00.000Z',
  lastRunAt: '2026-10-19T09:00:00.000Z',
  document: { name: 'digest', trigger: { kind: 'schedule', spec: '0 6 * * *' }, steps: [] },
};

function open(path: string, overrides: Partial<World> = {}) {
  stub = installWorkflowWorld(
    emptyWorld({
      definitions: [
        codeDefinition('order-processing'),
        sourceDefinition('digest', { signals: ['approve'] }),
      ],
      files: [
        readyFile('digest'),
        invalidFile('broken'),
        invalidFile('unreadable', { hash: null }),
      ],
      schedules: [
        scheduleFixture('every-5', 'order-processing'),
        scheduleFixture('nightly', 'order-processing', { status: 'paused' }),
        scheduleFixture('retired-generation', 'order-processing', { status: 'cancelled' }),
        scheduleFixture('elsewhere', 'something-else'),
      ],
      revisions: { digest: [REVISION] },
      // Weft has an installed version that never ran; the Bureau's history must not show it.
      installedRevisions: { digest: [{ revision: 'version-saved-never-ran' }] },
      ...overrides,
    }),
  );
  router.navigate(path, { replace: true });
  return render(RouteOutletHarness, {
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES },
  } as never);
}

const page = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-page="workflow-detail"]');

/** The page, once what the type is has been read: its Overview, the tab it opens on, follows it. */
async function ready(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() =>
    expect(page(container)?.querySelector('[data-testid="workflow-overview"]')).toBeTruthy(),
  );
  return page(container) as HTMLElement;
}

const testId = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** A tab's name without the count that follows its label once the count is known ("Runs 2"). */
const withoutCount = (label: string | undefined) => label?.trim().replace(/\s+\d+$/, '');

/** Opens a tab of the page by its name. */
async function openTab(root: HTMLElement, name: string): Promise<void> {
  const tab = [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (candidate) => withoutCount(candidate.textContent) === name,
  );
  if (tab === undefined) throw new Error(`No tab called ${name}.`);
  await fireEvent.click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
}

const tabNames = (root: HTMLElement) =>
  [...root.querySelectorAll('[role="tab"]')].map((tab) => withoutCount(tab.textContent));

const TABS = WORKFLOW_COPY.page.tabs;

/** The views' queries the menu helpers need. */
type Queries = Pick<ReturnType<typeof open>, 'findByRole'>;

/** Opens the "⋯" menu and chooses an item by its name: Pause, Duplicate or Delete… are there. */
async function chooseFromMenu(view: Queries, name: string): Promise<void> {
  await fireEvent.click(await view.findByRole('button', { name: WORKFLOW_COPY.page.menu.label }));
  await fireEvent.click(await view.findByRole('menuitem', { name }));
}

/** Pauses the file from the "⋯" menu. */
const pauseFromMenu = (view: Queries) => chooseFromMenu(view, WORKFLOW_COPY.page.menu.pause);

/** Opens the delete dialog from the "⋯" menu, for the workflow whose header reads `name`. */
async function openDeleteDialog(view: Queries, name: string): Promise<HTMLElement> {
  await chooseFromMenu(view, WORKFLOW_COPY.page.menu.delete);
  return view.findByRole('dialog', { name: WORKFLOW_COPY.deleteDialog.title(name) });
}

/** The page once a file is running again: the header has no Resume. */
async function running(view: Pick<ReturnType<typeof open>, 'queryByRole'>): Promise<void> {
  await waitFor(() =>
    expect(
      view.queryByRole('button', { name: WORKFLOW_COPY.resumeAction })?.outerHTML ?? null,
    ).toBeNull(),
  );
}

describe('a code-defined type', () => {
  test('leads with what it is for, what starts it, and its runs, and has no row whose value is none', async () => {
    const { container } = open('/workflows/order-processing');
    const root = await ready(container);
    expect(root.querySelector('h1')?.textContent).toContain('order-processing');
    // Nothing beside the title says where the workflow is defined, and no status stands in for Active.
    expect(root.textContent).not.toContain(WORKFLOW_COPY.agentAuthoredBadge);
    expect(testId(root, 'workflow-state')).toBeNull();
    expect(testId(root, 'workflow-description')?.textContent).toBe(
      'The order-processing workflow.',
    );
    // Two schedules start it, so the header counts them, and the section below lists each.
    await waitFor(() =>
      expect(testId(root, 'workflow-line-starts')?.textContent).toContain(
        WORKFLOW_COPY.page.header.startsFromMany(2),
      ),
    );
    expect(testId(root, 'workflow-line-starts')?.textContent).toContain(
      WORKFLOW_COPY.page.header.startYourself,
    );
    expect(root.textContent).not.toMatch(/\bNone\b/);
    expect(root.textContent).not.toContain('No description');
  });

  test('shows its input and output as field lists, and its signals and queries, on the Overview', async () => {
    const { container } = open('/workflows/order-processing');
    const root = await ready(container);
    expect(tabNames(root)).toEqual([TABS.overview, TABS.code, TABS.runs, TABS.history]);

    // One line per field, the name humanised, and the raw schema behind a disclosure.
    const input = testId(root, 'workflow-input-schema');
    const output = testId(root, 'workflow-output-schema');
    expect(input?.textContent).toContain('Order ID');
    expect(output?.textContent).toContain('Shipped');
    expect(root.querySelector('pre')).toBeNull();
    const definition = testId(root, 'workflow-definition');
    expect(definition?.textContent).toContain('pause-it');
    expect(definition?.textContent).toContain('progress');
    expect(testId(root, 'workflow-file-path')).toBeNull();
  });

  test('has no row for what its contract lacks, and says it declares no schema', async () => {
    const { container } = open('/workflows/order-processing', {
      definitions: [
        codeDefinition('order-processing', {
          signals: null,
          updates: null,
          queries: null,
          contract: null,
          description: null,
        }),
      ],
    });
    const root = await ready(container);
    expect(testId(root, 'workflow-definition')).toBeNull();
    expect(testId(root, 'workflow-input-schema')?.textContent).toContain(
      WORKFLOW_COPY.page.overview.noSchema,
    );
    expect(testId(root, 'workflow-output-schema')?.textContent).toContain(
      WORKFLOW_COPY.page.overview.noSchema,
    );
    expect(testId(root, 'workflow-description')).toBeNull();
    expect(root.textContent).not.toMatch(/\bNone\b/);
  });

  test('shows only the rows of its contract that it has', async () => {
    const { container } = open('/workflows/order-processing', {
      definitions: [
        codeDefinition('order-processing', {
          signals: ['pause-it'],
          updates: null,
          queries: null,
          contract: null,
        }),
      ],
    });
    const root = await ready(container);
    const definition = testId(root, 'workflow-definition');
    expect(definition?.textContent).toContain(WORKFLOW_COPY.page.signals);
    expect(definition?.textContent).not.toContain(WORKFLOW_COPY.page.updates);
    expect(definition?.textContent).not.toContain(WORKFLOW_COPY.page.queries);
  });

  test('lists the active and paused schedules that start it, and not a cancelled generation or another type’s', async () => {
    const { container } = open('/workflows/order-processing');
    const root = await ready(container);
    await waitFor(() => expect(root.querySelectorAll('[data-schedule]').length).toBe(2));

    const items = [...root.querySelectorAll<HTMLElement>('[data-schedule]')];
    expect(items.map((item) => [item.dataset['schedule'], item.dataset['status']])).toEqual([
      ['every-5', 'active'],
      ['nightly', 'paused'],
    ]);
    expect(stub?.callsTo('GET /schedules')[0]?.params).toMatchObject({
      workflowType: 'order-processing',
    });
  });

  test('has no schedules section, and says nothing of one, when none starts it', async () => {
    const { container } = open('/workflows/order-processing', { schedules: [] });
    const root = await ready(container);
    await waitFor(() => expect(stub?.callsTo('GET /schedules').length).toBeGreaterThan(0));
    expect(testId(root, 'workflow-schedules')).toBeNull();
    expect(testId(root, 'workflow-line-starts')).toBeNull();
  });

  test('keeps the engine’s revision panel, and its install form, on the History tab', async () => {
    const { container } = open('/workflows/order-processing');
    const root = await ready(container);
    expect(root.querySelector('.weft-revisions-panel')).toBeNull();
    expect(stub?.callsTo('weft.workflows.revisions.list')).toEqual([]);

    await openTab(root, TABS.history);
    await waitFor(() => expect(root.querySelector('.weft-revisions-panel')).not.toBeNull());
    expect(stub?.callsTo('weft.workflows.revisions.list')[0]?.params).toEqual({
      name: 'order-processing',
    });
    expect(stub?.callsTo('bureau.workflows.revisions')).toEqual([]);
  });

  test('offers none of a file’s actions, and links to its runs', async () => {
    const { container } = open('/workflows/order-processing');
    const root = await ready(container);

    const buttons = [...root.querySelectorAll('button, a')].map((node) => node.textContent?.trim());
    for (const label of [
      WORKFLOW_COPY.pauseAction,
      WORKFLOW_COPY.resumeAction,
      WORKFLOW_COPY.deleteAction,
      WORKFLOW_COPY.editAction,
    ]) {
      expect(buttons).not.toContain(label);
    }
    expect(testId(root, 'workflow-signal')).toBeNull();
    expect(testId(root, 'workflow-file-path')).toBeNull();
    // It starts from the run setup page, which the header links to.
    const start = [...root.querySelectorAll('a')].find(
      (link) => link.textContent?.trim() === WORKFLOW_COPY.page.startAction,
    );
    expect(start?.getAttribute('href')).toBe('/workflows/order-processing/run');
    await openTab(root, TABS.runs);
    const all = [...root.querySelectorAll('a')].find(
      (link) => link.textContent?.trim() === WORKFLOW_COPY.runsAction,
    );
    expect(all?.getAttribute('href')).toBe('/workflows/order-processing/runs');
  });

  test('shows its newest runs, newest first, each a link to the run', async () => {
    const { container } = open('/workflows/order-processing', {
      runs: Array.from({ length: 7 }, (_, index) =>
        runFixture(`run-${String(index)}`, 'order-processing', {
          createdAt: 1_760_000_000_000 + index * 10_000,
          updatedAt: 1_760_000_000_000 + index * 10_000 + 3000,
          status: index === 6 ? 'running' : 'completed',
        }),
      ),
    });
    const root = await ready(container);
    await openTab(root, TABS.runs);
    await waitFor(() => expect(root.querySelectorAll('[data-run]').length).toBe(7));
    const runs = [...root.querySelectorAll<HTMLElement>('[data-run]')];
    expect(runs.map((run) => run.dataset['run'])).toEqual([
      'run-6',
      'run-5',
      'run-4',
      'run-3',
      'run-2',
      'run-1',
      'run-0',
    ]);
    expect(runs[0]?.dataset['status']).toBe('Running');
    expect(runs[0]?.querySelector('a')?.getAttribute('href')).toBe(
      '/workflows/order-processing/runs/run-6',
    );
    // A run that has ended says how long it took, at the end of line two.
    expect(runs[1]?.textContent).toContain('3 s');
  });

  test('shows the compact empty state when nothing has run it, whose hint names the header’s Start run', async () => {
    const { container } = open('/workflows/order-processing', { runs: [] });
    const root = await ready(container);
    await openTab(root, TABS.runs);
    await waitFor(() =>
      expect(testId(root, 'workflow-recent-runs')?.textContent).toContain(
        WORKFLOW_COPY.page.runs.emptyTitle,
      ),
    );
    expect(
      testId(root, 'workflow-recent-runs')?.querySelector('.cinder-empty-state'),
    ).not.toBeNull();
    expect(testId(root, 'workflow-runs-hint')?.textContent).toBe(WORKFLOW_COPY.page.runs.emptyHint);
  });
});

describe('the recent runs', () => {
  test('say they could not be loaded, rather than that there are none', async () => {
    const { container } = open('/workflows/digest');
    stub?.on('bureau.workflows.runs.list', () => {
      throw workflowFaults.unavailable();
    });
    const root = await ready(container);
    await openTab(root, TABS.runs);
    await waitFor(() =>
      expect(testId(root, 'workflow-recent-runs')?.textContent).toContain(
        WORKFLOW_COPY.page.runsFailed,
      ),
    );
    expect(testId(root, 'workflow-recent-runs')?.textContent).not.toContain(
      WORKFLOW_COPY.page.runs.emptyTitle,
    );
  });

  test('link each run to its page', async () => {
    const { container } = open('/workflows/order-processing', {
      runs: [runFixture('run-1', 'order-processing')],
    });
    const root = await ready(container);
    await openTab(root, TABS.runs);
    await waitFor(() => expect(root.querySelectorAll('[data-run]').length).toBeGreaterThan(0));
    const link = root.querySelector<HTMLAnchorElement>('[data-run] a');
    const href = link?.getAttribute('href') ?? '';
    expect(href).toMatch(/^\/workflows\/order-processing\/runs\//);
    link?.click();
    expect(router.pathname).toBe(href);
  });
});

describe('a type with several signals', () => {
  test('lists them in one row, separated by commas', async () => {
    const { container } = open('/workflows/order-processing', {
      definitions: [
        codeDefinition('order-processing', {
          signals: ['pause-it', 'resume-it'],
          updates: null,
          queries: null,
          contract: null,
        }),
      ],
    });
    const root = await ready(container);
    const row = [...root.querySelectorAll('dd')].find((entry) =>
      entry.textContent?.includes('pause-it'),
    );
    expect(row?.textContent?.replace(/\s+/g, ' ').trim()).toBe('pause-it, resume-it');
  });
});

describe('a type the Bureau registers for itself', () => {
  test('has only Overview and Runs, because there is no source to show and no revision to install', async () => {
    const { container } = open('/workflows/agentRun', {
      definitions: [codeDefinition('agentRun')],
    });
    const root = await ready(container);
    expect(tabNames(root)).toEqual([TABS.overview, TABS.runs]);
    expect(stub?.callsTo('weft.workflows.revisions.list')).toEqual([]);
  });

  test('is titled in words with its identifier on the built-in line, says what it is, and leads to the rest', async () => {
    const { container, getByRole, queryByRole } = open('/workflows/agentRun', {
      definitions: [codeDefinition('agentRun')],
    });
    const root = await ready(container);
    expect(root.querySelector('h1')?.textContent).toContain(
      WORKFLOW_COPY.internal.types.agentRun.title,
    );
    expect(testId(root, 'workflow-description')?.textContent).toBe(
      WORKFLOW_COPY.page.internalSummaryByType.agentRun,
    );
    const line = testId(root, 'workflow-line-built-in');
    expect(line?.textContent).toContain(WORKFLOW_COPY.page.header.builtIn);
    expect(line?.querySelector('code')?.textContent).toBe('agentRun');
    expect(line?.textContent).toContain(
      WORKFLOW_COPY.page.header.startedByPrefix('chats and schedules'),
    );
    expect(testId(root, 'workflow-internal-note')?.textContent).toContain(
      WORKFLOW_COPY.page.internalOverviewByType.agentRun,
    );
    // It offers no Start run, no Edit, and no menu, and a button leads to the other internal workflows.
    expect(getByRole('link', { name: WORKFLOW_COPY.page.seeInternal }).getAttribute('href')).toBe(
      '/internal-workflows',
    );
    const labels = [...root.querySelectorAll('button, a')].map((node) => node.textContent?.trim());
    for (const label of [WORKFLOW_COPY.page.startAction, WORKFLOW_COPY.editAction]) {
      expect(labels).not.toContain(label);
    }
    expect(queryByRole('button', { name: WORKFLOW_COPY.page.menu.label })).toBeNull();
    expect(testId(root, 'workflow-steps')).toBeNull();
  });
});

describe('an agent-authored type', () => {
  test('leads with its title and identifier, what it is for, what starts it, and the agent it runs as, and shows Active by absence', async () => {
    const { container } = open('/workflows/digest', {
      files: [
        readyFile('digest', { description: 'Writes the daily digest.', title: 'Daily digest' }),
      ],
    });
    const root = await ready(container);

    // The heading is the title with its identifier beside it once; no badge or word says it is active.
    expect(root.querySelector('h1')?.textContent).toContain('Daily digest');
    expect(testId(root, 'workflow-identifier')?.textContent).toBe('digest');
    expect(root.textContent).not.toContain(WORKFLOW_COPY.agentAuthoredBadge);
    expect(testId(root, 'workflow-state')).toBeNull();
    expect(testId(root, 'workflow-description')?.textContent).toBe('Writes the daily digest.');
    const starts = testId(root, 'workflow-line-starts')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(starts).toBe(
      [
        'Starts every day at 06:00',
        WORKFLOW_COPY.page.header.startYourself,
        WORKFLOW_COPY.page.header.runsAs('Writer'),
      ].join(', '),
    );
    // The steps are numbered rows with a title, a kind line, and what the step does.
    const steps = [...(testId(root, 'workflow-steps')?.querySelectorAll('li') ?? [])];
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringContaining('Ask an agent, Writer'),
      expect.stringContaining('approve'),
    ]);
    expect(steps[0]?.textContent).toContain('Write it.');
    expect(root.textContent).toContain(`${WORKFLOW_COPY.stepsLabel} 2`);
  });

  test('names a signal trigger by its signal, in monospace', async () => {
    const { container } = open('/workflows/digest', {
      files: [
        readyFile('digest', {
          text: JSON.stringify({
            name: 'digest',
            trigger: { kind: 'signal', name: 'deploy' },
            steps: [{ kind: 'sleep', duration: '1m' }],
          }),
        }),
      ],
    });
    const root = await ready(container);
    const starts = testId(root, 'workflow-line-starts');
    expect(starts?.textContent?.replace(/\s+/g, ' ').trim()).toContain(
      `${WORKFLOW_COPY.page.header.startsOnSignal.before}deploy${WORKFLOW_COPY.page.header.startsOnSignal.after}`,
    );
    expect(starts?.querySelector('code')?.textContent).toBe('deploy');
  });

  test('names its file on the last-run line, and its path and read-only source on the Code tab', async () => {
    const { container } = open('/workflows/digest');
    const root = await ready(container);
    expect(tabNames(root)).toEqual([TABS.overview, TABS.code, TABS.runs, TABS.history]);
    // Nothing has run it, so the line says so, and the file is named as a file.
    const last = testId(root, 'workflow-line-last-run');
    await waitFor(() => expect(last?.textContent).toContain(WORKFLOW_COPY.page.header.neverRun));
    expect(last?.querySelector('code')?.textContent).toBe('digest.json');
    // The path and the trigger as written are not repeated on the Overview.
    expect(testId(root, 'workflow-file-path')).toBeNull();
    expect(testId(root, 'workflow-trigger-source')).toBeNull();
    await openTab(root, TABS.code);
    expect(testId(root, 'workflow-file-path')?.textContent).toBe(
      `${STUB_WORKFLOW_DIRECTORY}/digest.json`,
    );
    expect(testId(root, 'workflow-code')?.textContent).toContain(
      WORKFLOW_COPY.page.code.caption.after.trim(),
    );
    await openTab(root, TABS.overview);
    // Its accepted signals are the signals its steps wait for, not what the engine lists.
    const signals = testId(root, 'workflow-accepted-signals');
    expect(signals?.textContent).toContain('approve');
    expect(signals?.textContent).not.toContain('pause-it');
  });

  test('keeps the versions that have run on the History tab, shows none the engine merely installed, and cannot activate', async () => {
    const { container } = open('/workflows/digest');
    const root = await ready(container);
    expect(testId(root, 'workflow-revisions')).toBeNull();

    await openTab(root, TABS.history);
    await waitFor(() =>
      expect(testId(root, 'workflow-revisions')?.textContent).toContain('version-ran'),
    );

    const revisions = testId(root, 'workflow-revisions');
    expect(revisions?.textContent).not.toContain('version-saved-never-ran');
    expect(stub?.callsTo('weft.workflows.revisions.list')).toEqual([]);
    // The page reads the versions once, for the tab's count, and the tab shows that same list.
    expect(stub?.callsTo('bureau.workflows.revisions')).toHaveLength(1);
    expect(stub?.callsTo('bureau.workflows.revisions')[0]?.params).toEqual({ id: 'digest' });
    expect(revisions?.querySelector('button')).toBeNull();
    expect(root.textContent).not.toContain('Activate');
  });

  test('puts the number of runs and of versions after the labels of Runs and History once they are known', async () => {
    const { container } = open('/workflows/digest', {
      runs: [
        runFixture('digest-run-1', 'digest', { createdAt: 1_760_000_000_000 }),
        runFixture('digest-run-2', 'digest', { createdAt: 1_760_000_100_000, status: 'failed' }),
      ],
    });
    const root = await ready(container);
    await waitFor(() =>
      expect(
        [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim()),
      ).toEqual([
        TABS.overview,
        TABS.code,
        WORKFLOW_COPY.page.tabWithCount(TABS.runs, 2),
        WORKFLOW_COPY.page.tabWithCount(TABS.history, 1),
      ]),
    );
    // The newest run is the last run: its date is a link to the run, with its outcome beside it.
    const last = testId(root, 'workflow-line-last-run');
    await waitFor(() =>
      expect(last?.querySelector('a')?.getAttribute('href')).toBe(
        '/workflows/digest/runs/digest-run-2',
      ),
    );
    expect(last?.textContent).toContain('Failed');
  });

  test('shows the rest, with no definition of its own, when the engine has none for the file yet', async () => {
    const { container } = open('/workflows/digest', { definitions: [] });
    const root = await ready(container);
    expect(testId(root, 'workflow-steps')).not.toBeNull();
    expect(testId(root, 'workflow-accepted-signals')?.textContent).toContain('approve');
  });

  test('shows its last runs from the Bureau’s own list of its instances', async () => {
    const { container } = open('/workflows/digest', {
      runs: [
        runFixture('digest-run-1', 'digest', { createdAt: 1_760_000_000_000 }),
        runFixture('digest-run-2', 'digest', { createdAt: 1_760_000_100_000, status: 'failed' }),
      ],
    });
    const root = await ready(container);
    await openTab(root, TABS.runs);
    await waitFor(() => expect(root.querySelectorAll('[data-run]').length).toBe(2));
    expect(
      [...root.querySelectorAll<HTMLElement>('[data-run]')].map((run) => run.dataset['run']),
    ).toEqual(['digest-run-2', 'digest-run-1']);
    expect(stub?.callsTo('bureau.workflows.runs.list')[0]?.params).toEqual({
      workflow: 'digest',
      limit: 20,
    });
    expect(stub?.callsTo('GET /workflows')).toEqual([]);
  });

  test('offers edit in the header, and pause, delete and send signal in the menu, for a file that loaded', async () => {
    const view = open('/workflows/digest');
    const { container, getByRole, queryByRole } = view;
    await ready(container);
    expect(queryByRole('button', { name: WORKFLOW_COPY.pauseAction })).toBeNull();
    expect(queryByRole('button', { name: WORKFLOW_COPY.resumeAction })).toBeNull();
    expect(queryByRole('button', { name: WORKFLOW_COPY.deleteAction })).toBeNull();
    expect(getByRole('link', { name: WORKFLOW_COPY.editAction }).getAttribute('href')).toBe(
      '/workflows/digest/edit',
    );
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.page.menu.label }));
    expect(
      await view.findByRole('menuitem', { name: WORKFLOW_COPY.page.menu.pause }),
    ).not.toBeNull();
    expect(view.getByRole('menuitem', { name: WORKFLOW_COPY.page.menu.delete })).not.toBeNull();
    // Send a signal is in the "⋯" menu, and the form is a dialog that is not on the page until chosen.
    expect(testId(container, 'workflow-signal')).toBeNull();
    expect(getByRole('button', { name: WORKFLOW_COPY.page.menu.label })).not.toBeNull();
  });

  test('shows a paused file as paused beside its title, with Resume as the header’s primary action and no Pause', async () => {
    const view = open('/workflows/digest', {
      files: [readyFile('digest', { paused: true })],
    });
    const { container, getByRole, queryByRole } = view;
    const root = await ready(container);
    expect(testId(root, 'workflow-state')?.textContent).toContain(WORKFLOW_COPY.page.statusPaused);
    expect(getByRole('button', { name: WORKFLOW_COPY.resumeAction })).not.toBeNull();
    expect(queryByRole('link', { name: WORKFLOW_COPY.page.startAction })).toBeNull();
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.page.menu.label }));
    await view.findByRole('menuitem', { name: WORKFLOW_COPY.page.menu.delete });
    expect(queryByRole('menuitem', { name: WORKFLOW_COPY.page.menu.pause })).toBeNull();
    expect(queryByRole('menuitem', { name: WORKFLOW_COPY.resumeAction })).toBeNull();
  });
});

describe('an invalid file', () => {
  test('shows its problem in a banner under the tabs, and its path and source on the Code tab, with delete and edit and no definition or schemas', async () => {
    const view = open('/workflows/broken');
    const { container, getByRole, queryByRole } = view;
    const root = await ready(container);

    const banner = testId(root, 'workflow-file-problem');
    expect(banner).not.toBeNull();
    expect(testId(root, 'workflow-problem')?.textContent).toContain(
      'The document is not a workflow.',
    );
    expect(testId(root, 'workflow-problem')?.textContent).toContain(
      WORKFLOW_COPY.page.problem.startOff,
    );
    expect(testId(root, 'workflow-issues')?.textContent).toContain('trigger.spec');
    expect(testId(root, 'workflow-definition')).toBeNull();
    expect(testId(root, 'workflow-schemas')).toBeNull();
    // The title is its identifier, and a red "Can't load" beside it.
    expect(root.querySelector('h1')?.textContent).toContain('broken');
    expect(testId(root, 'workflow-state')?.textContent).toContain("Can't load");
    // It keeps all four tabs: its runs, its history, and its source are still there to read.
    expect(tabNames(root)).toEqual([TABS.overview, TABS.code, TABS.runs, TABS.history]);
    expect(queryByRole('button', { name: WORKFLOW_COPY.pauseAction })).toBeNull();
    expect(queryByRole('button', { name: WORKFLOW_COPY.resumeAction })).toBeNull();
    // Its menu holds Delete… alone: it cannot be paused, sent a signal, or copied.
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.page.menu.label }));
    const menuItems = await view.findAllByRole('menuitem');
    expect(menuItems.map((item) => item.textContent?.trim())).toEqual([
      WORKFLOW_COPY.page.menu.delete,
    ]);
    await fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // Start run is shown and off, and the banner says why.
    expect(
      getByRole('button', { name: WORKFLOW_COPY.page.startAction }).getAttribute('aria-disabled'),
    ).toBe('true');
    // Edit opens the editor straight on its JSON, and "Open Code" opens the tab with the text.
    expect(getByRole('link', { name: WORKFLOW_COPY.editAction }).getAttribute('href')).toBe(
      '/workflows/broken/edit?tab=json',
    );
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.page.problem.openCode }));
    await waitFor(() => expect(router.search.get('tab')).toBe('code'));
    await waitFor(() =>
      expect(testId(root, 'workflow-file-path')?.textContent).toBe(
        `${STUB_WORKFLOW_DIRECTORY}/broken.json`,
      ),
    );
    expect(testId(root, 'workflow-file-source')?.textContent).toContain('"name": "broken"');
  });

  test('says which line a file’s JSON stops on, marks the line before it, and offers Edit as JSON', async () => {
    const text = ['{', '  "name": "broken"', '  "steps": []', '}'].join('\n');
    const { container, getByRole } = open('/workflows/broken?tab=code', {
      files: [
        invalidFile('broken', {
          text,
          problem: { code: 'invalid-json', message: 'The file is not valid JSON.', issues: null },
        }),
      ],
    });
    await waitFor(() => expect(testId(container, 'workflow-code')).not.toBeNull());
    const root = page(container) as HTMLElement;
    expect(testId(root, 'workflow-problem')?.textContent).toContain(
      WORKFLOW_COPY.page.problem.located(
        'broken.json',
        3,
        WORKFLOW_COPY.page.problem.expectedComma,
      ),
    );
    // The mark is under the line the missing comma belongs to, and the parser's line is named.
    await waitFor(() =>
      expect(testId(root, 'workflow-code')?.querySelector('[role="note"]')?.textContent).toContain(
        WORKFLOW_COPY.page.problem.missingComma(3),
      ),
    );
    expect(getByRole('button', { name: WORKFLOW_COPY.page.problem.editAsJson })).not.toBeNull();
  });

  test('has no action at all when it has no hash, because nothing can be written against it', async () => {
    const { container, queryByRole } = open('/workflows/unreadable');
    const root = await ready(container);
    expect(testId(root, 'workflow-problem')).not.toBeNull();
    for (const label of [WORKFLOW_COPY.deleteAction, WORKFLOW_COPY.pauseAction]) {
      expect(queryByRole('button', { name: label })).toBeNull();
    }
    expect(queryByRole('link', { name: WORKFLOW_COPY.editAction })).toBeNull();
    // With nothing it can do, it has no "⋯" menu either.
    expect(queryByRole('button', { name: WORKFLOW_COPY.page.menu.label })).toBeNull();
  });
});

describe('pause, resume, and delete', () => {
  test('pause shows the paused state without a reload, and the next action uses the new hash', async () => {
    const view = open('/workflows/digest');
    const { container, findByRole, getByRole } = view;
    const root = await ready(container);

    await pauseFromMenu(view);
    await findByRole('button', { name: WORKFLOW_COPY.resumeAction });
    expect(root.textContent).toContain(WORKFLOW_COPY.pausedBadge);
    expect(stub?.callsTo('bureau.workflows.pause')[0]?.params).toEqual({
      id: 'digest',
      expectedHash: 'hash-1',
    });
    expect(stub?.file('digest')?.paused).toBe(true);

    // The file has a new hash, which the next write names: it is not stale against its own write.
    const pausedHash = stub?.file('digest')?.hash;
    expect(pausedHash).not.toBe('hash-1');
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.resumeAction }));
    await running(view);
    expect(root.textContent).not.toContain(WORKFLOW_COPY.pausedBadge);
    expect(stub?.callsTo('bureau.workflows.resume')[0]?.params['expectedHash']).toBe(pausedHash);
    expect(stub?.file('digest')?.paused).toBe(false);
    expect(root.querySelector('[data-condition="stale"]')).toBeNull();
  });

  test('delete confirms, removes the file, and goes to the list', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);

    const dialog = await openDeleteDialog(view, 'digest');
    // Nothing is deleted until it is confirmed.
    expect(stub?.callsTo('bureau.workflows.delete')).toEqual([]);
    await fireEvent.click(
      within(dialog).getByRole('button', { name: WORKFLOW_COPY.deleteDialog.confirm }),
    );

    await waitFor(() => expect(router.pathname).toBe('/workflows'));
    expect(stub?.callsTo('bureau.workflows.delete')[0]?.params).toEqual({
      id: 'digest',
      expectedHash: 'hash-1',
    });
    expect(stub?.file('digest')).toBeUndefined();
  });

  test('an invalid file that has a hash can be deleted', async () => {
    const view = open('/workflows/broken');
    await ready(view.container);
    const dialog = await openDeleteDialog(view, 'broken');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: WORKFLOW_COPY.deleteDialog.confirm }),
    );
    await waitFor(() => expect(router.pathname).toBe('/workflows'));
    expect(stub?.callsTo('bureau.workflows.delete')[0]?.params['expectedHash']).toBe('hash-bad');
  });
});

describe('a file that changed on disk after the page loaded', () => {
  function changeOnDisk(): void {
    const file = stub?.file('digest');
    if (file === undefined) throw new Error('The file is missing.');
    file.hash = 'hash-edited-by-hand';
    file.agent = 'editor';
  }

  test('shows the changed-outside state on pause, with a reload action, and changes nothing', async () => {
    const view = open('/workflows/digest');
    const { container, findByRole, queryByRole } = view;
    const root = await ready(container);
    changeOnDisk();

    await pauseFromMenu(view);
    expect(await findByRole('button', { name: WORKFLOW_COPY.stale.action })).not.toBeNull();
    expect(root.textContent).toContain(WORKFLOW_COPY.stale.title);
    expect(root.dataset['condition']).toBe('stale');
    expect(stub?.file('digest')?.paused).toBe(false);
    expect(stub?.file('digest')?.hash).toBe('hash-edited-by-hand');
    // Pause is still offered, not shown as done.
    expect(queryByRole('button', { name: WORKFLOW_COPY.resumeAction })).toBeNull();
  });

  test('shows it on delete too, and deletes nothing', async () => {
    const view = open('/workflows/digest');
    const { container, findByRole } = view;
    await ready(container);
    changeOnDisk();

    const dialog = await openDeleteDialog(view, 'digest');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: WORKFLOW_COPY.deleteDialog.confirm }),
    );

    expect(await findByRole('button', { name: WORKFLOW_COPY.stale.action })).not.toBeNull();
    expect(stub?.file('digest')).toBeDefined();
    expect(router.pathname).toBe('/workflows/digest');
  });

  test('reloads what is on disk and then acts on it', async () => {
    const view = open('/workflows/digest');
    const { container, findByRole, queryByRole } = view;
    const root = await ready(container);
    changeOnDisk();
    await pauseFromMenu(view);
    await fireEvent.click(await findByRole('button', { name: WORKFLOW_COPY.stale.action }));

    await waitFor(() => expect(root.dataset['condition']).toBe('ready'));
    expect(queryByRole('button', { name: WORKFLOW_COPY.stale.action })).toBeNull();
    expect(testId(root, 'workflow-line-starts')?.textContent).toContain(
      WORKFLOW_COPY.page.header.runsAs('Editor'),
    );

    await pauseFromMenu(view);
    await findByRole('button', { name: WORKFLOW_COPY.resumeAction });
    expect(stub?.file('digest')?.paused).toBe(true);
  });

  test('is the not-found state when the file was deleted outside Interborough', async () => {
    const view = open('/workflows/digest');
    const { container, findByRole } = view;
    await ready(container);
    if (stub !== undefined) stub.world.files = [];

    await pauseFromMenu(view);
    await findByRole('heading', { level: 1, name: WORKFLOW_COPY.page.notFound.title });
    await waitFor(() =>
      expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
        'not-found',
      ),
    );
  });
});

/** Opens the "⋯" menu and chooses Send a signal, which opens the dialog that holds the form. */
async function openSignalDialog(view: ReturnType<typeof open>): Promise<HTMLElement> {
  await fireEvent.click(await view.findByRole('button', { name: WORKFLOW_COPY.page.menu.label }));
  await fireEvent.click(
    await view.findByRole('menuitem', { name: WORKFLOW_COPY.page.menu.sendSignal }),
  );
  return waitFor(() => {
    const form = testId(view.container, 'workflow-signal');
    expect(form).not.toBeNull();
    return form as HTMLElement;
  });
}

describe('send signal', () => {
  test('is a dialog the menu opens, and is not on the Overview where people read', async () => {
    const view = open('/workflows/digest');
    const root = await ready(view.container);
    expect(testId(root, 'workflow-signal')).toBeNull();
    await openSignalDialog(view);
    expect(await view.findByRole('dialog', { name: WORKFLOW_COPY.signal.heading })).not.toBeNull();
  });

  test('starts with the first awaited signal name when the trigger is not a signal', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    await openSignalDialog(view);
    expect(
      (view.getByRole('textbox', { name: WORKFLOW_COPY.signal.nameLabel }) as HTMLInputElement)
        .value,
    ).toBe('approve');
  });

  test('starts with the trigger’s signal name when the trigger is a signal', async () => {
    const text = JSON.stringify({
      name: 'on-demand',
      trigger: { kind: 'signal', name: 'begin' },
      steps: [{ kind: 'await-signal', signal: 'approve' }],
    });
    const view = open('/workflows/on-demand', {
      definitions: [sourceDefinition('on-demand')],
      files: [readyFile('on-demand', { text })],
    });
    await ready(view.container);
    await openSignalDialog(view);
    expect(
      (view.getByRole('textbox', { name: WORKFLOW_COPY.signal.nameLabel }) as HTMLInputElement)
        .value,
    ).toBe('begin');
  });

  test('sends the name and the parsed payload, and shows how many were started and reached', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    stub!.world.signalAnswer = { started: ['run-1'], delivered: ['run-2', 'run-3'], rejected: [] };
    const form = await openSignalDialog(view);

    await fireEvent.input(view.getByRole('textbox', { name: WORKFLOW_COPY.signal.payloadLabel }), {
      target: { value: '{"approved": true}' },
    });
    await fireEvent.click(view.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction }));

    const result = await within(form).findByRole('status', {
      name: WORKFLOW_COPY.signal.resultLabel,
    });
    expect(result.textContent).toContain(WORKFLOW_COPY.signal.result(1, 2));
    expect(stub?.callsTo('bureau.workflows.signal')[0]?.params).toEqual({
      name: 'approve',
      payload: { approved: true },
    });
  });

  test('sends no payload when the editor is empty', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    const form = await openSignalDialog(view);
    await fireEvent.click(view.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction }));
    await within(form).findByRole('status', { name: WORKFLOW_COPY.signal.resultLabel });
    expect(stub?.callsTo('bureau.workflows.signal')[0]?.params).toEqual({ name: 'approve' });
  });

  test('refuses a payload that is not JSON, and sends nothing', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    await openSignalDialog(view);
    await fireEvent.input(view.getByRole('textbox', { name: WORKFLOW_COPY.signal.payloadLabel }), {
      target: { value: '{ nope' },
    });
    await fireEvent.click(view.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction }));
    expect(await view.findByText(WORKFLOW_COPY.signal.invalidPayload)).not.toBeNull();
    expect(stub?.callsTo('bureau.workflows.signal')).toEqual([]);
  });

  test('does not send without a name', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    await openSignalDialog(view);
    await fireEvent.input(view.getByRole('textbox', { name: WORKFLOW_COPY.signal.nameLabel }), {
      target: { value: '  ' },
    });
    expect(view.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction })).toBeDisabled();
  });

  test('closes with Close, and the form is gone', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    await openSignalDialog(view);
    await fireEvent.click(view.getByRole('button', { name: WORKFLOW_COPY.page.menu.closeSignal }));
    await waitFor(() =>
      expect(testId(view.container, 'workflow-signal')?.outerHTML ?? null).toBeNull(),
    );
  });
});

describe('a type with little to show', () => {
  test('says nothing of what the engine does not declare, and shows when a schedule last fired', async () => {
    const { container } = open('/workflows/plain', {
      definitions: [
        codeDefinition('plain', {
          description: null,
          revision: null,
          signals: null,
          updates: null,
          queries: null,
          contract: { name: 'plain', workflowVersion: '1' },
        }),
      ],
      files: [],
      schedules: [
        scheduleFixture('hourly', 'plain', {
          cronExpression: undefined as never,
          intervalMs: 3_600_000,
          lastFireAt: Date.now() - 60_000,
        }),
      ],
    });
    const root = await ready(container);
    // The contract declares no signal, update, query, or schema, so there are no facts to list.
    expect(testId(root, 'workflow-definition')).toBeNull();
    expect(testId(root, 'workflow-description')).toBeNull();
    expect(root.textContent).not.toMatch(/\bNone\b/);
    await waitFor(() => expect(root.querySelectorAll('[data-schedule]').length).toBe(1));
    expect(root.querySelector('[data-schedule="hourly"]')?.textContent).toContain('ago');
  });

  test('has no steps to list for a file with none', async () => {
    const text = JSON.stringify({
      name: 'empty',
      trigger: { kind: 'signal', name: 'go' },
      steps: [],
    });
    const { container } = open('/workflows/empty', {
      definitions: [],
      files: [readyFile('empty', { text })],
    });
    const root = await ready(container);
    expect(root.textContent).toContain(WORKFLOW_COPY.page.overview.stepsEmptyTitle);
    expect(testId(root, 'workflow-steps')).toBeNull();
  });

  test('shows a file whose text is not a workflow document without its trigger and steps', async () => {
    const view = open('/workflows/odd', {
      definitions: [],
      files: [readyFile('odd', { text: '{ not json' })],
    });
    const root = await ready(view.container);
    expect(testId(root, 'workflow-line-starts')?.textContent).not.toContain('Starts');
    expect(testId(root, 'workflow-steps')).toBeNull();
    // With no document, no signal name to start the form with.
    const form = await openSignalDialog(view);
    expect(form.querySelector('input')?.value).toBe('');
  });
});

describe('a part of the page that fails', () => {
  test('says the schedules could not be loaded, and shows the rest', async () => {
    const { container } = open('/workflows/order-processing', { failSchedules: true });
    const root = await ready(container);
    await waitFor(() =>
      expect(root.querySelector('[role="alert"]')?.textContent).toContain(
        WORKFLOW_COPY.page.schedulesFailed,
      ),
    );
    expect(testId(root, 'workflow-definition')).not.toBeNull();
  });

  test('says the revision history could not be loaded, and shows the rest', async () => {
    const { container } = open('/workflows/digest');
    stub?.on('bureau.workflows.revisions', () => {
      throw workflowFaults.unprocessable('No history.');
    });
    const root = await ready(container);
    await openTab(root, TABS.history);
    await waitFor(() =>
      expect(testId(root, 'workflow-revisions')?.textContent).toContain(
        WORKFLOW_COPY.revisions.failed,
      ),
    );
    expect(testId(root, 'workflow-revisions')).not.toBeNull();
  });

  test('says the workflow could not be loaded when the page’s own read fails after the frame’s, and reads again on retry', async () => {
    const { container, findByRole } = open('/workflows/digest');
    let reads = 0;
    const original = stub?.world.files[0];
    stub?.on('bureau.workflows.get', () => {
      reads += 1;
      // The frame's probe reads first and finds the file; the page's read is refused.
      if (reads === 1 || reads > 2) return original;
      throw workflowFaults.unprocessable('Refused.');
    });
    await waitFor(() =>
      expect(container.querySelector('[data-page="workflow-detail"] [role="alert"]')).toBeTruthy(),
    );
    expect(container.textContent).toContain(WORKFLOW_COPY.loadFailed.title);
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await ready(container);
    expect(container.textContent).not.toContain(WORKFLOW_COPY.loadFailed.title);
  });
});

describe('a write the Bureau refuses', () => {
  test('says the installation does not let you, for a forbidden pause, and the alert can be dismissed', async () => {
    const view = open('/workflows/digest');
    const { container, findByRole, queryByText } = view;
    await ready(container);
    stub?.on('bureau.workflows.pause', () => {
      throw new StubFault('Forbidden', 403, 'No.');
    });
    await pauseFromMenu(view);
    const alert = await findByRole('alert');
    expect(alert.textContent).toContain(WORKFLOW_COPY.pauseFailed);
    expect(alert.textContent).toContain(WORKFLOW_COPY.forbidden);
    await fireEvent.click(within(alert).getByRole('button'));
    await waitFor(() =>
      expect(queryByText(WORKFLOW_COPY.pauseFailed)?.outerHTML ?? null).toBeNull(),
    );
  });

  test('says only that the pause failed for a fault that names nothing this page can act on', async () => {
    const view = open('/workflows/digest');
    const { container, findByRole } = view;
    await ready(container);
    stub?.on('bureau.workflows.pause', () => {
      throw workflowFaults.conflict('agent-file-exists');
    });
    await pauseFromMenu(view);
    const alert = await findByRole('alert');
    expect(alert.textContent).toContain(WORKFLOW_COPY.pauseFailed);
    expect(alert.textContent).not.toContain('already used');
  });

  test('shows the Bureau’s own words when it could not apply a resume or a delete', async () => {
    const view = open('/workflows/digest', {
      files: [readyFile('digest', { paused: true })],
    });
    const { container, findByText, getByRole } = view;
    await ready(container);
    stub?.on('bureau.workflows.resume', () => {
      throw workflowFaults.unavailable();
    });
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.resumeAction }));
    expect(await findByText(WORKFLOW_COPY.resumeFailed)).not.toBeNull();
    expect(await findByText('The engine did not answer.')).not.toBeNull();

    stub?.on('bureau.workflows.delete', () => {
      throw workflowFaults.unavailable();
    });
    const dialog = await openDeleteDialog(view, 'digest');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: WORKFLOW_COPY.deleteDialog.confirm }),
    );
    // A delete the Bureau refused stays in the dialog, in its words, and the button is the retry.
    await waitFor(() => expect(dialog.textContent).toContain('The engine did not answer.'));
    expect(dialog.textContent).toContain(WORKFLOW_COPY.deleteDialog.failedTitle);
    expect(router.pathname).toBe('/workflows/digest');
  });

  test('is a failure to reload, in words, when the file cannot be read again', async () => {
    const view = open('/workflows/digest');
    const { container, findByRole } = view;
    await ready(container);
    const file = stub?.file('digest');
    if (file === undefined) throw new Error('The file is missing.');
    file.hash = 'hash-by-hand';
    await pauseFromMenu(view);
    const reload = await findByRole('button', { name: WORKFLOW_COPY.stale.action });
    stub?.on('bureau.workflows.get', () => {
      throw workflowFaults.unprocessable('Cannot read it.');
    });
    await fireEvent.click(reload);
    expect(await findByRole('alert')).not.toBeNull();
    await waitFor(() => expect(container.textContent).toContain('Cannot read it.'));
  });
});

describe('a workflow deleted between the frame’s read and the page’s', () => {
  test('is the not-found state, and not a loading skeleton that never ends', async () => {
    const { container, findByRole } = open('/workflows/digest', {
      // The engine no longer holds it either, as after a restart.
      definitions: [],
    });
    let reads = 0;
    const original = stub?.world.files[0];
    stub?.on('bureau.workflows.get', () => {
      reads += 1;
      // The frame's probe finds the file; every read after it finds it gone.
      if (reads === 1) return original;
      throw workflowFaults.notFound('workflow digest');
    });
    const words =
      VIEW_COPY.workflows.notFoundByPattern?.['/workflows/:workflow'] ??
      VIEW_COPY.workflows.notFound;
    await findByRole('heading', { level: 1, name: words?.title ?? '' });
    expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
      'not-found',
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe('a write the Bureau made and the engine could not apply', () => {
  test('is shown as changed but not yet applied, and the next action names the new hash', async () => {
    const view = open('/workflows/digest');
    const { container, findByText, findByRole, getByRole } = view;
    const root = await ready(container);
    let calls = 0;
    stub?.on('bureau.workflows.pause', (params) => {
      calls += 1;
      const file = stub?.file('digest');
      if (file === undefined) throw new Error('The file is missing.');
      if (calls === 1) {
        // The file was replaced, then the engine could not follow.
        file.paused = true;
        file.hash = 'hash-applied-later';
        throw workflowFaults.applyFailed();
      }
      return { id: 'digest', hash: params['expectedHash'] };
    });
    await pauseFromMenu(view);

    expect(await findByText(WORKFLOW_COPY.applyFailed.title)).not.toBeNull();
    expect(root.textContent).not.toContain(WORKFLOW_COPY.pauseFailed);
    // The page took what is on disk: the file is paused, and a resume names its new hash.
    await findByRole('button', { name: WORKFLOW_COPY.resumeAction });
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.resumeAction }));
    await waitFor(() => expect(stub?.callsTo('bureau.workflows.resume').length).toBe(1));
    expect(stub?.callsTo('bureau.workflows.resume')[0]?.params['expectedHash']).toBe(
      'hash-applied-later',
    );
  });
});

describe('a signal that fails', () => {
  test('shows the failure beside the form, in the words copy.ts holds', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    stub?.on('bureau.workflows.signal', () => {
      throw new StubFault('Unavailable', 503, 'Delivered to: run-1', {
        reason: 'signal-delivery-failed',
      });
    });
    const form = await openSignalDialog(view);
    // The send button is in the dialog's footer, beside the form.
    await fireEvent.click(view.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction }));

    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain(WORKFLOW_COPY.signal.failed);
    expect(alert.textContent).toContain('Delivered to: run-1');
    expect(form.querySelector('[role="status"]')).toBeNull();
  });

  test('clears the failure when the next send succeeds', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    let sends = 0;
    stub?.on('bureau.workflows.signal', () => {
      sends += 1;
      if (sends === 1) throw workflowFaults.unavailable();
      return { started: [], delivered: [], rejected: [] };
    });
    const form = await openSignalDialog(view);
    // The send button is in the dialog's footer, beside the form.
    await fireEvent.click(view.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction }));
    await within(form).findByRole('alert');
    await fireEvent.click(view.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction }));
    await within(form).findByRole('status', { name: WORKFLOW_COPY.signal.resultLabel });
    expect(form.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('a resume or a delete the engine could not apply', () => {
  test('a resume is shown as changed, and a delete whose file is gone returns to the list', async () => {
    const view = open('/workflows/digest', {
      files: [readyFile('digest', { paused: true })],
    });
    const { container, findByText, getByRole } = view;
    await ready(container);
    stub?.on('bureau.workflows.resume', () => {
      const file = stub?.file('digest');
      if (file === undefined) throw new Error('The file is missing.');
      file.paused = false;
      file.hash = 'hash-resumed';
      throw workflowFaults.applyFailed();
    });
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.resumeAction }));
    expect(await findByText(WORKFLOW_COPY.applyFailed.title)).not.toBeNull();
    await running(view);

    stub?.on('bureau.workflows.delete', () => {
      if (stub !== undefined) stub.world.files = [];
      throw workflowFaults.applyFailed();
    });
    const dialog = await openDeleteDialog(view, 'digest');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: WORKFLOW_COPY.deleteDialog.confirm }),
    );
    await waitFor(() => expect(router.pathname).toBe('/workflows'));
  });
});

describe('the "not applied yet" banner', () => {
  for (const later of ['a resume that succeeds', 'a delete refused as stale'] as const) {
    test(`clears once a later write runs: ${later}`, async () => {
      const view = open('/workflows/digest');
      const { container, findByText, findByRole, getByRole } = view;
      const root = await ready(container);
      stub?.on('bureau.workflows.pause', () => {
        const file = stub?.file('digest');
        if (file === undefined) throw new Error('The file is missing.');
        file.paused = true;
        file.hash = 'hash-applied-later';
        throw workflowFaults.applyFailed();
      });
      await pauseFromMenu(view);
      expect(await findByText(WORKFLOW_COPY.applyFailed.title)).not.toBeNull();
      await findByRole('button', { name: WORKFLOW_COPY.resumeAction });

      if (later === 'a resume that succeeds') {
        await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.resumeAction }));
        await waitFor(() => expect(stub?.callsTo('bureau.workflows.resume').length).toBe(1));
        await running(view);
      } else {
        stub?.on('bureau.workflows.delete', () => {
          throw workflowFaults.stale('someone-else');
        });
        const dialog = await openDeleteDialog(view, 'digest');
        await fireEvent.click(
          within(dialog).getByRole('button', { name: WORKFLOW_COPY.deleteDialog.confirm }),
        );
        await waitFor(() => expect(root.dataset['condition']).toBe('stale'));
      }
      expect(root.textContent).not.toContain(WORKFLOW_COPY.applyFailed.title);
    });
  }

  test('stays while a later write fails for another reason', async () => {
    const view = open('/workflows/digest');
    const { container, findByText, findByRole } = view;
    const root = await ready(container);
    stub?.on('bureau.workflows.pause', () => {
      const file = stub?.file('digest');
      if (file === undefined) throw new Error('The file is missing.');
      file.paused = true;
      file.hash = 'hash-applied-later';
      throw workflowFaults.applyFailed();
    });
    await pauseFromMenu(view);
    expect(await findByText(WORKFLOW_COPY.applyFailed.title)).not.toBeNull();
    stub?.on('bureau.workflows.resume', () => {
      throw workflowFaults.unavailable();
    });
    await fireEvent.click(await findByRole('button', { name: WORKFLOW_COPY.resumeAction }));
    await waitFor(() => expect(stub?.callsTo('bureau.workflows.resume').length).toBe(1));
    expect(await findByText(WORKFLOW_COPY.resumeFailed)).not.toBeNull();
    // The pause is still on disk and the engine has still not followed it.
    expect(root.textContent).toContain(WORKFLOW_COPY.applyFailed.title);
  });
});

describe('the links on a type’s page', () => {
  test('open the runs, the editor, and a schedule, and leave a modified click to the browser', async () => {
    const { container } = open('/workflows/digest', {
      schedules: [scheduleFixture('every-6', 'digest')],
    });
    const root = await ready(container);
    // The file's schedule is named on its header's schedule line, as a link.
    await waitFor(() =>
      expect(root.querySelector('[data-testid="workflow-line-schedule"] a')).not.toBeNull(),
    );
    const clickEach = (links: readonly (readonly [string, HTMLAnchorElement | null])[]) => {
      for (const [path, link] of links) {
        link?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
        );
        expect(router.pathname).toBe('/workflows/digest');
        link?.click();
        expect(router.pathname).toBe(path);
        router.navigate('/workflows/digest', { replace: true });
      }
    };
    clickEach([
      ['/workflows/digest/edit', root.querySelector<HTMLAnchorElement>('a[href$="/edit"]')],
      [
        '/schedules/every-6',
        root.querySelector<HTMLAnchorElement>('[data-testid="workflow-line-schedule"] a'),
      ],
    ]);
    await openTab(root, TABS.runs);
    clickEach([
      ['/workflows/digest/runs', root.querySelector<HTMLAnchorElement>('a[href$="/runs"]')],
    ]);
  });
});

describe.each(['local', 'remote'] as const)('the details of a workflow on a %s host', (mode) => {
  test('names the file in the header, and shows the host’s location verbatim above its source', async () => {
    const { container } = open('/workflows/digest', { hostMode: mode });
    const root = await ready(container);

    expect(testId(root, 'workflow-line-last-run')?.querySelector('code')?.textContent).toBe(
      'digest.json',
    );
    await openTab(root, TABS.code);
    await waitFor(() =>
      expect(testId(root, 'workflow-file-path')?.textContent).toBe(
        mode === 'remote'
          ? `${STUB_REMOTE_WORKFLOW_DIRECTORY}digest.json`
          : `${STUB_WORKFLOW_DIRECTORY}/digest.json`,
      ),
    );
  });
});

describe('a workflow’s page while its type loads', () => {
  test('shows its title, its tabs without counts, and its actions off, from the route alone', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub = installWorkflowWorld(
      emptyWorld({
        definitions: [sourceDefinition('digest', { signals: ['approve'] })],
        files: [readyFile('digest')],
      }),
    );
    const file = stub.world.files[0];
    stub.on('bureau.workflows.get', async () => {
      await gate;
      return file;
    });
    router.navigate('/workflows/digest', { replace: true });
    const { container, getByRole } = render(RouteOutletHarness, {
      props: { client: stub.client, scopes: AUTHORIZATION_SCOPES },
    } as never);

    await waitFor(() => expect(page(container)).not.toBeNull());
    const root = page(container) as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toContain('digest');
    // The tabs are there with no count, because a count waits for data.
    expect(
      [...root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim()),
    ).toEqual([TABS.overview, TABS.code, TABS.runs, TABS.history]);
    expect(getByRole('button', { name: WORKFLOW_COPY.page.startAction })).toBeDisabled();
    expect(testId(root, 'workflow-overview')).toBeNull();

    release();
    const loaded = await ready(container);
    expect(getByRole('link', { name: WORKFLOW_COPY.page.startAction })).not.toBeNull();
    expect(testId(loaded, 'workflow-overview')).not.toBeNull();
  });
});
