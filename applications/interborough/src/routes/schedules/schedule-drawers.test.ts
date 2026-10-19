/**
 * COR-1494: what the create and edit drawers offer for each kind of schedule.
 *
 * - Editing an agent run offers exactly the cadence, the description, and the overlap policy
 *   (`skip` or `allow`), which are the fields `bureau.schedules.update` takes. A code-defined
 *   schedule keeps the engine's full drawer. A workflow file's schedule has no drawer, because its
 *   cadence is the trigger in the file.
 * - Creating asks what to start. An agent run goes through `bureau.schedules.create`, and a
 *   code-defined workflow type through the engine. The list of types leaves out the agent-authored
 *   ones, whose schedule is the file's own trigger, and `agentRun`, whose schedules only the agent
 *   choice makes, with its owner and agent checks.
 *
 * Driven against `installWorkflowWorld`, as `schedule-owners.test.ts` is.
 */
import { RUN_ENGINE_WORKFLOW_TYPES } from '@lostgradient/operative/run-engine-workflow-types';
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

// The first agent is the one a test chooses: happy-dom never matches `:checked` on an option, so a
// bound select takes its first enabled option on every change. The Playwright suite chooses by name.
const AGENTS = ['tool-runner', 'assistant'].map((name) => ({
  name,
  displayName: name,
  description: null,
  definitionRevision: 1,
  kind: 'code',
  publishState: 'published',
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

/** The drawer, once it has the form for the schedule's kind. */
async function drawer(name: 'Edit schedule' | 'Create schedule') {
  const view = within(document.body);
  return view.findByRole('dialog', { name });
}

const OVERLAP = 'If a run is still going when the next fire is due';

describe('editing an agent run', () => {
  test('offers exactly the cadence, the description, and the overlap policy, skip or allow', async () => {
    open(`/schedules/${AGENT_SCHEDULE}?edit=1`);
    const dialog = within(await drawer('Edit schedule'));
    await dialog.findByLabelText('Description');

    expect((dialog.getByLabelText('Description') as HTMLInputElement).value).toBe('Daily summary');
    // The cadence is the schedule builder's, and the overlap policy has the two the Bureau offers.
    expect(dialog.getAllByText('Cadence').length).toBeGreaterThan(0);
    const overlap = within(dialog.getByRole('group', { name: OVERLAP }));
    expect(overlap.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual([
      'skip',
      'allow',
    ]);
    // Everything else the engine's drawer has is left out: none of it is a field of the update.
    for (const label of [
      'Jitter',
      'Backfill missed occurrences',
      'Start paused',
      'Workflow type',
      'Schedule ID',
      'Input',
      'Agent',
      'Session',
    ]) {
      expect(dialog.queryByLabelText(label), label).toBeNull();
    }
    expect(dialog.queryByRole('group', { name: /Which revision future occurrences/ })).toBeNull();
    expect(dialog.queryByRole('radio', { name: /Queue/ })).toBeNull();
  });

  test('saves through bureau.schedules.update, with the cadence and the revision the drawer read', async () => {
    open(`/schedules/${AGENT_SCHEDULE}?edit=1`);
    const dialog = within(await drawer('Edit schedule'));
    const description = await dialog.findByLabelText('Description');

    await fireEvent.input(description, { target: { value: 'Morning summary' } });
    await fireEvent.click(dialog.getByRole('radio', { name: /Allow/ }));
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      spec: '0 9 * * *',
      description: 'Morning summary',
      overlap: 'allow',
      expectedRevision: 3,
    });
    // The engine's own update is not used for it.
    expect(stub?.callsTo('PATCH /schedules/:id')).toEqual([]);
    // The drawer closed, back to the schedule's page.
    await waitFor(() => expect(router.search.get('edit')).toBeNull());
    expect(router.pathname).toBe(`/schedules/${AGENT_SCHEDULE}`);
  });

  test('sends only the cadence when nothing else changed', async () => {
    open(`/schedules/${AGENT_SCHEDULE}?edit=1`);
    const dialog = within(await drawer('Edit schedule'));
    await dialog.findByLabelText('Description');

    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      spec: '0 9 * * *',
      expectedRevision: 3,
    });
  });

  test('says it changed since it was loaded when the schedule changed first, keeps what was typed, and starts over on request', async () => {
    open(`/schedules/${AGENT_SCHEDULE}?edit=1`);
    const dialog = within(await drawer('Edit schedule'));
    const description = await dialog.findByLabelText('Description');
    // Another actor changed the schedule after the drawer read it.
    const other = stub?.world.schedules.find((schedule) => schedule.id === AGENT_SCHEDULE);
    if (other === undefined) throw new Error('expected the seeded schedule');
    other.description = 'Changed elsewhere';
    other.revision = 4;
    other.updatedAt += 1;

    await fireEvent.input(description, { target: { value: 'My edit' } });
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    const notice = await dialog.findByTestId('schedule-notice');
    expect(notice.textContent).toContain(SCHEDULE_COPY.stale.title(AGENT_SCHEDULE));
    // Nothing was written, what was typed is still there, and saving again is not offered.
    expect(other.description).toBe('Changed elsewhere');
    expect((dialog.getByLabelText('Description') as HTMLInputElement).value).toBe('My edit');
    expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await fireEvent.click(dialog.getByRole('button', { name: /Start over/ }));

    await waitFor(() =>
      expect((dialog.getByLabelText('Description') as HTMLInputElement).value).toBe(
        'Changed elsewhere',
      ),
    );
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(2));
    expect(stub?.callsTo('bureau.schedules.update').at(-1)?.params).toMatchObject({
      expectedRevision: 4,
    });
  });
});

