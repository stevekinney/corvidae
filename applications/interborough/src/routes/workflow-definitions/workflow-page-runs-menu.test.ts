/**
 * `/workflows/:workflow` by its Runs tab, its "⋯" menu and its delete dialog (COR-2021, board
 * PageWorkflow, "Runs tab", "Runs tab, empty", "More menu, and Delete", "Delete, with the schedule
 * checked" and "More menu on an active workflow"). The Runs tab is the Runs list's own bar and rows
 * limited to the workflow; the menu holds Duplicate, Pause and Delete…, each a real Bureau write
 * that changes the page only once it is made; Delete names the schedule that runs the workflow and
 * offers to delete it too.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { TASK_COPY, WORKFLOW_COPY } from '../../app/copy.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import {
  emptyWorld,
  installWorkflowWorld,
  readyFile,
  runFixture,
  scheduleFixture,
  sourceDefinition,
  workflowFaults,
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

const TABS = WORKFLOW_COPY.page.tabs;
const MENU = WORKFLOW_COPY.page.menu;
const DELETE = WORKFLOW_COPY.deleteDialog;

function open(path: string, overrides: Partial<World> = {}) {
  stub = installWorkflowWorld(
    emptyWorld({
      definitions: [sourceDefinition('digest', { signals: ['approve'] })],
      files: [readyFile('digest'), readyFile('paused-one', { paused: true })],
      ...overrides,
    }),
  );
  router.navigate(path, { replace: true });
  return render(RouteOutletHarness, {
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES },
  } as never);
}

const testId = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** The page, once what the type is has been read: its Overview, the tab it opens on, follows it. */
async function ready(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      container.querySelector('[data-page="workflow-detail"] [data-testid="workflow-overview"]'),
    ).toBeTruthy(),
  );
  return container.querySelector<HTMLElement>('[data-page="workflow-detail"]') as HTMLElement;
}

/** A tab's name without the count that follows its label once the count is known ("Runs 2"). */
const withoutCount = (label: string | undefined) => label?.trim().replace(/\s+\d+$/, '');

async function openTab(root: HTMLElement, name: string): Promise<void> {
  const tab = [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (candidate) => withoutCount(candidate.textContent) === name,
  );
  if (tab === undefined) throw new Error(`No tab called ${name}.`);
  await fireEvent.click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
}

