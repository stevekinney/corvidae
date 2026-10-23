/**
 * COR-1494: the schedules area writes each kind of schedule through the service that owns it, and
 * labels and links each by what it starts. An agent run is the Bureau's (`bureau.schedules.*`, with
 * the revision the page read), a workflow file's schedule is its trigger (`bureau.workflows.pause`
 * and `resume`, with the hash of the file the page read), and any other is the engine's, with no
 * stale check. A write that was stale says so inline, and reloads the row.
 *
 * The list and one schedule's page are driven against `installWorkflowWorld`, a stand-in for the
 * engine and the Bureau that keeps the schedules and files as a world a test can change, and
 * answers a write the way each service does.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { SCHEDULE_COPY } from '../../app/copy.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  readyFile,
  scheduleFixture,
  sourceDefinition,
  workflowFaults,
  type WorkflowStub,
  type World,
} from '../../lib/workflow-world.test-support.ts';
import IndexHarness from './index-test-harness.test-harness.svelte';

let stub: WorkflowStub | undefined;

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const AGENT_SCHEDULE = 'daily-summary';
const FILE_SCHEDULE = 'bureau-workflow-schedule:digest:1';
const CODE_SCHEDULE = 'every-5';

function world(overrides: Partial<World> = {}): World {
  return emptyWorld({
    definitions: [
      codeDefinition('order-processing'),
      codeDefinition('agentRun'),
      sourceDefinition('digest'),
    ],
    files: [readyFile('digest')],
    schedules: [
      scheduleFixture(AGENT_SCHEDULE, 'agentRun', { description: 'Daily summary', revision: 3 }),
      scheduleFixture(FILE_SCHEDULE, 'digest', { description: 'Workflow digest' }),
      scheduleFixture(CODE_SCHEDULE, 'order-processing', { revision: 5 }),
    ],
    scheduleAgents: { [AGENT_SCHEDULE]: 'assistant' },
    scheduleInputs: { [AGENT_SCHEDULE]: 'Summarize what happened yesterday.' },
    ...overrides,
  });
}

function open(path: string, overrides: Partial<World> = {}) {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  stub = installWorkflowWorld(world(overrides));
  router.navigate(path, { replace: true });
  return render(IndexHarness, { props: { client: stub.client, externalBureau: true } });
}

const row = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`li[data-schedule="${id}"]`);

/** The list once it has said what each schedule starts. */
async function listed(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(row(container, AGENT_SCHEDULE)?.dataset['kind']).toBe('agent-run'));
}

async function openMenu(container: HTMLElement, id: string) {
  const view = within(container.ownerDocument.body);
  // A row's menu is named for the schedule's name, which is not its identifier.
  const owner = row(container, id);
  if (owner === null) throw new Error(`no row for ${id}`);
  await fireEvent.click(within(owner).getByRole('button', { name: /^Actions for / }));
  return view;
}

const stale = () => document.body.querySelector('[data-testid="schedule-notice"]');