describe('editing a code-defined schedule', () => {
  test('keeps the engine’s full drawer, and saves through the engine', async () => {
    open(`/schedules/${CODE_SCHEDULE}?edit=1`);
    const dialog = within(await drawer('Edit schedule'));
    await dialog.findByLabelText('Jitter');

    expect(
      dialog.getByLabelText('Backfill missed occurrences', { selector: '[role="switch"]' }),
    ).not.toBeNull();
    expect(dialog.getByRole('group', { name: /Which revision future occurrences/ })).not.toBeNull();
    const overlap = within(dialog.getByRole('group', { name: OVERLAP }));
    expect(overlap.getAllByRole('radio')).toHaveLength(4);

    await fireEvent.input(dialog.getByLabelText('Description'), { target: { value: 'Edited' } });
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('PATCH /schedules/:id').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')).toEqual([]);
  });
});

describe('editing a workflow file’s schedule', () => {
  test('has no form, because its cadence is the trigger in the workflow’s file, and links to the editor', async () => {
    open(`/schedules/${FILE_SCHEDULE}?edit=1`);
    const dialog = within(await drawer('Edit schedule'));

    const note = await dialog.findByTestId('schedule-edit-in-workflow');
    expect(note.textContent).toContain(SCHEDULE_COPY.editWorkflowNote);
    expect(dialog.queryByLabelText('Description')).toBeNull();
    expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await fireEvent.click(dialog.getByRole('link', { name: SCHEDULE_COPY.editWorkflowAction }));

    expect(router.pathname).toBe('/workflows/digest/edit');
  });
});