/** A status segment by its word and its count, which are its accessible name together. */
function segment(view: ReturnType<typeof open>, word: string, count: number): HTMLElement {
  return view.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*${String(count)}$`) });
}

const rowIds = (root: ParentNode) =>
  [...root.querySelectorAll('[data-run]')].map((row) => row.getAttribute('data-run'));

/** Opens the "⋯" menu. */
async function openMenu(view: ReturnType<typeof open>): Promise<void> {
  await fireEvent.click(await view.findByRole('button', { name: MENU.label }));
}

/** The names of the items the open "⋯" menu holds, in order. */
async function menuItems(view: ReturnType<typeof open>): Promise<string[]> {
  const items = await view.findAllByRole('menuitem');
  return items.map((item) => item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '');
}

/** Opens the "⋯" menu and chooses an item by its name. */
async function choose(view: ReturnType<typeof open>, name: string): Promise<void> {
  await openMenu(view);
  await fireEvent.click(await view.findByRole('menuitem', { name }));
}

describe('the Runs tab', () => {
  test('is the Runs list limited to this workflow: the six segments with their counts, Started by, and its rows', async () => {
    const view = open('/workflows/digest', {
      runs: [
        runFixture('failed-1', 'digest', {
          status: 'failed',
          createdAt: 1_760_000_100_000,
          updatedAt: 1_760_000_103_000,
          origin: { kind: 'schedule', scheduleId: 'nightly', fireId: 'fire-1' },
        }),
        runFixture('done-1', 'digest', { createdAt: 1_760_000_000_000 }),
        runFixture('elsewhere-1', 'something-else'),
      ],
    });
    const root = await ready(view.container);
    await openTab(root, TABS.runs);
    const runs = testId(root, 'workflow-recent-runs') as HTMLElement;
    await waitFor(() => expect(rowIds(runs)).toEqual(['failed-1', 'done-1']));

    expect(segment(view, 'All', 2)).not.toBeNull();
    expect(segment(view, 'Waiting on you', 0)).not.toBeNull();
    expect(segment(view, 'Running', 0)).not.toBeNull();
    expect(segment(view, 'Done', 1)).not.toBeNull();
    expect(segment(view, 'Failed', 1)).not.toBeNull();
    expect(segment(view, 'Canceled', 0)).not.toBeNull();
    expect(view.getByRole('button', { name: TASK_COPY.startedByLabel })).not.toBeNull();

    // The row is the Runs page's own: the status word, the workflow's name, and line two kind first.
    const failed = runs.querySelector<HTMLElement>('[data-run="failed-1"]') as HTMLElement;
    expect(failed.dataset['status']).toBe('Failed');
    expect(failed.textContent).toContain('digest');
    expect(failed.textContent).toContain(
      `${TASK_COPY.list.kinds.schedule}${TASK_COPY.list.separator}`,
    );
    expect(failed.textContent).toContain('3 s');
    // It opens the run under this workflow.
    expect(failed.querySelector('a')?.getAttribute('href')).toBe('/workflows/digest/runs/failed-1');

    // A segment narrows the rows, and every count stays.
    await fireEvent.click(segment(view, 'Failed', 1));
    await waitFor(() => expect(rowIds(runs)).toEqual(['failed-1']));
    expect(segment(view, 'All', 2)).not.toBeNull();
    // The filters are the tab's own: the address keeps only the tab.
    expect(router.search.get('status')).toBeNull();
    expect(router.search.get('tab')).toBe('runs');
  });

  test('counts a run waiting at a step under Waiting, and not under Running', async () => {
    const view = open('/workflows/digest', {
      runs: [runFixture('waiting-1', 'digest', { status: 'suspended' })],
    });
    const root = await ready(view.container);
    await openTab(root, TABS.runs);
    await waitFor(() => expect(rowIds(root)).toEqual(['waiting-1']));
    expect(segment(view, 'Waiting on you', 1)).not.toBeNull();
    expect(segment(view, 'Running', 0)).not.toBeNull();
  });

  test('keeps the bar, every count at 0, over the compact empty state, whose hint names Start run', async () => {
    const view = open('/workflows/digest', { runs: [] });
    const root = await ready(view.container);
    await openTab(root, TABS.runs);
    const runs = testId(root, 'workflow-recent-runs') as HTMLElement;
    await waitFor(() => expect(runs.textContent).toContain(WORKFLOW_COPY.page.runs.emptyTitle));
    for (const word of ['All', 'Waiting on you', 'Running', 'Done', 'Failed', 'Canceled']) {
      expect(segment(view, word, 0)).not.toBeNull();
    }
    expect(view.getByRole('button', { name: TASK_COPY.startedByLabel })).not.toBeNull();
    // The empty state sits in the tab, under the header and the tabs, and is not the whole page.
    expect(runs.querySelector('.cinder-empty-state')).not.toBeNull();
    expect(root.querySelector('h1')).not.toBeNull();
    expect(runs.textContent).toContain(WORKFLOW_COPY.page.runs.emptyDescription);
    expect(testId(runs, 'workflow-runs-hint')?.textContent).toBe(WORKFLOW_COPY.page.runs.emptyHint);
    // The hint is plain words: the action is the header's Start run.
    expect(runs.querySelector('.cinder-empty-state button, .cinder-empty-state a')).toBeNull();
  });

  test('on a paused workflow says why nothing runs it, and names Resume, which the header holds in place of Start run', async () => {
    const view = open('/workflows/paused-one', { runs: [] });
    const root = await ready(view.container);
    await openTab(root, TABS.runs);
    const runs = testId(root, 'workflow-recent-runs') as HTMLElement;
    await waitFor(() =>
      expect(runs.textContent).toContain(WORKFLOW_COPY.page.runs.emptyDescriptionPaused),
    );
    expect(testId(runs, 'workflow-runs-hint')?.textContent).toBe(
      WORKFLOW_COPY.page.runs.emptyHintPaused,
    );
    expect(view.getByRole('button', { name: WORKFLOW_COPY.resumeAction })).not.toBeNull();
    expect(view.queryByRole('link', { name: WORKFLOW_COPY.page.startAction })).toBeNull();
  });
});

describe('the "⋯" menu', () => {
  test('on a running workflow holds Duplicate, Pause with what pausing does, and Delete…', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    await openMenu(view);
    expect(await menuItems(view)).toEqual([
      MENU.sendSignal,
      MENU.duplicate,
      MENU.pause,
      MENU.delete,
    ]);
    expect(testId(document, 'workflow-menu-pause-description')?.textContent).toBe(
      MENU.pauseDescription,
    );
    // The header holds Edit and Start run, and no Pause or Delete of its own.
    expect(view.queryByRole('button', { name: WORKFLOW_COPY.pauseAction })).toBeNull();
    expect(view.queryByRole('button', { name: WORKFLOW_COPY.deleteAction })).toBeNull();
  });

  test('on a paused workflow holds no Pause and no Resume, because Resume is the header’s', async () => {
    const view = open('/workflows/paused-one');
    await ready(view.container);
    await openMenu(view);
    const items = await menuItems(view);
    expect(items).toContain(MENU.duplicate);
    expect(items).toContain(MENU.delete);
    expect(items).not.toContain(MENU.pause);
    expect(items).not.toContain(WORKFLOW_COPY.resumeAction);
  });

  test('Pause pauses the file, and the header shows Resume only once the Bureau has written it', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    await choose(view, MENU.pause);
    await view.findByRole('button', { name: WORKFLOW_COPY.resumeAction });
    expect(stub?.callsTo('bureau.workflows.pause')[0]?.params).toEqual({
      id: 'digest',
      expectedHash: 'hash-1',
    });
    expect(stub?.file('digest')?.paused).toBe(true);
  });

  test('a Pause the Bureau refuses leaves the page as it was, and says why', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    stub?.on('bureau.workflows.pause', () => {
      throw workflowFaults.unavailable();
    });
    await choose(view, MENU.pause);
    expect(await view.findByText(WORKFLOW_COPY.pauseFailed)).not.toBeNull();
    expect(view.queryByRole('button', { name: WORKFLOW_COPY.resumeAction })).toBeNull();
  });

  test('Duplicate writes a paused copy under a new identifier, then opens it', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    await choose(view, MENU.duplicate);
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest-copy'));
    const [create] = stub?.callsTo('bureau.workflows.create') ?? [];
    expect(create?.params['id']).toBe('digest-copy');
    const definition = create?.params['definition'] as Record<string, unknown>;
    expect(definition['paused']).toBe(true);
    expect('name' in definition).toBe(false);
    expect(stub?.file('digest-copy')?.paused).toBe(true);
  });

  test('Duplicate takes the next identifier while one is taken', async () => {
    const view = open('/workflows/digest', {
      files: [readyFile('digest'), readyFile('digest-copy')],
    });
    await ready(view.container);
    await choose(view, MENU.duplicate);
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest-copy-2'));
    expect(stub?.callsTo('bureau.workflows.create').map((call) => call.params['id'])).toEqual([
      'digest-copy',
      'digest-copy-2',
    ]);
  });

  test('a Duplicate the Bureau refuses stays on the page and says why', async () => {
    const view = open('/workflows/digest');
    await ready(view.container);
    stub?.on('bureau.workflows.create', () => {
      throw workflowFaults.unprocessable('The copy would not load.');
    });
    await choose(view, MENU.duplicate);
    expect(await view.findByText(MENU.duplicateFailed)).not.toBeNull();
    expect(await view.findByText('The copy would not load.')).not.toBeNull();
    expect(router.pathname).toBe('/workflows/digest');
  });
});

describe('the delete dialog', () => {
  const RUNNING_SCHEDULE = scheduleFixture('inbox-triage', 'digest', {
    status: 'paused',
    description: 'Inbox triage',
  });

  test('names the schedule that runs the workflow, its past runs, and the file it removes', async () => {
    const view = open('/workflows/digest', { schedules: [{ ...RUNNING_SCHEDULE }] });
    await ready(view.container);
    await choose(view, MENU.delete);
    const dialog = await view.findByRole('dialog', { name: DELETE.title('digest') });
    expect(dialog.textContent).toContain(DELETE.scheduleRuns('Inbox triage', true).trim());
    expect(dialog.textContent).toContain(DELETE.pastRuns.trim());
    expect(dialog.querySelector('code')?.textContent).toBe('digest.json');
    const checkbox = within(dialog).getByRole('checkbox', {
      name: DELETE.alsoDeleteSchedule('Inbox triage'),
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(dialog.textContent).toContain(DELETE.alsoDeleteHelp(true));
    expect(within(dialog).getByRole('button', { name: DELETE.confirm })).not.toBeNull();
    // Nothing is deleted until it is confirmed.
    expect(stub?.callsTo('bureau.workflows.delete')).toEqual([]);
  });

  test('unchecked, deletes the file and leaves the schedule', async () => {
    const view = open('/workflows/digest', { schedules: [{ ...RUNNING_SCHEDULE }] });
    await ready(view.container);
    await choose(view, MENU.delete);
    const dialog = await view.findByRole('dialog', { name: DELETE.title('digest') });
    await fireEvent.click(within(dialog).getByRole('button', { name: DELETE.confirm }));
    await waitFor(() => expect(router.pathname).toBe('/workflows'));
    expect(stub?.file('digest')).toBeUndefined();
    expect(stub?.callsTo('DELETE /schedules/:schedule')).toEqual([]);
  });

  test('checked, says so on its button, and deletes the file and then the schedule', async () => {
    const view = open('/workflows/digest', { schedules: [{ ...RUNNING_SCHEDULE }] });
    await ready(view.container);
    await choose(view, MENU.delete);
    const dialog = await view.findByRole('dialog', { name: DELETE.title('digest') });
    await fireEvent.click(
      within(dialog).getByRole('checkbox', { name: DELETE.alsoDeleteSchedule('Inbox triage') }),
    );
    const confirm = await within(dialog).findByRole('button', { name: DELETE.confirmWithSchedule });
    expect(within(dialog).queryByRole('button', { name: DELETE.confirm })).toBeNull();
    await fireEvent.click(confirm);
    await waitFor(() => expect(router.pathname).toBe('/workflows'));

    const methods = stub?.calls.map((call) => call.method) ?? [];
    const fileDeleted = methods.indexOf('bureau.workflows.delete');
    const scheduleDeleted = methods.indexOf('DELETE /schedules/:schedule');
    expect(fileDeleted).toBeGreaterThanOrEqual(0);
    expect(scheduleDeleted).toBeGreaterThan(fileDeleted);
    expect(stub?.callsTo('DELETE /schedules/:schedule')[0]?.params).toEqual({ id: 'inbox-triage' });
  });

  test('offers no checkbox for the schedule the file defines, which goes with the file', async () => {
    const view = open('/workflows/digest', {
      schedules: [scheduleFixture('bureau-workflow-schedule:digest:1', 'digest')],
    });
    await ready(view.container);
    await choose(view, MENU.delete);
    const dialog = await view.findByRole('dialog', { name: DELETE.title('digest') });
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  test('stays open while the delete is refused, and says why, with nothing deleted', async () => {
    const view = open('/workflows/digest', { schedules: [{ ...RUNNING_SCHEDULE }] });
    await ready(view.container);
    stub?.on('bureau.workflows.delete', () => {
      throw workflowFaults.unprocessable('The file is locked.');
    });
    await choose(view, MENU.delete);
    const dialog = await view.findByRole('dialog', { name: DELETE.title('digest') });
    await fireEvent.click(
      within(dialog).getByRole('checkbox', { name: DELETE.alsoDeleteSchedule('Inbox triage') }),
    );
    await fireEvent.click(
      await within(dialog).findByRole('button', { name: DELETE.confirmWithSchedule }),
    );
    await waitFor(() => expect(dialog.textContent).toContain('The file is locked.'));
    expect(dialog.textContent).toContain(DELETE.failedTitle);
    expect(router.pathname).toBe('/workflows/digest');
    // The schedule is not touched when the file could not be deleted.
    expect(stub?.callsTo('DELETE /schedules/:schedule')).toEqual([]);
  });
});