describe('what a schedule starts', () => {
  test('is labelled by kind and linked: an agent run to its agent, a workflow to its page', async () => {
    const { container } = open('/schedules');
    await listed(container);

    const agent = within(row(container, AGENT_SCHEDULE) as HTMLElement);
    expect(row(container, AGENT_SCHEDULE)?.dataset['kind']).toBe('agent-run');
    // An agent run is said by its agent alone; a workflow says which kind it is.
    expect(agent.queryByText(SCHEDULE_COPY.kind.code)).toBeNull();
    expect(agent.getByRole('link', { name: 'assistant' }).getAttribute('href')).toBe(
      '/agents/assistant',
    );

    const file = within(row(container, FILE_SCHEDULE) as HTMLElement);
    expect(row(container, FILE_SCHEDULE)?.dataset['kind']).toBe('workflow-file');
    expect(file.getByText(SCHEDULE_COPY.kind['workflow-file'])).not.toBeNull();
    expect(file.getByRole('link', { name: 'digest' }).getAttribute('href')).toBe(
      '/workflows/digest',
    );

    const code = within(row(container, CODE_SCHEDULE) as HTMLElement);
    expect(row(container, CODE_SCHEDULE)?.dataset['kind']).toBe('code');
    expect(code.getByText(SCHEDULE_COPY.kind.code)).not.toBeNull();
    expect(code.getByRole('link', { name: 'order-processing' }).getAttribute('href')).toBe(
      '/workflows/order-processing',
    );
  });

  test('is linked the same way on one schedule’s page', async () => {
    const { findByTestId } = open(`/schedules/${AGENT_SCHEDULE}`);
    await waitFor(async () => {
      const target = await findByTestId('schedule-target');
      expect(target.textContent).toContain('assistant');
    });
    const target = await findByTestId('schedule-target');
    expect(within(target).getByRole('link', { name: 'assistant' }).getAttribute('href')).toBe(
      '/agents/assistant',
    );
  });

  test('is not linked, and nothing is written, for a schedule only the Bureau can place, when it has not said', async () => {
    const { container, findByText } = open('/schedules', {
      failBureauSchedules: true,
      failBureauFiles: true,
    });
    await findByText(SCHEDULE_COPY.overlayFailed.title, { exact: false });

    // The workflow file's schedule: whether it is the file's or the engine's is the Bureau's to say.
    expect(row(container, FILE_SCHEDULE)?.dataset['kind']).toBe('unknown');
    const target = within(row(container, FILE_SCHEDULE) as HTMLElement).getByTestId(
      'schedule-target',
    );
    expect(target.querySelector('a') === null).toBe(true);
    expect(target.textContent).not.toContain(SCHEDULE_COPY.kind['workflow-file']);
    const view = await openMenu(container, FILE_SCHEDULE);
    expect(view.queryByRole('menuitem', { name: /Pause/ }) === null).toBe(true);
    expect(view.queryByRole('menuitem', { name: /Cancel/ }) === null).toBe(true);
    expect(
      view.queryByRole('menuitem', { name: new RegExp(SCHEDULE_COPY.editWorkflowAction) }) === null,
    ).toBe(true);
  });

  test('is an agent run with no agent named, and so no link, when the Bureau’s schedules did not answer', async () => {
    const { container, findByText } = open('/schedules', { failBureauSchedules: true });
    await findByText(SCHEDULE_COPY.overlayFailed.title, { exact: false });

    expect(row(container, AGENT_SCHEDULE)?.dataset['kind']).toBe('agent-run');
    const target = within(row(container, AGENT_SCHEDULE) as HTMLElement).getByTestId(
      'schedule-target',
    );
    expect(target.textContent).toContain(SCHEDULE_COPY.unnamedAgent);
    expect(target.querySelector('a') === null).toBe(true);
  });
});

describe('pausing, by kind', () => {
  test('an agent run pauses through bureau.schedules.pause, with the revision the page read', async () => {
    const { container } = open('/schedules');
    await listed(container);

    const view = await openMenu(container, AGENT_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Pause/ }));

    await waitFor(() => expect(row(container, AGENT_SCHEDULE)?.dataset['status']).toBe('paused'));
    expect(stub?.callsTo('bureau.schedules.pause').map((call) => call.params)).toEqual([
      { scheduleId: AGENT_SCHEDULE, expectedRevision: 3 },
    ]);
    expect(stub?.callsTo('bureau.workflows.pause')).toEqual([]);
    expect(stub?.callsTo('POST pause /schedules/:id')).toEqual([]);
  });

  test('a workflow file’s schedule pauses through bureau.workflows.pause, with the hash of the file the page read', async () => {
    const { container } = open('/schedules');
    await listed(container);

    const view = await openMenu(container, FILE_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Pause/ }));

    await waitFor(() => expect(row(container, FILE_SCHEDULE)?.dataset['status']).toBe('paused'));
    expect(stub?.callsTo('bureau.workflows.pause').map((call) => call.params)).toEqual([
      { id: 'digest', expectedHash: 'hash-1' },
    ]);
    expect(stub?.callsTo('bureau.schedules.pause')).toEqual([]);
    expect(stub?.callsTo('POST pause /schedules/:id')).toEqual([]);
  });

  test('any other schedule pauses through the engine, which has no revision to name', async () => {
    const { container } = open('/schedules');
    await listed(container);

    const view = await openMenu(container, CODE_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Pause/ }));

    await waitFor(() => expect(row(container, CODE_SCHEDULE)?.dataset['status']).toBe('paused'));
    expect(stub?.callsTo('POST pause /schedules/:id').map((call) => call.params)).toEqual([
      { id: CODE_SCHEDULE },
    ]);
    expect(stub?.callsTo('bureau.schedules.pause')).toEqual([]);
    expect(stub?.callsTo('bureau.workflows.pause')).toEqual([]);
  });

  test('resumes each kind through the same service, with what the page read', async () => {
    const { container } = open('/schedules', {
      schedules: [
        scheduleFixture(AGENT_SCHEDULE, 'agentRun', { status: 'paused', revision: 3 }),
        scheduleFixture(FILE_SCHEDULE, 'digest', { status: 'paused' }),
      ],
      files: [readyFile('digest', { paused: true })],
    });
    await listed(container);

    let view = await openMenu(container, AGENT_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Resume/ }));
    await waitFor(() => expect(row(container, AGENT_SCHEDULE)?.dataset['status']).toBe('active'));
    view = await openMenu(container, FILE_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Resume/ }));
    await waitFor(() => expect(row(container, FILE_SCHEDULE)?.dataset['status']).toBe('active'));

    expect(stub?.callsTo('bureau.schedules.resume').map((call) => call.params)).toEqual([
      { scheduleId: AGENT_SCHEDULE, expectedRevision: 3 },
    ]);
    expect(stub?.callsTo('bureau.workflows.resume').map((call) => call.params)).toEqual([
      { id: 'digest', expectedHash: 'hash-1' },
    ]);
  });
});