describe('creating a schedule', () => {
  test('asks what to start, and an agent run takes an agent, an input, an optional session, a cadence, a description, and an overlap policy', async () => {
    open('/schedules?create=1');
    const dialog = within(await drawer('Create schedule'));
    await fireEvent.click(
      await dialog.findByRole('radio', { name: SCHEDULE_COPY.form.startsAgent }),
    );

    const agent = await dialog.findByLabelText(SCHEDULE_COPY.form.agentLabel);
    expect([...(agent as HTMLSelectElement).options].map((option) => option.value)).toEqual([
      '',
      'tool-runner',
      'assistant',
    ]);
    expect(dialog.getByLabelText(SCHEDULE_COPY.form.inputLabel)).not.toBeNull();
    expect(dialog.getByLabelText(SCHEDULE_COPY.form.sessionLabel)).not.toBeNull();
    expect(dialog.getByLabelText(SCHEDULE_COPY.form.descriptionLabel)).not.toBeNull();
    expect(
      within(dialog.getByRole('group', { name: OVERLAP }))
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['skip', 'allow']);
    // The engine's workflow type, its id, and its input are not part of an agent run.
    expect(dialog.queryByLabelText('Workflow type')).toBeNull();
    expect(dialog.queryByLabelText('Schedule ID')).toBeNull();
  });

  test('creates an agent run through bureau.schedules.create, and opens it', async () => {
    open('/schedules?create=1');
    const dialog = within(await drawer('Create schedule'));
    await fireEvent.click(
      await dialog.findByRole('radio', { name: SCHEDULE_COPY.form.startsAgent }),
    );

    expect(dialog.getByRole('button', { name: 'Create schedule' })).toBeDisabled();
    await fireEvent.change(await dialog.findByLabelText(SCHEDULE_COPY.form.agentLabel), {
      target: { value: 'tool-runner' },
    });
    await fireEvent.input(dialog.getByLabelText(SCHEDULE_COPY.form.inputLabel), {
      target: { value: 'Summarize yesterday.' },
    });
    await fireEvent.input(dialog.getByLabelText(SCHEDULE_COPY.form.descriptionLabel), {
      target: { value: 'Nightly' },
    });
    await fireEvent.input(dialog.getByLabelText(SCHEDULE_COPY.form.sessionLabel), {
      target: { value: 'digest-session' },
    });
    await waitFor(() =>
      expect(dialog.getByRole('button', { name: 'Create schedule' })).not.toBeDisabled(),
    );
    await fireEvent.click(dialog.getByRole('button', { name: 'Create schedule' }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.create').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.create')[0]?.params).toEqual({
      agentName: 'tool-runner',
      spec: '1h',
      input: 'Summarize yesterday.',
      description: 'Nightly',
      sessionId: 'digest-session',
      overlap: 'skip',
    });
    // Nothing went to the engine's create.
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
    await waitFor(() => expect(router.pathname).toMatch(/^\/schedules\/schedule-created-/));
  });

  test('refuses an overlap of allow for a schedule that continues a session, before it asks the Bureau', async () => {
    open('/schedules?create=1');
    const dialog = within(await drawer('Create schedule'));
    await fireEvent.click(
      await dialog.findByRole('radio', { name: SCHEDULE_COPY.form.startsAgent }),
    );
    await fireEvent.change(await dialog.findByLabelText(SCHEDULE_COPY.form.agentLabel), {
      target: { value: 'tool-runner' },
    });
    await fireEvent.input(dialog.getByLabelText(SCHEDULE_COPY.form.inputLabel), {
      target: { value: 'Hello' },
    });
    await fireEvent.input(dialog.getByLabelText(SCHEDULE_COPY.form.sessionLabel), {
      target: { value: 'digest-session' },
    });
    await fireEvent.click(dialog.getByRole('radio', { name: /Allow/ }));

    await dialog.findByText(SCHEDULE_COPY.form.sessionWithAllow, { exact: false });
    expect(dialog.getByRole('button', { name: 'Create schedule' })).toBeDisabled();
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
  });

  test('says in the drawer what the Bureau refused', async () => {
    open('/schedules?create=1', {}, (installed) =>
      installed.on('bureau.schedules.create', () => {
        throw workflowFaults.invalidParams();
      }),
    );
    const dialog = within(await drawer('Create schedule'));
    await fireEvent.click(
      await dialog.findByRole('radio', { name: SCHEDULE_COPY.form.startsAgent }),
    );
    await fireEvent.change(await dialog.findByLabelText(SCHEDULE_COPY.form.agentLabel), {
      target: { value: 'tool-runner' },
    });
    await fireEvent.input(dialog.getByLabelText(SCHEDULE_COPY.form.inputLabel), {
      target: { value: 'Hello' },
    });

    await waitFor(() =>
      expect(dialog.getByRole('button', { name: 'Create schedule' })).not.toBeDisabled(),
    );
    await fireEvent.click(dialog.getByRole('button', { name: 'Create schedule' }));

    await dialog.findByText(/contains a dot/);
  });

  test('offers the code-defined workflow types, and leaves out the agent-authored ones and agentRun', async () => {
    open('/schedules?create=1');
    const dialog = within(await drawer('Create schedule'));

    // The typed name stands in until the registry answers, and then the list of types replaces it.
    const type = (await dialog.findByRole('combobox', {
      name: 'Workflow type',
    })) as HTMLSelectElement;
    const values = () => [...type.options].map((option) => option.value);
    // Both types the Bureau owns are in the registry, and neither is offered.
    await waitFor(() => expect(values()).toContain('order-processing'));
    expect(values()).toEqual(['', 'inventory-sync', 'order-processing']);
    // None of the types the Bureau's run engine registers is offered, whichever they are.
    for (const reserved of RUN_ENGINE_WORKFLOW_TYPES)
      expect(values(), reserved).not.toContain(reserved);
    expect(values()).not.toContain('agentRun');
    expect(values()).not.toContain('digest');
  });

  test('refuses a typed name that is agentRun or an agent-authored workflow, when the registry cannot be read', async () => {
    open('/schedules?create=1', {}, (installed) =>
      installed.on('weft.system.registry', () => {
        throw workflowFaults.unavailable();
      }),
    );
    const dialog = within(await drawer('Create schedule'));
    const type = await dialog.findByLabelText('Workflow type');
    await waitFor(() => expect(type.tagName).toBe('INPUT'));

    await fireEvent.input(type, { target: { value: 'digest' } });
    await dialog.findByText(SCHEDULE_COPY.form.reservedAgentAuthored, { exact: false });
    expect(dialog.getByRole('button', { name: 'Create schedule' })).toBeDisabled();

    await fireEvent.input(type, { target: { value: 'agentRun' } });
    await dialog.findByText(SCHEDULE_COPY.form.reservedAgentRun, { exact: false });
    expect(dialog.getByRole('button', { name: 'Create schedule' })).toBeDisabled();

    for (const reserved of RUN_ENGINE_WORKFLOW_TYPES.filter((type) => type !== 'agentRun')) {
      await fireEvent.input(type, { target: { value: reserved } });
      await dialog.findByText(SCHEDULE_COPY.form.reservedBureauWorkflow, { exact: false });
      expect(dialog.getByRole('button', { name: 'Create schedule' }), reserved).toBeDisabled();
    }

    await fireEvent.input(type, { target: { value: 'order-processing' } });
    await waitFor(() =>
      expect(dialog.getByRole('button', { name: 'Create schedule' })).not.toBeDisabled(),
    );
  });

  test('creates a code-defined workflow’s schedule through the engine', async () => {
    open('/schedules?create=1');
    const dialog = within(await drawer('Create schedule'));
    const type = (await dialog.findByRole('combobox', {
      name: 'Workflow type',
    })) as HTMLSelectElement;

    // The first type is the one chosen, as for the agent above.
    await fireEvent.change(type, { target: { value: 'inventory-sync' } });
    await fireEvent.click(dialog.getByRole('button', { name: 'Create schedule' }));

    await waitFor(() => expect(stub?.callsTo('POST /schedules').length).toBe(1));
    expect(stub?.callsTo('POST /schedules')[0]?.params).toMatchObject({ type: 'inventory-sync' });
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
  });

  test('does not offer a workflow type until the Bureau has said which are agent-authored', async () => {
    open('/schedules?create=1', { failBureauFiles: true });
    const dialog = within(await drawer('Create schedule'));

    await dialog.findByText(SCHEDULE_COPY.overlayFailed.title, { exact: false });
    expect(dialog.getByRole('button', { name: 'Create schedule' })).toBeDisabled();
  });
});

