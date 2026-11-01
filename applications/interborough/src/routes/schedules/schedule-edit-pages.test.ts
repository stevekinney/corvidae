/**
 * COR-1494: what the edit page offers for each kind of schedule.
 *
 * - Editing an agent run offers exactly the cadence, the description, and the overlap policy
 *   (`skip` or `allow`), which are the fields `bureau.schedules.update` takes. A code-defined
 *   schedule keeps the engine's full page. A workflow file's schedule has no form, because its
 *   cadence is the trigger in the file.
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
async function drawer(name: 'Edit schedule') {
  const view = within(document.body);
  await view.findByRole('heading', { level: 1, name });
  return requireElement(document.querySelector('[data-page="schedule-edit"]'), HTMLElement);
}

const OVERLAP = 'If a run is still going when the next fire is due';

/** The checkbox that skips a fire while the previous run is still going. */
const SKIP = SCHEDULE_COPY.form.skipOverlapLabel;

describe('editing an agent run', () => {
  test('offers exactly the cadence, the description, and whether a fire is skipped while a run is going', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const dialog = within(await drawer('Edit schedule'));
    await dialog.findByLabelText('Description');

    expect((dialog.getByLabelText('Description') as HTMLInputElement).value).toBe('Daily summary');
    // The cadence is the schedule builder's, and the overlap policy is the one choice the Bureau
    // offers, to skip a fire or to allow it, as a checkbox.
    expect(dialog.getByLabelText('Repeats')).not.toBeNull();
    expect(dialog.getByRole('combobox', { name: 'Time zone' })).not.toBeNull();
    expect((dialog.getByLabelText(SKIP) as HTMLInputElement).checked).toBe(true);
    expect(dialog.queryByRole('group', { name: OVERLAP })).toBeNull();
    // Everything else the engine's drawer has is left out: none of it is a field of the update.
    for (const label of [
      'Jitter',
      'Backfill missed occurrences',
      'Start paused',
      'Workflow type',
      'Schedule ID',
      SCHEDULE_COPY.form.inputLabel,
      'Agent',
      'Session',
    ]) {
      expect(dialog.queryByLabelText(label), label).toBeNull();
    }
    expect(dialog.queryByRole('group', { name: /Which revision future occurrences/ })).toBeNull();
    expect(dialog.queryByRole('radio', { name: /Queue/ })).toBeNull();
  });

  test('saves through bureau.schedules.update, with the cadence and the revision the page read', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const dialog = within(await drawer('Edit schedule'));
    const description = await dialog.findByLabelText('Description');

    await fireEvent.input(description, { target: { value: 'Morning summary' } });
    await fireEvent.click(dialog.getByLabelText(SKIP));
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
    expect(stub?.callsTo('PATCH /schedules/:schedule')).toEqual([]);
    // The drawer closed, back to the schedule's page.
    await waitFor(() => expect(router.search.get('edit')).toBeNull());
    expect(router.pathname).toBe(`/schedules/${AGENT_SCHEDULE}`);
  });

  test('sends only the cadence when nothing else changed', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
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
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
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
    open(`/schedules/${CODE_SCHEDULE}/edit`);
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

    await waitFor(() => expect(stub?.callsTo('PATCH /schedules/:schedule').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')).toEqual([]);
  });
});

describe('editing a workflow file’s schedule', () => {
  test('has no form, because its cadence is the trigger in the workflow’s file, and links to the editor', async () => {
    open(`/schedules/${FILE_SCHEDULE}/edit`);
    const dialog = within(await drawer('Edit schedule'));

    const note = await dialog.findByTestId('schedule-edit-in-workflow');
    expect(note.textContent).toContain(SCHEDULE_COPY.editWorkflowNote);
    expect(dialog.queryByLabelText('Description')).toBeNull();
    expect(dialog.queryByRole('button', { name: 'Save changes' })).toBeNull();
    await fireEvent.click(dialog.getByRole('link', { name: SCHEDULE_COPY.editWorkflowAction }));

    expect(router.pathname).toBe('/workflows/digest/edit');
  });
});