describe('a stale write', () => {
  test('on an agent run says it changed since it was loaded, and reloads the row', async () => {
    const { container } = open('/schedules');
    await listed(container);
    // Someone else paused it after this page read it, which is a change of its own.
    const other = stub?.world.schedules.find((schedule) => schedule.id === AGENT_SCHEDULE);
    if (other === undefined) throw new Error('expected the seeded schedule');
    other.status = 'paused';
    other.revision = 4;
    const reads = stub?.callsTo('GET /schedules').length ?? 0;

    const view = await openMenu(container, AGENT_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Pause/ }));

    await waitFor(() => expect(stale()).not.toBeNull());
    expect(stale()?.getAttribute('data-notice')).toBe('stale');
    expect(stale()?.textContent).toContain(SCHEDULE_COPY.stale.title(AGENT_SCHEDULE));
    // Nothing was written: the revision is the one the other actor made.
    expect(other.revision).toBe(4);
    // The row was read again, so it shows what the schedule is now.
    await waitFor(() => expect(stub?.callsTo('GET /schedules').length).toBeGreaterThan(reads));
    await waitFor(() => expect(row(container, AGENT_SCHEDULE)?.dataset['status']).toBe('paused'));
    // And the next move is the person’s, now against the revision they can see.
    const reopened = await openMenu(container, AGENT_SCHEDULE);
    await fireEvent.click(reopened.getByRole('menuitem', { name: /Resume/ }));
    await waitFor(() => expect(row(container, AGENT_SCHEDULE)?.dataset['status']).toBe('active'));
    expect(stub?.callsTo('bureau.schedules.resume').at(-1)?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      expectedRevision: 4,
    });
  });

  test('on a workflow file’s schedule, a file that changed says the same, and reloads the row', async () => {
    const { container } = open('/schedules');
    await listed(container);
    const file = stub?.file('digest');
    if (file === undefined) throw new Error('expected the seeded file');
    // The file was edited on disk after the page read it.
    file.hash = 'hash-edited-elsewhere';
    const reads = stub?.callsTo('bureau.workflows.list').length ?? 0;

    const view = await openMenu(container, FILE_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Pause/ }));

    await waitFor(() => expect(stale()).not.toBeNull());
    expect(stale()?.textContent).toContain(SCHEDULE_COPY.stale.title(FILE_SCHEDULE));
    expect(row(container, FILE_SCHEDULE)?.dataset['status']).toBe('active');
    // The page read the files again: waiting on that, which is cheap to say, and not on a retry of
    // the click, so a reload that stops happening fails here as an assertion, and does not hang.
    await waitFor(() =>
      expect(stub?.callsTo('bureau.workflows.list').length ?? 0).toBeGreaterThan(reads),
    );
    // So the next pause, made once, names the hash that is on disk now.
    const reopened = await openMenu(container, FILE_SCHEDULE);
    await fireEvent.click(reopened.getByRole('menuitem', { name: /Pause/ }));
    await waitFor(() =>
      expect(stub?.callsTo('bureau.workflows.pause').at(-1)?.params).toEqual({
        id: 'digest',
        expectedHash: 'hash-edited-elsewhere',
      }),
    );
    await waitFor(() => expect(row(container, FILE_SCHEDULE)?.dataset['status']).toBe('paused'));
  });

  test('does not exist for a schedule the engine owns: it has no revision to be stale against', async () => {
    const { container } = open('/schedules');
    await listed(container);
    const code = stub?.world.schedules.find((schedule) => schedule.id === CODE_SCHEDULE);
    if (code === undefined) throw new Error('expected the seeded schedule');
    code.revision = 9;

    const view = await openMenu(container, CODE_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Pause/ }));

    await waitFor(() => expect(row(container, CODE_SCHEDULE)?.dataset['status']).toBe('paused'));
    expect(stale()).toBeNull();
  });

  test('on one schedule’s page says it changed since it was loaded, and reloads it', async () => {
    const { findByRole, findByText } = open(`/schedules/${AGENT_SCHEDULE}`);
    const pause = await findByRole('button', { name: /Pause/ });
    const other = stub?.world.schedules.find((schedule) => schedule.id === AGENT_SCHEDULE);
    if (other === undefined) throw new Error('expected the seeded schedule');
    other.status = 'paused';
    other.revision = 4;

    await fireEvent.click(pause);

    await findByText(SCHEDULE_COPY.stale.title(AGENT_SCHEDULE));
    // Reloaded: what the page offers now is what the schedule is now.
    await findByRole('button', { name: /Resume/ });
  });
});