describe('the drawers when something is not as it was', () => {
  test('a new agent run takes a typed agent name when the Bureau cannot list the agents', async () => {
    open('/schedules?create=1', {}, (installed) =>
      installed.on('bureau.agents.list', () => {
        throw workflowFaults.unavailable();
      }),
    );
    const dialog = within(await drawer('Create schedule'));
    await fireEvent.click(
      await dialog.findByRole('radio', { name: SCHEDULE_COPY.form.startsAgent }),
    );

    const agent = await dialog.findByLabelText(SCHEDULE_COPY.form.agentLabel);
    await waitFor(() => expect(agent.tagName).toBe('INPUT'));
    await fireEvent.input(agent, { target: { value: 'assistant' } });
    await fireEvent.input(dialog.getByLabelText(SCHEDULE_COPY.form.inputLabel), {
      target: { value: 'Hello' },
    });
    await fireEvent.click(dialog.getByRole('button', { name: 'Create schedule' }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.create').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.create')[0]?.params).toMatchObject({
      agentName: 'assistant',
    });
  });

  test('says there are no agents when the Bureau lists none', async () => {
    open('/schedules?create=1', { agents: [] });
    const dialog = within(await drawer('Create schedule'));
    await fireEvent.click(
      await dialog.findByRole('radio', { name: SCHEDULE_COPY.form.startsAgent }),
    );

    await dialog.findByText(SCHEDULE_COPY.form.noAgents, { exact: false });
  });

  test('closes with Cancel, and creates nothing', async () => {
    open('/schedules?create=1');
    const dialog = within(await drawer('Create schedule'));

    await fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(router.search.get('create')).toBeNull());
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
  });

  test('an edit says so when the Bureau has not said what the schedule is, and offers nothing', async () => {
    // A workflow file's schedule: only the Bureau says whose it is, and it did not answer.
    open(`/schedules/${FILE_SCHEDULE}?edit=1`, {
      failBureauSchedules: true,
      failBureauFiles: true,
    });
    const dialog = within(await drawer('Edit schedule'));

    await dialog.findByText(SCHEDULE_COPY.overlayFailed.title, { exact: false });
    expect(dialog.queryByLabelText('Description')).toBeNull();
  });

  test('an edit of a schedule that is not there says so', async () => {
    open('/schedules/no-such-schedule?edit=1');
    const dialog = within(await drawer('Edit schedule'));

    await dialog.findByText(/No schedule with id "no-such-schedule" exists/);
  });

  test('a code-defined schedule on an interval is edited and saved as an interval', async () => {
    // A schedule on an interval has no cron expression.
    const hourly = scheduleFixture('every-hour', 'order-processing', {
      intervalMs: 3_600_000,
      revision: 2,
      description: 'Hourly',
    });
    delete hourly.cronExpression;
    open(`/schedules/every-hour?edit=1`, { schedules: [hourly] });
    const dialog = within(await drawer('Edit schedule'));
    const description = await dialog.findByLabelText('Description');

    await fireEvent.input(description, { target: { value: 'Hourly, edited' } });
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('PATCH /schedules/:id body').length).toBe(1));
    expect(stub?.callsTo('PATCH /schedules/:id body')[0]?.params).toMatchObject({
      every: 3_600_000,
      description: 'Hourly, edited',
    });
  });

  test('an agent run’s cadence can be changed to an interval, which is sent as a duration', async () => {
    open(`/schedules/${AGENT_SCHEDULE}?edit=1`);
    const dialog = within(await drawer('Edit schedule'));
    await dialog.findByLabelText('Description');

    await fireEvent.click(dialog.getByRole('tab', { name: 'Interval' }));
    const every = dialog.getByLabelText('Every');
    await fireEvent.input(every, { target: { value: '20' } });
    await fireEvent.change(every, { target: { value: '20' } });
    await fireEvent.blur(every);
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params['spec']).toBe('20m');
  });

  test('a new agent run’s cadence can be a cron expression, which is sent as written', async () => {
    open('/schedules?create=1');
    const dialog = within(await drawer('Create schedule'));
    await fireEvent.click(
      await dialog.findByRole('radio', { name: SCHEDULE_COPY.form.startsAgent }),
    );
    await fireEvent.change(await dialog.findByLabelText(SCHEDULE_COPY.form.agentLabel), {
      target: { value: 'tool-runner' },
    });
    await fireEvent.input(dialog.getByLabelText(SCHEDULE_COPY.form.inputLabel), {
      target: { value: 'Hello' },
    });

    await fireEvent.click(dialog.getByRole('tab', { name: 'Cron' }));
    // The minute field's raw expression, which the cadence follows.
    const minute = document.querySelector('[id$="cron-field-0-raw"]');
    if (!(minute instanceof HTMLInputElement)) throw new Error('expected the minute field');
    await fireEvent.input(minute, { target: { value: '30' } });
    await fireEvent.click(dialog.getByRole('button', { name: 'Create schedule' }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.create').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.create')[0]?.params['spec']).toMatch(/^30 /);
  });
});

