/**
 * COR-1494: the schedules area writes each kind of schedule through the service that owns it, and
 * labels and links each by what it starts. An agent run is the Bureau's (`bureau.schedules.*`, with
 * the revision the page read), a workflow file's schedule is its trigger (`bureau.workflows.pause`
 * and `resume`, with the hash of the file the page read), and any other is the engine's, which has no
 * revision to compare, so the page reads the schedule again just before it writes. A write that was
 * stale says so inline, and reloads the row.
 *
 * One schedule's page is driven against `installWorkflowWorld`, a stand-in for the
 * engine and the Bureau that keeps the schedules and files as a world a test can change, and
 * answers a write the way each service does.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { SCHEDULE_COPY } from '../../app/copy/schedules.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  readyFile,
  scheduleFixture,
  sourceDefinition,
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

/** The page's On switch, waited for until it says `on` or off and is free to be pressed again. */
async function switchIs(
  findByRole: (role: string, options: { name: string | RegExp }) => Promise<HTMLElement>,
  on: boolean,
): Promise<void> {
  await waitFor(async () => {
    const toggle = await findByRole('switch', { name: /^Active, / });
    expect(toggle.getAttribute('aria-checked')).toBe(String(on));
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
  });
}

/** Presses the page's On switch. */
async function pressSwitch(
  findByRole: (role: string, options: { name: string | RegExp }) => Promise<HTMLElement>,
): Promise<void> {
  await fireEvent.click(await findByRole('switch', { name: /^Active, / }));
}

describe('what a schedule starts', () => {
  test('is linked the same way on one schedule’s page', async () => {
    const { findByTestId } = open(`/schedules/${AGENT_SCHEDULE}`);
    // The sentence under the title and the details beside the runs each say what it runs.
    const sentence = within(await findByTestId('schedule-status-line'));
    const agent = await sentence.findByRole('link', { name: 'Assistant' });
    expect(agent.getAttribute('href')).toBe('/agents/assistant');
    const card = within(await findByTestId('schedule-details'));
    const cardAgent = await card.findByRole('link', { name: 'Assistant' });
    expect(cardAgent.getAttribute('href')).toBe('/agents/assistant');
  });
});

describe('a stale write', () => {
  test('on one schedule’s page says it changed since it was loaded, and reloads it', async () => {
    const { findByRole, findByText } = open(`/schedules/${AGENT_SCHEDULE}`);
    await switchIs(findByRole, true);
    const other = stub?.world.schedules.find((schedule) => schedule.id === AGENT_SCHEDULE);
    if (other === undefined) throw new Error('expected the seeded schedule');
    other.status = 'paused';
    other.revision = 4;

    await pressSwitch(findByRole);

    await findByText(SCHEDULE_COPY.stale.title(AGENT_SCHEDULE));
    // Reloaded: what the page offers now is what the schedule is now.
    await switchIs(findByRole, false);
  });
});

describe('a workflow file’s schedule', () => {
  test('has no Delete on its page, and its Edit opens the workflow’s editor instead', async () => {
    const { findByRole, queryByRole } = open(`/schedules/${FILE_SCHEDULE}`);

    const edit = await findByRole('link', { name: 'Edit' });
    expect(queryByRole('button', { name: /Cancel/ })).toBeNull();
    await fireEvent.click(edit);

    expect(router.pathname).toBe('/workflows/digest/edit');
  });
});

describe('one schedule’s page, by kind', () => {
  test('an agent run pauses and resumes through the Bureau, naming the revision each time', async () => {
    const { findByRole } = open(`/schedules/${AGENT_SCHEDULE}`);

    await switchIs(findByRole, true);
    await pressSwitch(findByRole);
    await switchIs(findByRole, false);
    expect(stub?.callsTo('bureau.schedules.pause')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      expectedRevision: 3,
    });
    await pressSwitch(findByRole);
    await switchIs(findByRole, true);
    expect(stub?.callsTo('bureau.schedules.resume')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      expectedRevision: 4,
    });
  });

  test('an agent run opens its edit page from Edit', async () => {
    const { findByRole } = open(`/schedules/${AGENT_SCHEDULE}`);

    await fireEvent.click(await findByRole('button', { name: 'Edit' }));

    await findByRole('heading', { level: 1, name: /^Edit / });
    expect(router.pathname).toBe(`/schedules/${AGENT_SCHEDULE}/edit`);
  });

  test('an agent run is deleted through the Bureau, after the confirmation', async () => {
    const { findByRole } = open(`/schedules/${AGENT_SCHEDULE}`);

    await fireEvent.click(await findByRole('button', { name: 'More actions' }));
    await fireEvent.click(await findByRole('menuitem', { name: 'Delete schedule' }));
    expect(stub?.callsTo('bureau.schedules.cancel')).toEqual([]);
    const dialog = within(await findByRole('dialog'));
    await fireEvent.click(dialog.getByRole('button', { name: 'Delete schedule' }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.cancel').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.cancel')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      expectedRevision: 3,
    });
  });

  test('a workflow file’s schedule pauses and resumes through its file', async () => {
    const { findByRole } = open(`/schedules/${FILE_SCHEDULE}`);

    await switchIs(findByRole, true);
    await pressSwitch(findByRole);
    await switchIs(findByRole, false);
    await pressSwitch(findByRole);
    await switchIs(findByRole, true);

    expect(stub?.callsTo('bureau.workflows.pause')[0]?.params).toEqual({
      id: 'digest',
      expectedHash: 'hash-1',
    });
    expect(stub?.callsTo('bureau.workflows.resume')).toHaveLength(1);
  });

  test('a code-defined schedule pauses through the engine', async () => {
    const { findByRole } = open(`/schedules/${CODE_SCHEDULE}`);

    await switchIs(findByRole, true);
    await pressSwitch(findByRole);

    await switchIs(findByRole, false);
    expect(stub?.callsTo('POST pause /schedules/:schedule')).toHaveLength(1);
  });

  test('offers nothing to change to a schedule only the Bureau can place, and says that it has not', async () => {
    const { findByText, queryByRole } = open(`/schedules/${FILE_SCHEDULE}`, {
      failBureauSchedules: true,
      failBureauFiles: true,
    });

    await findByText(SCHEDULE_COPY.overlayFailed.title, { exact: false });
    expect(queryByRole('switch', { name: /^Active, / })).toBeNull();
    expect(queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

describe('a code-defined schedule while the Bureau is not answering', () => {
  test('is resumed from its own page, which says the Bureau did not answer', async () => {
    const { findByRole, findByText } = open(`/schedules/${CODE_SCHEDULE}`, {
      failBureauSchedules: true,
      failBureauFiles: true,
    });

    await switchIs(findByRole, true);
    await pressSwitch(findByRole);
    await switchIs(findByRole, false);
    await findByText(SCHEDULE_COPY.overlayFailed.title, { exact: false });
    expect(stub?.callsTo('POST pause /schedules/:schedule')).toHaveLength(1);
  });
});

describe('a schedule is named by what it does', () => {
  test('one schedule’s page says what it sends', async () => {
    const { findByTestId } = open(`/schedules/${AGENT_SCHEDULE}`);

    const input = await findByTestId('schedule-input');
    expect(input.textContent).toContain('Message');
    expect(input.textContent).toContain('Summarize what happened yesterday.');
  });
});