describe('a workflow file’s schedule', () => {
  test('offers neither Edit nor Cancel in the list, and links to the workflow’s editor instead', async () => {
    const { container } = open('/schedules');
    await listed(container);

    const view = await openMenu(container, FILE_SCHEDULE);
    expect(view.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(view.queryByRole('menuitem', { name: /Cancel/ })).toBeNull();
    await fireEvent.click(
      view.getByRole('menuitem', { name: new RegExp(SCHEDULE_COPY.editWorkflowAction) }),
    );

    expect(router.pathname).toBe('/workflows/digest/edit');
  });

  test('offers neither on its page, and links to the editor instead', async () => {
    const { findByRole, queryByRole } = open(`/schedules/${FILE_SCHEDULE}`);

    const edit = await findByRole('button', { name: new RegExp(SCHEDULE_COPY.editWorkflowAction) });
    expect(queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(queryByRole('button', { name: /Cancel/ })).toBeNull();
    await fireEvent.click(edit);

    expect(router.pathname).toBe('/workflows/digest/edit');
  });

  test('cannot be paused when its file is one the Bureau cannot use', async () => {
    const { container } = open('/schedules', {
      files: [readyFile('digest', { state: 'invalid', hash: 'hash-bad' })],
    });
    await listed(container);

    const view = await openMenu(container, FILE_SCHEDULE);
    expect(view.queryByRole('menuitem', { name: /Pause/ })).toBeNull();
    expect(
      view.getByRole('menuitem', { name: new RegExp(SCHEDULE_COPY.editWorkflowAction) }),
    ).not.toBeNull();
  });
});

describe('an agent run and a code-defined schedule', () => {
  test('keep Edit and Cancel, which the engine’s own schedules have always had', async () => {
    const { container } = open('/schedules');
    await listed(container);

    for (const id of [AGENT_SCHEDULE, CODE_SCHEDULE]) {
      const view = await openMenu(container, id);
      expect(view.getByRole('menuitem', { name: 'Edit' }), id).not.toBeNull();
      expect(view.getByRole('menuitem', { name: /Cancel/ }), id).not.toBeNull();
      await fireEvent.keyDown(document.body, { key: 'Escape' });
    }
  });

  test('cancel a code-defined schedule through the engine, after the confirmation', async () => {
    const { container } = open('/schedules');
    await listed(container);

    const view = await openMenu(container, CODE_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Cancel/ }));
    await fireEvent.click(await view.findByRole('button', { name: 'Cancel schedule' }));

    await waitFor(() => expect(row(container, CODE_SCHEDULE)?.dataset['status']).toBe('cancelled'));
    expect(stub?.callsTo('DELETE /schedules/:id').map((call) => call.params)).toEqual([
      { id: CODE_SCHEDULE },
    ]);
    expect(stub?.callsTo('bureau.schedules.cancel')).toEqual([]);
  });

  test('cancel an agent run through bureau.schedules.cancel, after the confirmation', async () => {
    const { container } = open('/schedules');
    await listed(container);

    const view = await openMenu(container, AGENT_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Cancel/ }));
    await fireEvent.click(await view.findByRole('button', { name: 'Cancel schedule' }));

    await waitFor(() =>
      expect(row(container, AGENT_SCHEDULE)?.dataset['status']).toBe('cancelled'),
    );
    expect(stub?.callsTo('bureau.schedules.cancel').map((call) => call.params)).toEqual([
      { scheduleId: AGENT_SCHEDULE, expectedRevision: 3 },
    ]);
  });
});