describe('a description that is too long', () => {
  const TOO_LONG = 'x'.repeat(2_001);

  test('says why Save is disabled when an agent run is edited, and is saved once it is short enough', async () => {
    open(`/schedules/${AGENT_SCHEDULE}?edit=1`);
    const dialog = within(await drawer('Edit schedule'));
    const description = await dialog.findByLabelText('Description');

    await fireEvent.input(description, { target: { value: TOO_LONG } });

    await dialog.findByText(SCHEDULE_COPY.form.descriptionTooLong(2_000), { exact: false });
    expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await fireEvent.input(description, { target: { value: 'x'.repeat(2_000) } });
    await waitFor(() =>
      expect(dialog.getByRole('button', { name: 'Save changes' })).not.toBeDisabled(),
    );
  });

  test('says so when a new agent run is created, too', async () => {
    open('/schedules?create=1');
    const dialog = within(await drawer('Create schedule'));
    await fireEvent.click(
      await dialog.findByRole('radio', { name: SCHEDULE_COPY.form.startsAgent }),
    );
    await fireEvent.change(await dialog.findByLabelText(SCHEDULE_COPY.form.agentLabel), {
      target: { value: 'tool-runner' },
    });
    await fireEvent.input(dialog.getByLabelText(SCHEDULE_COPY.form.inputLabel), {
      target: { value: 'Hello' },
    });

    await fireEvent.input(dialog.getByLabelText(SCHEDULE_COPY.form.descriptionLabel), {
      target: { value: TOO_LONG },
    });

    await dialog.findByText(SCHEDULE_COPY.form.descriptionTooLong(2_000), { exact: false });
    expect(dialog.getByRole('button', { name: 'Create schedule' })).toBeDisabled();
  });
});
