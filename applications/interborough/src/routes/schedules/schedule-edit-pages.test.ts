/**
 * `/schedules/:schedule/edit` (COR-2018, rows 74r, 74t, 75p, 75q): the form that makes a schedule,
 * opened on the schedule. Editing a chat sends the Bureau the cadence, name and overlap policy
 * that changed; an engine schedule sends the engine its own; a workflow file's schedule has no
 * form, because its cadence is the trigger in the file; a schedule whose workflow was deleted
 * keeps the old name, marked, and Save moves focus to the Workflow field.
 *
 * Making a schedule is its own page (`new-schedule.test.ts`). Driven against
 * `installWorkflowWorld`, as `schedule-owners.test.ts` is.
 */
import { RUN_ENGINE_WORKFLOW_TYPES } from '@lostgradient/operative/run-engine-workflow-types';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { requireElement } from '../../../tests/dom.test-support.ts';
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

// The first agent is the one a test chooses: happy-dom never matches `:checked` on an option, so a
// bound select takes its first enabled option on every change. The Playwright suite chooses by name.
const AGENTS = ['tool-runner', 'assistant'].map((name) => ({
  name,
  displayName: name,
  description: null,
  definitionRevision: 1,
  kind: 'code',
  a2a: false,
}));

function world(overrides: Partial<World> = {}): World {
  return emptyWorld({
    definitions: [
      codeDefinition('order-processing'),
      codeDefinition('inventory-sync'),
      // Every type the Bureau's run engine registers is in the registry of a host whose console is the Bureau's engine.
      ...RUN_ENGINE_WORKFLOW_TYPES.map((type) => codeDefinition(type)),
      sourceDefinition('digest'),
    ],
    files: [readyFile('digest')],
    schedules: [
      scheduleFixture(AGENT_SCHEDULE, 'agentRun', {
        description: 'Daily summary',
        cronExpression: '0 9 * * *',
        revision: 3,
      }),
      scheduleFixture(FILE_SCHEDULE, 'digest'),
      scheduleFixture(CODE_SCHEDULE, 'order-processing', { revision: 5 }),
    ],
    scheduleAgents: { [AGENT_SCHEDULE]: 'assistant' },
    scheduleInputs: { [AGENT_SCHEDULE]: 'Summarize yesterday’s chats and open reviews.' },
    agents: AGENTS,
    ...overrides,
  });
}

/** `before` changes how the services answer, ahead of the first request the page makes. */
function open(
  path: string,
  overrides: Partial<World> = {},
  before: (installed: WorkflowStub) => void = () => undefined,
) {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  stub = installWorkflowWorld(world(overrides));
  before(stub);
  router.navigate(path, { replace: true });
  return render(IndexHarness, { props: { client: stub.client, externalBureau: true } });
}

/** The edit page, once it has the form for the schedule's kind. */
async function page(name: string = 'Edit Daily summary') {
  const view = within(document.body);
  await view.findByRole('heading', { level: 1, name });
  const form = within(
    requireElement(document.querySelector('[data-page="schedule-edit"]'), HTMLElement),
  );
  // The picker has its list, so Save is on and the Workflow field says what it holds.
  await waitFor(() =>
    expect(form.getByRole('combobox', { name: /^Workflow/ }).textContent).not.toContain(
      'Loading workflows',
    ),
  );
  return form;
}

const SAVE = 'Save changes';