describe('a write that does not go through', () => {
  test('for another reason is a toast that says what was not done, and the row stays as it is', async () => {
    const { container, findByText } = open('/schedules');
    await listed(container);
    // The Bureau no longer shows this caller the schedule, so it answers as it does for a missing one.
    delete stub?.world.scheduleAgents[AGENT_SCHEDULE];

    const view = await openMenu(container, AGENT_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Pause/ }));

    await findByText(SCHEDULE_COPY.pauseFailed, { exact: false });
    expect(stale()).toBeNull();
    expect(row(container, AGENT_SCHEDULE)?.dataset['status']).toBe('active');
  });

  test('that the Bureau made and the engine could not follow says the file has the change, and reads the row again', async () => {
    const { container } = open('/schedules');
    await listed(container);
    stub?.on('bureau.workflows.pause', () => {
      throw workflowFaults.applyFailed();
    });
    const reads = stub?.callsTo('GET /schedules').length ?? 0;

    const view = await openMenu(container, FILE_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Pause/ }));

    await waitFor(() => expect(stale()?.getAttribute('data-notice')).toBe('unapplied'));
    expect(stale()?.textContent).toContain(SCHEDULE_COPY.unapplied.title);
    await waitFor(() => expect(stub?.callsTo('GET /schedules').length).toBeGreaterThan(reads));
  });

  test('can have its notice dismissed', async () => {
    const { container } = open('/schedules');
    await listed(container);
    stub?.on('bureau.workflows.pause', () => {
      throw workflowFaults.applyFailed();
    });
    const view = await openMenu(container, FILE_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Pause/ }));
    await waitFor(() => expect(stale()).not.toBeNull());

    await fireEvent.click(within(stale() as HTMLElement).getByRole('button', { name: /dismiss/i }));

    await waitFor(() => expect(stale()).toBeNull());
  });
});

describe('an agent run the Bureau does not name', () => {
  test('is labelled an agent run, and links nowhere, because no agent is known', async () => {
    const { container } = open('/schedules', { scheduleAgents: {} });
    await waitFor(() => expect(row(container, AGENT_SCHEDULE)?.dataset['kind']).toBe('agent-run'));

    const target = within(row(container, AGENT_SCHEDULE) as HTMLElement).getByTestId(
      'schedule-target',
    );
    expect(target.textContent).toContain(SCHEDULE_COPY.unnamedAgent);
    expect(target.querySelector('a')).toBeNull();
  });
});

describe('a link from what a schedule starts', () => {
  test('opens the agent, and leaves a modified click to the browser', async () => {
    const { container } = open('/schedules');
    await listed(container);
    const link = within(row(container, AGENT_SCHEDULE) as HTMLElement).getByRole('link', {
      name: 'assistant',
    });

    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/schedules');
    link.click();

    expect(router.pathname).toBe('/agents/assistant');
  });
});