describe('the edit pages when something is not as it was', () => {
  test('an edit says so when the Bureau has not said what the schedule is, and offers nothing', async () => {
    // A workflow file's schedule: only the Bureau says whose it is, and it did not answer.
    open(`/schedules/${FILE_SCHEDULE}/edit`, {
      failBureauSchedules: true,
      failBureauFiles: true,
    });
    const dialog = within(await drawer('Edit schedule'));

    await dialog.findByText(SCHEDULE_COPY.overlayFailed.title, { exact: false });
    expect(dialog.queryByLabelText('Description')).toBeNull();
  });

  test('an edit of a schedule that is not there says so', async () => {
    open('/schedules/no-such-schedule/edit');
    const dialog = within(await drawer('Edit schedule'));

    await dialog.findByText(SCHEDULE_COPY.detail.notFound.description);
  });

  test('a code-defined schedule on an interval is edited and saved as an interval', async () => {
    // A schedule on an interval has no cron expression.
    const hourly = scheduleFixture('every-hour', 'order-processing', {
      intervalMs: 3_600_000,
      revision: 2,
      description: 'Hourly',
    });
    delete hourly.cronExpression;
    open(`/schedules/every-hour/edit`, { schedules: [hourly] });
    const dialog = within(await drawer('Edit schedule'));
    const description = await dialog.findByLabelText('Description');

    await fireEvent.input(description, { target: { value: 'Hourly, edited' } });
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('PATCH /schedules/:schedule body').length).toBe(1));
    expect(stub?.callsTo('PATCH /schedules/:schedule body')[0]?.params).toMatchObject({
      every: 3_600_000,
      description: 'Hourly, edited',
    });
  });

  test('an agent run’s cadence can be changed to an interval, which is sent as a duration', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const dialog = within(await drawer('Edit schedule'));
    await dialog.findByLabelText('Description');

    await fireEvent.change(await dialog.findByLabelText('Repeats'), {
      target: { value: 'interval' },
    });
    await fireEvent.change(dialog.getByLabelText('Unit'), { target: { value: 'minutes' } });
    const every = dialog.getByLabelText('Every');
    await fireEvent.input(every, { target: { value: '20' } });
    await fireEvent.change(every, { target: { value: '20' } });
    await fireEvent.blur(every);
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params['spec']).toBe('20m');
  });

  test('an agent run is not saved while the cadence builder shows a field out of range', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const dialog = within(await drawer('Edit schedule'));
    await dialog.findByLabelText('Description');

    await fireEvent.change(await dialog.findByLabelText('Repeats'), { target: { value: 'cron' } });
    await fireEvent.input(dialog.getByLabelText('Hour'), { target: { value: '99' } });
    // The builder keeps the last cadence it emitted, so the draft is still valid and Save is on.
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await dialog.findByText(SCHEDULE_COPY.edit.invalidCadence);
    expect(stub?.callsTo('bureau.schedules.update')).toEqual([]);
    expect(router.pathname).toBe(`/schedules/${AGENT_SCHEDULE}/edit`);
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

  test('an agent run shows its cadence as it is, and an edit of only the description sends it exactly', async () => {
    open(`/schedules/${SECONDS_AGENT}/edit`, secondsWorld());
    const dialog = within(await drawer('Edit schedule'));
    const description = await dialog.findByLabelText('Description');

    const cadence = dialog.getByLabelText(SCHEDULE_COPY.form.cadenceLabel);
    expect(cadence).toBeDisabled();
    expect((cadence as HTMLInputElement).value).toBe('Every 30 seconds');
    expect(dialog.queryByLabelText('Repeats')).toBeNull();

    await fireEvent.input(description, { target: { value: 'Still thirty seconds' } });
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params).toEqual({
      scheduleId: SECONDS_AGENT,
      spec: '30s',
      description: 'Still thirty seconds',
      expectedRevision: 2,
    });
  });

  test('a code-defined schedule does the same, and sends every as milliseconds', async () => {
    open(`/schedules/${SECONDS_CODE}/edit`, secondsWorld());
    const dialog = within(await drawer('Edit schedule'));
    const description = await dialog.findByLabelText('Description');

    const cadence = dialog.getByLabelText(SCHEDULE_COPY.form.cadenceLabel);
    expect(cadence).toBeDisabled();
    expect((cadence as HTMLInputElement).value).toBe('Every 90 seconds');
    await fireEvent.input(description, { target: { value: 'Still ninety seconds' } });
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('PATCH /schedules/:schedule body').length).toBe(1));
    const body = stub?.callsTo('PATCH /schedules/:schedule body')[0]?.params;
    expect(body).toMatchObject({ every: 90_000, description: 'Still ninety seconds' });
    expect(body).not.toHaveProperty('cronExpression');
  });

  test('an edit that sends only a cadence of 30s sends every: 30000 to the engine', async () => {
    const code = scheduleFixture('thirty-seconds-code', 'order-processing', {
      intervalMs: 30_000,
      revision: 1,
    });
    delete code.cronExpression;
    open(`/schedules/thirty-seconds-code/edit`, { schedules: [code] });
    const dialog = within(await drawer('Edit schedule'));
    await dialog.findByLabelText('Description');
    await fireEvent.click(dialog.getByRole('switch', { name: 'Backfill missed occurrences' }));
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('PATCH /schedules/:schedule body').length).toBe(1));
    expect(stub?.callsTo('PATCH /schedules/:schedule body')[0]?.params).toMatchObject({
      every: 30_000,
    });
  });

  test('Change cadence brings back the builder, and a cadence chosen in it is sent instead', async () => {
    open(`/schedules/${SECONDS_AGENT}/edit`, secondsWorld());
    const dialog = within(await drawer('Edit schedule'));
    await dialog.findByLabelText('Description');
    expect(dialog.queryByLabelText('Repeats')).toBeNull();

    await fireEvent.click(
      dialog.getByRole('button', { name: SCHEDULE_COPY.form.changeCadenceAction }),
    );

    await fireEvent.change(await dialog.findByLabelText('Repeats'), {
      target: { value: 'interval' },
    });
    await fireEvent.change(dialog.getByLabelText('Unit'), { target: { value: 'minutes' } });
    const every = dialog.getByLabelText('Every');
    await fireEvent.input(every, { target: { value: '20' } });
    await fireEvent.change(every, { target: { value: '20' } });
    await fireEvent.blur(every);
    expect(document.getElementById('weft-agent-schedule-exact-cadence')).toBeNull();
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.update').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.update')[0]?.params['spec']).toBe('20m');
  });

  test('a whole-minute cadence still opens in the builder', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
    const dialog = within(await drawer('Edit schedule'));
    await dialog.findByLabelText('Description');

    expect(dialog.getByLabelText('Repeats')).not.toBeNull();
    expect(
      dialog.queryByRole('button', { name: SCHEDULE_COPY.form.changeCadenceAction }),
    ).toBeNull();
  });
});