describe('editing a chat', () => {
  test('opens as the new schedule form filled in, with the note, the footer and the buttons the design draws (74r, 74t)', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    // Row 74r: the heading, and the note that the page is opened from When › Edit on the schedule page.
    expect(form.getByRole('heading', { level: 1 }).textContent).toBe('Edit Daily summary');
    expect(document.querySelector('[data-page="schedule-edit"]')?.textContent).toContain(
      SCHEDULE_COPY.edit.description,
    );
    expect(
      form.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['What runs', 'Input', 'When']);
    // What runs, Input, When, then Name, each filled in from the schedule.
    expect(form.getByRole('combobox', { name: /^Workflow/ }).textContent).toContain(
      'Chat with an agent',
    );
    expect((form.getByLabelText(/^Agent/) as HTMLSelectElement).value).toBe('assistant');
    expect((form.getByLabelText(/^Message/) as HTMLTextAreaElement).value).toBe(
      'Summarize yesterday’s chats and open reviews.',
    );
    expect((form.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Daily summary');
    expect(form.getByLabelText('Repeats')).not.toBeNull();
    // The board draws live fields: Workflow, Agent, Message and Continue one chat all take edits.
    expect(form.getByRole('combobox', { name: /^Workflow/ })).not.toBeDisabled();
    expect(form.getByLabelText(/^Agent/)).not.toBeDisabled();
    expect(form.getByLabelText(/^Message/)).not.toBeDisabled();
    expect(form.getByRole('switch', { name: /Continue one chat/ })).not.toBeDisabled();
    // The footer says what Save does, beside Cancel and Save changes.
    expect(form.getByTestId('new-schedule-summary').textContent).toBe(
      'Saves changes to Daily summary.',
    );
    const save = form.getByRole('button', { name: SAVE });
    expect(save).not.toBeDisabled();
    expect(form.queryByRole('button', { name: 'Create schedule' })).toBeNull();
    expect(form.getByRole('link', { name: 'Cancel' }).getAttribute('href')).toBe(
      `/schedules/${AGENT_SCHEDULE}`,
    );
  });

  test('moves focus to Repeats, the first field of When, when it opens (74r)', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    await waitFor(() =>
      expect(document.activeElement === form.getByLabelText('Repeats')).toBe(true),
    );
  });

  test('saves through bureau.schedules.update, with only what changed and the revision the page read', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    await fireEvent.input(form.getByLabelText(/^Name/), { target: { value: 'Morning summary' } });
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      spec: '0 9 * * *',
      description: 'Morning summary',
      expectedRevision: 3,
    });
    // The engine's own update is not used for it, and the page goes back to the schedule.
    expect(stub?.callsTo('PATCH /schedules/:schedule')).toEqual([]);
    await waitFor(() => expect(router.pathname).toBe(`/schedules/${AGENT_SCHEDULE}`));
  });

  test('saves the agent, the message and the chat it now continues with the Bureau, and the next edit sees them (74r)', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    await fireEvent.change(form.getByLabelText(/^Agent/), { target: { value: 'tool-runner' } });
    await fireEvent.input(form.getByLabelText(/^Message/), {
      target: { value: 'Summarize the week.' },
    });
    await fireEvent.click(form.getByRole('switch', { name: /Continue one chat/ }));
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    const params = stub?.callsTo('bureau.schedules.update')[0]?.params;
    expect(params).toMatchObject({
      scheduleId: AGENT_SCHEDULE,
      spec: '0 9 * * *',
      agentName: 'tool-runner',
      input: 'Summarize the week.',
      expectedRevision: 3,
    });
    expect(params).toMatchObject({ continueChat: true });
    expect(params).not.toHaveProperty('sessionId');
    expect(stub?.world.scheduleAgents[AGENT_SCHEDULE]).toBe('tool-runner');
    expect(stub?.world.scheduleInputs[AGENT_SCHEDULE]).toBe('Summarize the week.');
    expect(stub?.world.scheduleContinuing).toEqual([AGENT_SCHEDULE]);
    await waitFor(() => expect(router.pathname).toBe(`/schedules/${AGENT_SCHEDULE}`));
  });

  test('a new agent for a schedule that keeps continuing a chat starts a new chat with the change', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`, { scheduleContinuing: [AGENT_SCHEDULE] });
    const form = await page();
    await fireEvent.change(form.getByLabelText(/^Agent/), { target: { value: 'tool-runner' } });
    expect(await form.findByText(/saving starts a new chat/)).toBeTruthy();
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params).toMatchObject({
      agentName: 'tool-runner',
      continueChat: true,
    });
    expect(stub?.world.scheduleAgents[AGENT_SCHEDULE]).toBe('tool-runner');
    expect(stub?.world.scheduleContinuing).toEqual([AGENT_SCHEDULE]);
    await waitFor(() => expect(router.pathname).toBe(`/schedules/${AGENT_SCHEDULE}`));
  });

  test('a chat that continues one opens with the toggle on, and turns it off by sending no chat', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`, { scheduleContinuing: [AGENT_SCHEDULE] });
    const form = await page();

    expect(
      form.getByRole('switch', { name: /Continue one chat/ }).getAttribute('aria-checked'),
    ).toBe('true');
    await fireEvent.click(form.getByRole('switch', { name: /Continue one chat/ }));
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      spec: '0 9 * * *',
      sessionId: null,
      expectedRevision: 3,
    });
    expect(stub?.world.scheduleContinuing).toEqual([]);
  });

  test('an emptied message is said at the field and nothing is written', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    await fireEvent.input(form.getByLabelText(/^Message/), { target: { value: '' } });
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() =>
      expect(form.getByLabelText(/^Message/).getAttribute('aria-invalid')).toBe('true'),
    );
    expect(stub?.callsTo('bureau.schedules.update')).toEqual([]);
  });

  test('a message the Bureau showed only the start of is left as it is, so a save never shortens it', async () => {
    const cut = `${'a'.repeat(499)}…`;
    open(`/schedules/${AGENT_SCHEDULE}/edit`, { scheduleInputs: { [AGENT_SCHEDULE]: cut } });
    const form = await page();

    expect(form.getByLabelText(/^Message/)).toBeDisabled();
    await fireEvent.click(form.getByRole('button', { name: SAVE }));
    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params).not.toHaveProperty('input');
  });

  test('the Workflow field offers the chat alone, because a chat cannot be moved to the engine’s workflows', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    await fireEvent.click(form.getByRole('combobox', { name: /^Workflow/ }));
    const listbox = requireElement(document.querySelector('[role="listbox"]'), HTMLElement);
    const options = [...listbox.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('Chat with an agent'),
    ]);
  });

  test('sends only the cadence when nothing else changed', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      spec: '0 9 * * *',
      expectedRevision: 3,
    });
  });

  test('a name another schedule has is said at the field, and the schedule’s own name is not one', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    // Saving under its own name is no clash.
    await fireEvent.click(form.getByRole('button', { name: SAVE }));
    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
  });

  test('says it changed since it was loaded when the schedule changed first, keeps what was typed, and starts over on request', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();
    // Another actor changed the schedule after the page read it.
    const other = stub?.world.schedules.find((schedule) => schedule.id === AGENT_SCHEDULE);
    if (other === undefined) throw new Error('expected the seeded schedule');
    other.description = 'Changed elsewhere';
    other.revision = 4;
    other.updatedAt += 1;

    await fireEvent.input(form.getByLabelText(/^Name/), { target: { value: 'My edit' } });
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    const notice = await form.findByTestId('schedule-notice');
    expect(notice.textContent).toContain(SCHEDULE_COPY.stale.title(AGENT_SCHEDULE));
    // Nothing was written, what was typed is still there, and saving again is not offered.
    expect(other.description).toBe('Changed elsewhere');
    expect((form.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('My edit');
    expect(form.getByRole('button', { name: SAVE })).toBeDisabled();

    await fireEvent.click(form.getByRole('button', { name: /Start over/ }));

    await waitFor(() =>
      expect((within(document.body).getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
        'Changed elsewhere',
      ),
    );
    await fireEvent.click(within(document.body).getByRole('button', { name: SAVE }));
    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(2));
    expect(stub?.callsTo('bureau.schedules.update').at(-1)?.params).toMatchObject({
      expectedRevision: 4,
    });
  });

  test('an agent run’s cadence can be changed to an interval, which is sent as a duration', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    await fireEvent.change(form.getByLabelText('Repeats'), { target: { value: 'interval' } });
    await fireEvent.change(form.getByLabelText('Unit'), { target: { value: 'minutes' } });
    const every = form.getByLabelText('Every');
    await fireEvent.input(every, { target: { value: '20' } });
    await fireEvent.change(every, { target: { value: '20' } });
    await fireEvent.blur(every);
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params['spec']).toBe('20m');
  });

  test('is not saved while the cadence builder shows a field out of range, and focus moves to it', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    await fireEvent.change(form.getByLabelText('Repeats'), { target: { value: 'cron' } });
    const hour = form.getByLabelText('Hour');
    await fireEvent.input(hour, { target: { value: '99' } });
    // The builder keeps the last cadence it emitted, so the draft is still valid and Save is on.
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(document.activeElement === hour).toBe(true));
    expect(stub?.callsTo('bureau.schedules.update')).toEqual([]);
    expect(router.pathname).toBe(`/schedules/${AGENT_SCHEDULE}/edit`);
  });

  test('a name that is too long says so and is not sent', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    await fireEvent.input(form.getByLabelText(/^Name/), { target: { value: 'x'.repeat(2_001) } });
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await form.findByText(SCHEDULE_COPY.create.nameTooLong(2_000));
    expect(stub?.callsTo('bureau.schedules.update')).toEqual([]);
  });

  test('leaving after a change asks first, with Keep editing as the default', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    await fireEvent.input(form.getByLabelText(/^Name/), { target: { value: 'Changed' } });
    await fireEvent.click(form.getByRole('link', { name: 'Cancel' }));

    const dialog = await within(document.body).findByRole('dialog');
    expect(dialog.textContent).toContain(SCHEDULE_COPY.edit.discard.title);
    expect(router.pathname).toBe(`/schedules/${AGENT_SCHEDULE}/edit`);
  });

  test('says when saving did not reach the Bureau, and keeps what was changed', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`, {}, (installed) =>
      installed.on('bureau.schedules.update', () => {
        throw workflowFaults.unavailable();
      }),
    );
    const form = await page();

    await fireEvent.input(form.getByLabelText(/^Name/), { target: { value: 'Changed' } });
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    const alert = await form.findByTestId('new-schedule-failed');
    expect(alert.textContent).toContain(SCHEDULE_COPY.edit.failed.title);
    expect((form.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Changed');
  });
});

describe('editing an engine schedule', () => {
  test('opens on its workflow with the input kept as it was made, and saves through the engine', async () => {
    open(`/schedules/${CODE_SCHEDULE}/edit`);
    const form = await page('Edit Order processing');

    expect(form.getByRole('combobox', { name: /^Workflow/ })).toBeDisabled();
    expect(form.getByTestId('edit-schedule-fixed-input').textContent).toContain(
      SCHEDULE_COPY.edit.fixedInput,
    );
    expect(form.getByTestId('new-schedule-summary').textContent).toBe(
      'Saves changes to Order processing.',
    );
    await waitFor(() =>
      expect(document.activeElement === form.getByLabelText('Repeats')).toBe(true),
    );

    await fireEvent.input(form.getByLabelText(/^Name/), { target: { value: 'Edited' } });
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(stub?.callsTo('PATCH /schedules/:schedule').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')).toEqual([]);
    expect(stub?.callsTo('PATCH /schedules/:schedule body')[0]?.params).toMatchObject({
      description: 'Edited',
    });
  });

  test('a schedule on an interval is edited and saved as an interval', async () => {
    const hourly = scheduleFixture('every-hour', 'order-processing', {
      intervalMs: 3_600_000,
      revision: 2,
      description: 'Hourly',
    });
    delete hourly.cronExpression;
    open(`/schedules/every-hour/edit`, { schedules: [hourly] });
    const form = await page('Edit Hourly');

    await fireEvent.input(form.getByLabelText(/^Name/), { target: { value: 'Hourly, edited' } });
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(stub?.callsTo('PATCH /schedules/:schedule body').length).toBe(1));
    expect(stub?.callsTo('PATCH /schedules/:schedule body')[0]?.params).toMatchObject({
      every: 3_600_000,
      description: 'Hourly, edited',
    });
  });

  test('a policy the builder does not offer stays chosen, beside the two it does', async () => {
    const queued = scheduleFixture('queued', 'order-processing', { overlap: 'queue', revision: 2 });
    open(`/schedules/queued/edit`, { schedules: [queued] });
    const form = await page('Edit Order processing');

    const overlap = form.getByLabelText('If a run is still going') as HTMLSelectElement;
    expect(overlap.value).toBe('queue');
    expect([...overlap.options].map((option) => option.textContent?.trim())).toEqual([
      'Skip this one',
      'Start another run',
      'Queue this one',
    ]);
    await fireEvent.click(form.getByRole('button', { name: SAVE }));
    await waitFor(() => expect(stub?.callsTo('PATCH /schedules/:schedule body').length).toBe(1));
    // Nothing changed, so no option is sent.
    expect(stub?.callsTo('PATCH /schedules/:schedule body')[0]?.params).not.toHaveProperty(
      'overlap',
    );
  });
});

describe('editing a schedule whose workflow was deleted', () => {
  const GONE = 'weekly-cleanup';
  const GONE_NAME = 'Weekly cleanup';

  function gone(): Partial<World> {
    return {
      schedules: [
        scheduleFixture(GONE, 'weekly-cleanup', {
          description: GONE_NAME,
          status: 'paused',
          revision: 2,
        }),
      ],
    };
  }

  test('keeps the old name in the Workflow field, marked, with the message under it (75p)', async () => {
    open(`/schedules/${GONE}/edit`, gone());
    const form = await page(`Edit ${GONE_NAME}`);

    const field = await waitFor(() => {
      const combobox = form.getByRole('combobox', { name: /^Workflow/ });
      expect(combobox.textContent).toContain('Weekly cleanup, can’t find this workflow');
      return combobox;
    });
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field).not.toBeDisabled();
    await form.findByText(SCHEDULE_COPY.edit.workflowGone.message);
    // The note says focus lands on Repeats, which it does not here, so it is not drawn.
    expect(document.querySelector('[data-page="schedule-edit"]')?.textContent).not.toContain(
      SCHEDULE_COPY.edit.description,
    );
    // There is no input to ask for under a workflow that is gone.
    expect(form.queryByTestId('edit-schedule-fixed-input')).toBeNull();
  });

  test('keeps Save changes enabled, with the footer line, and moves focus to the Workflow field on submit (75q)', async () => {
    open(`/schedules/${GONE}/edit`, gone());
    const form = await page(`Edit ${GONE_NAME}`);
    await form.findByText(SCHEDULE_COPY.edit.workflowGone.message);

    expect(form.getByTestId('new-schedule-summary').textContent).toBe(
      `Saves changes to ${GONE_NAME}.`,
    );
    expect(form.getByRole('link', { name: 'Cancel' })).not.toBeNull();
    const save = form.getByRole('button', { name: SAVE });
    expect(save).not.toBeDisabled();
    // Focus did not move to Repeats on open.
    expect(document.activeElement === form.getByLabelText('Repeats')).toBe(false);

    await fireEvent.click(save);

    await waitFor(() =>
      expect(document.activeElement === form.getByRole('combobox', { name: /^Workflow/ })).toBe(
        true,
      ),
    );
    expect(stub?.callsTo('PATCH /schedules/:schedule')).toEqual([]);
  });
});

describe('editing a workflow file’s schedule', () => {
  test('has no form, because its cadence is the trigger in the workflow’s file, and links to the editor', async () => {
    open(`/schedules/${FILE_SCHEDULE}/edit`);
    const view = within(document.body);
    await view.findByRole('heading', { level: 1, name: 'Edit schedule' });

    const note = await view.findByTestId('schedule-edit-in-workflow');
    expect(note.textContent).toContain(SCHEDULE_COPY.editWorkflowNote);
    expect(view.queryByLabelText(/^Name/)).toBeNull();
    expect(view.queryByRole('button', { name: SAVE })).toBeNull();
    await fireEvent.click(view.getByRole('link', { name: SCHEDULE_COPY.editWorkflowAction }));

    expect(router.pathname).toBe('/workflows/digest/edit');
  });
});

describe('the edit page when something is not as it was', () => {
  test('says so when the Bureau has not said what the schedule is, and offers nothing', async () => {
    // A workflow file's schedule: only the Bureau says whose it is, and it did not answer.
    open(`/schedules/${FILE_SCHEDULE}/edit`, {
      failBureauSchedules: true,
      failBureauFiles: true,
    });
    const view = within(document.body);

    await view.findByText(SCHEDULE_COPY.overlayFailed.title, { exact: false });
    expect(view.queryByLabelText(/^Name/)).toBeNull();
  });

  test('says so when the schedule is not there', async () => {
    open('/schedules/no-such-schedule/edit');

    await within(document.body).findByText(SCHEDULE_COPY.detail.notFound.description);
  });
});

describe('a cadence of less than a minute', () => {
  // The schedule builder counts in whole minutes at the smallest, so it cannot show these exactly.
  const SECONDS_AGENT = 'every-thirty-seconds';
  const SECONDS_CODE = 'every-ninety-seconds';

  function secondsWorld(): Partial<World> {
    const agent = scheduleFixture(SECONDS_AGENT, 'agentRun', {
      description: 'Thirty seconds',
      intervalMs: 30_000,
      revision: 2,
    });
    delete agent.cronExpression;
    const code = scheduleFixture(SECONDS_CODE, 'order-processing', {
      description: 'Ninety seconds',
      intervalMs: 90_000,
      revision: 4,
    });
    delete code.cronExpression;
    return {
      schedules: [agent, code],
      scheduleAgents: { [SECONDS_AGENT]: 'assistant' },
    };
  }

  test('a chat says how often it runs, and an edit of only the name sends the cadence exactly', async () => {
    open(`/schedules/${SECONDS_AGENT}/edit`, secondsWorld());
    const form = await page('Edit Thirty seconds');

    const note = form.getByTestId('edit-schedule-exact-cadence');
    expect(note.textContent).toContain('every 30 seconds');
    await fireEvent.input(form.getByLabelText(/^Name/), { target: { value: 'Still thirty' } });
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params).toEqual({
      scheduleId: SECONDS_AGENT,
      spec: '30s',
      description: 'Still thirty',
      expectedRevision: 2,
    });
  });

  test('an engine schedule does the same, and sends every as milliseconds', async () => {
    open(`/schedules/${SECONDS_CODE}/edit`, secondsWorld());
    const form = await page('Edit Ninety seconds');

    expect(form.getByTestId('edit-schedule-exact-cadence').textContent).toContain(
      'every 90 seconds',
    );
    await fireEvent.input(form.getByLabelText(/^Name/), { target: { value: 'Still ninety' } });
    await fireEvent.click(form.getByRole('button', { name: SAVE }));

    await waitFor(() => expect(stub?.callsTo('PATCH /schedules/:schedule body').length).toBe(1));
    const body = stub?.callsTo('PATCH /schedules/:schedule body')[0]?.params;
    expect(body).toMatchObject({ every: 90_000, description: 'Still ninety' });
    expect(body).not.toHaveProperty('cronExpression');
  });

  test('a whole-minute cadence says nothing about it', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const form = await page();

    expect(form.queryByTestId('edit-schedule-exact-cadence')).toBeNull();
  });
});