describe('one schedule’s page, by kind', () => {
  test('an agent run pauses and resumes through the Bureau, naming the revision each time', async () => {
    const { findByRole } = open(`/schedules/${AGENT_SCHEDULE}`);

    await fireEvent.click(await findByRole('button', { name: /Pause/ }));
    await findByRole('button', { name: /Resume/ });
    expect(stub?.callsTo('bureau.schedules.pause')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      expectedRevision: 3,
    });
    await fireEvent.click(await findByRole('button', { name: /Resume/ }));
    await findByRole('button', { name: /Pause/ });
    expect(stub?.callsTo('bureau.schedules.resume')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      expectedRevision: 4,
    });
  });

  test('an agent run opens its edit drawer from Edit', async () => {
    const { findByRole } = open(`/schedules/${AGENT_SCHEDULE}`);

    await fireEvent.click(await findByRole('button', { name: 'Edit' }));

    await findByRole('dialog', { name: 'Edit schedule' });
    expect(router.search.get('edit')).toBe('1');
  });

  test('an agent run is cancelled through the Bureau, after the confirmation', async () => {
    const { findByRole, findByText } = open(`/schedules/${AGENT_SCHEDULE}`);

    await fireEvent.click(await findByRole('button', { name: 'More actions' }));
    await fireEvent.click(await findByRole('menuitem', { name: /Cancel/ }));
    expect(stub?.callsTo('bureau.schedules.cancel')).toEqual([]);
    await fireEvent.click(await findByText('Cancel schedule'));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.cancel').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.cancel')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      expectedRevision: 3,
    });
  });

  test('a workflow file’s schedule pauses and resumes through its file', async () => {
    const { findByRole } = open(`/schedules/${FILE_SCHEDULE}`);

    await fireEvent.click(await findByRole('button', { name: /Pause/ }));
    await findByRole('button', { name: /Resume/ });
    await fireEvent.click(await findByRole('button', { name: /Resume/ }));
    await findByRole('button', { name: /Pause/ });

    expect(stub?.callsTo('bureau.workflows.pause')[0]?.params).toEqual({
      id: 'digest',
      expectedHash: 'hash-1',
    });
    expect(stub?.callsTo('bureau.workflows.resume')).toHaveLength(1);
  });

  test('a code-defined schedule pauses through the engine', async () => {
    const { findByRole } = open(`/schedules/${CODE_SCHEDULE}`);

    await fireEvent.click(await findByRole('button', { name: /Pause/ }));

    await findByRole('button', { name: /Resume/ });
    expect(stub?.callsTo('POST pause /schedules/:id')).toHaveLength(1);
  });

  test('offers nothing to change to a schedule only the Bureau can place, and says that it has not', async () => {
    const { findByText, queryByRole } = open(`/schedules/${FILE_SCHEDULE}`, {
      failBureauSchedules: true,
      failBureauFiles: true,
    });

    await findByText(SCHEDULE_COPY.overlayFailed.title, { exact: false });
    expect(queryByRole('button', { name: /Pause/ })).toBeNull();
    expect(queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

describe('a code-defined schedule while the Bureau is not answering', () => {
  test('is paused through the engine all the same, from the list and from its page', async () => {
    const { container } = open('/schedules', { failBureauSchedules: true, failBureauFiles: true });
    await waitFor(() => expect(row(container, CODE_SCHEDULE)?.dataset['kind']).toBe('code'));

    const view = await openMenu(container, CODE_SCHEDULE);
    await fireEvent.click(view.getByRole('menuitem', { name: /Pause/ }));

    await waitFor(() => expect(row(container, CODE_SCHEDULE)?.dataset['status']).toBe('paused'));
    expect(stub?.callsTo('POST pause /schedules/:id').map((call) => call.params)).toEqual([
      { id: CODE_SCHEDULE },
    ]);
  });

  test('is resumed from its own page, which says the Bureau did not answer', async () => {
    const { findByRole, findByText } = open(`/schedules/${CODE_SCHEDULE}`, {
      failBureauSchedules: true,
      failBureauFiles: true,
    });

    await fireEvent.click(await findByRole('button', { name: /Pause/ }));
    await findByRole('button', { name: /Resume/ });
    await findByText(SCHEDULE_COPY.overlayFailed.title, { exact: false });
    expect(stub?.callsTo('POST pause /schedules/:id')).toHaveLength(1);
  });
});

describe('a schedule of an agent-authored workflow’s type that is not the file’s own', () => {
  // The engine can make a schedule for any registered type. It belongs to the engine, because the
  // Bureau decides a schedule is a file's by its id, and never by its type.
  const EXTRA = 'digest-every-hour';

  function withExtra() {
    const base = world();
    return open('/schedules', {
      schedules: [
        ...base.schedules,
        scheduleFixture(EXTRA, 'digest', { description: 'made by the engine' }),
      ],
    });
  }

  test('is the engine’s: it offers Cancel, and Pause goes through the engine and leaves the file alone', async () => {
    const { container } = withExtra();
    await waitFor(() => expect(row(container, EXTRA)?.dataset['kind']).toBe('code'));

    const view = await openMenu(container, EXTRA);
    expect(view.queryByRole('menuitem', { name: /Cancel/ }) === null).toBe(false);
    expect(
      view.queryByRole('menuitem', { name: new RegExp(SCHEDULE_COPY.editWorkflowAction) }) === null,
    ).toBe(true);
    await fireEvent.click(view.getByRole('menuitem', { name: /Pause/ }));

    await waitFor(() => expect(row(container, EXTRA)?.dataset['status']).toBe('paused'));
    expect(stub?.callsTo('POST pause /schedules/:id').map((call) => call.params)).toEqual([
      { id: EXTRA },
    ]);
    expect(stub?.callsTo('bureau.workflows.pause')).toEqual([]);
    expect(stub?.file('digest')?.paused).toBe(false);
  });

  test('is still the file’s own schedule, by its id, beside it', async () => {
    const { container } = withExtra();
    await waitFor(() => expect(row(container, EXTRA)?.dataset['kind']).toBe('code'));

    expect(row(container, FILE_SCHEDULE)?.dataset['kind']).toBe('workflow-file');
  });

  test('is of no known kind, and nothing is written, when the Bureau did not list the file’s own schedule', async () => {
    // A caller who cannot see the deployment’s schedules cannot tell whose this is.
    const { container } = open('/schedules', {
      files: [readyFile('digest')],
      schedules: [scheduleFixture(EXTRA, 'digest')],
    });
    await waitFor(() => expect(row(container, EXTRA)?.dataset['kind']).toBe('unknown'));

    const view = await openMenu(container, EXTRA);
    expect(view.queryByRole('menuitem', { name: /Pause/ }) === null).toBe(true);
    expect(view.queryByRole('menuitem', { name: /Cancel/ }) === null).toBe(true);
  });
});

describe('a schedule is named by what it does', () => {
  test('a row says its name, its agent, its cadence in words, and what it sends, and never its identifier', async () => {
    const { container } = open('/schedules');
    await listed(container);

    const agent = row(container, AGENT_SCHEDULE) as HTMLElement;
    const view = within(agent);
    expect(view.getByRole('link', { name: 'Daily summary' }).getAttribute('href')).toBe(
      `/schedules/${AGENT_SCHEDULE}`,
    );
    expect(view.getByRole('link', { name: 'assistant' })).not.toBeNull();
    expect(view.getByText('Every 5 minutes')).not.toBeNull();
    expect(view.getByTestId('schedule-input').textContent).toBe(
      '“Summarize what happened yesterday.”',
    );
    expect(agent.textContent).not.toContain(AGENT_SCHEDULE);
    // A schedule with no description is named by what it starts.
    const code = within(row(container, CODE_SCHEDULE) as HTMLElement);
    expect(code.getByRole('link', { name: 'Schedule for order-processing' })).not.toBeNull();
    expect(
      (await openMenu(container, AGENT_SCHEDULE)).getByRole('menuitem', { name: 'Copy id' }),
    ).not.toBeNull();
  });

  test('the Agent filter narrows the list to that agent’s schedules, and the address carries it', async () => {
    const { container, findByRole } = open('/schedules');
    await listed(container);

    await fireEvent.change(await findByRole('combobox', { name: 'Agent' }), {
      target: { value: 'assistant' },
    });

    await waitFor(() => expect(router.search.get('agent')).toBe('assistant'));
    await waitFor(() => expect(row(container, CODE_SCHEDULE)).toBeNull());
    expect(row(container, AGENT_SCHEDULE)).not.toBeNull();
  });

  test('one schedule’s page says what it sends', async () => {
    const { findByTestId } = open(`/schedules/${AGENT_SCHEDULE}`);

    expect((await findByTestId('schedule-input')).textContent).toContain(
      '“Summarize what happened yesterday.”',
    );
  });
});