describe('a description that is too long', () => {
  const TOO_LONG = 'x'.repeat(2_001);

  test('says why Save is disabled when an agent run is edited, and is saved once it is short enough', async () => {
    open(`/schedules/${AGENT_SCHEDULE}/edit`);
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
});

describe('a code-defined schedule’s cadence changed in the builder', () => {
  test('sends the cadence chosen in the builder, not the stored one', async () => {
    open(`/schedules/${CODE_SCHEDULE}/edit`);
    const dialog = within(await drawer('Edit schedule'));
    await dialog.findByLabelText('Description');

    await fireEvent.change(await dialog.findByLabelText('Repeats'), {
      target: { value: 'interval' },
    });
    await fireEvent.change(dialog.getByLabelText('Unit'), { target: { value: 'minutes' } });
    const every = dialog.getByLabelText('Every');
    await fireEvent.input(every, { target: { value: '20' } });
    await fireEvent.change(every, { target: { value: '20' } });
    await fireEvent.blur(every);
    await fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(stub?.callsTo('PATCH /schedules/:schedule body').length).toBe(1));
    const body = stub?.callsTo('PATCH /schedules/:schedule body')[0]?.params;
    expect(body).toMatchObject({ every: 1_200_000 });
    expect(body).not.toHaveProperty('cronExpression');
  });
});
