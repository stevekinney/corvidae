/**
 * `/schedules/new`: the page that makes a schedule. A workflow is chosen from a searchable picker
 * grouped Built in, Recent and All workflows; only the built-in chat asks for an agent, a message
 * and a chat to continue; any other workflow asks for its own input; and When is the block the run
 * setup page shares. Plain Enter never makes a schedule, a cadence field that is out of range
 * refuses the save, and a cron schedule is made in the zone that was chosen.
 *
 * Driven against `installWorkflowWorld`, as `schedule-edit-pages.test.ts` is.
 */
import { RUN_ENGINE_WORKFLOW_TYPES } from '@lostgradient/operative/run-engine-workflow-types';
import { quietFor } from '@lostgradient/testing/wait-until';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { SCHEDULE_COPY } from '../../app/copy.ts';
import { contextFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type AuthorizationScope } from '../../lib/scopes.svelte.ts';
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

const COPY = SCHEDULE_COPY.create;

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

const AGENTS = ['tool-runner', 'assistant'].map((name) => ({
  name,
  displayName: name,
  description: null,
  definitionRevision: 1,
  kind: 'code',
  a2a: false,
}));

const ORDER_SCHEMA = {
  type: 'object',
  properties: { orderId: { type: 'string', title: 'Order id', minLength: 3 } },
  required: ['orderId'],
};

function world(overrides: Partial<World> = {}): World {
  return emptyWorld({
    definitions: [
      codeDefinition('order-processing', {
        contract: { name: 'order-processing', inputSchema: ORDER_SCHEMA },
      }),
      codeDefinition('inventory-sync-sweep', {
        description: 'Counts the stock of every warehouse.',
        contract: { name: 'inventory-sync-sweep', workflowVersion: '1.0.0' },
      }),
      // Every type the Bureau's run engine registers is in the registry of a host whose console is the Bureau's.
      ...RUN_ENGINE_WORKFLOW_TYPES.map((type) => codeDefinition(type)),
      sourceDefinition('digest'),
    ],
    files: [readyFile('digest')],
    agents: AGENTS,
    contexts: [
      contextFixture('chat-1', { title: 'Weekly numbers', agentName: 'assistant' }),
      contextFixture('chat-2', { title: null, lastMessagePreview: 'Look at churn' }),
    ],
    ...overrides,
  });
}

/** `before` changes how the services answer, ahead of the first request the page makes. */
function open(
  overrides: Partial<World> = {},
  before: (installed: WorkflowStub) => void = () => undefined,
  scopes: readonly AuthorizationScope[] = AUTHORIZATION_SCOPES,
) {
  stub = installWorkflowWorld(world(overrides));
  before(stub);
  router.navigate('/schedules/new', { replace: true });
  return render(IndexHarness, { props: { client: stub.client, externalBureau: true, scopes } });
}

const view = () => within(document.body);
const create = () => view().getByRole('button', { name: COPY.submit });

/** Types into a picker and chooses the option with that text, as a person does. */
async function choose(label: string, query: string, optionText: string): Promise<void> {
  const input = await view().findByRole('combobox', { name: new RegExp(`^${label}`) });
  await fireEvent.input(input, { target: { value: query } });
  await fireEvent.focus(input);
  const listbox = await view().findByRole('listbox');
  const option = [...listbox.querySelectorAll('[role="option"]')].find((entry) =>
    (entry.textContent ?? '').includes(optionText),
  );
  if (option === undefined) throw new Error(`Expected ${optionText} to be offered.`);
  await fireEvent.mouseDown(option);
}

/** The labels of the options the picker lists now, by the group heading above each. */
function listed(): { group: string; labels: string[] }[] {
  const listbox = document.querySelector('[role="listbox"]');
  if (listbox === null) throw new Error('Expected the picker to be open.');
  const groups: { group: string; labels: string[] }[] = [];
  let current: { group: string; labels: string[] } = { group: '', labels: [] };
  groups.push(current);
  for (const node of listbox.querySelectorAll('.cinder-_option-group__label, [role="option"]')) {
    if (node.getAttribute('role') === 'option') {
      current.labels.push(
        node.querySelector('.cinder-combobox__option-label')?.textContent?.trim() ??
          node.textContent?.trim() ??
          '',
      );
    } else {
      current = { group: node.textContent?.trim() ?? '', labels: [] };
      groups.push(current);
    }
  }
  return groups.filter((entry) => entry.labels.length > 0);
}

/** The options of the open picker, and not the native selects of the page. */
function pickerOptions(): HTMLElement[] {
  return within(view().getByRole('listbox')).queryAllByRole('option');
}

async function openPicker(): Promise<void> {
  const input = await view().findByRole('combobox', { name: /^Workflow/ });
  await fireEvent.focus(input);
  await view().findByRole('listbox');
}

/** Sets the cadence to every 20 minutes, which is an interval and so is read in no zone. */
async function everyTwentyMinutes(): Promise<void> {
  await fireEvent.change(await view().findByLabelText('Repeats'), {
    target: { value: 'interval' },
  });
  await fireEvent.change(view().getByLabelText('Unit'), { target: { value: 'minutes' } });
  const every = view().getByLabelText('Every');
  await fireEvent.input(every, { target: { value: '20' } });
  await fireEvent.change(every, { target: { value: '20' } });
  await fireEvent.blur(every);
}

describe('the page', () => {
  test('opens on the picker with nothing chosen, and names the three sections', async () => {
    open();
    await view().findByRole('heading', { level: 1, name: COPY.title });
    const headings = [...document.querySelectorAll('[data-page="schedule-new"] h2')].map(
      (heading) => heading.textContent?.trim(),
    );
    expect(headings).toEqual([COPY.workflowHeading, COPY.whenHeading, COPY.optionsHeading]);
    expect(view().queryByTestId('new-schedule-chat-input')).toBeNull();
    expect(view().queryByTestId('new-schedule-workflow-input')).toBeNull();
    expect(create()).toBeDisabled();
    expect(view().getByTestId('new-schedule-summary').textContent).toBe(COPY.summaryNothing);
  });

  test('groups the picker: the chat built in, then the workflows code defines, with an agent-authored one listed but not chosen', async () => {
    open();
    await openPicker();
    await waitFor(() => expect(listed().map((entry) => entry.group)).toContain(COPY.groups.all));
    expect(listed()).toEqual([
      { group: COPY.groups.builtIn, labels: [COPY.chat.label] },
      { group: COPY.groups.all, labels: ['Digest', 'Inventory Sync Sweep', 'Order Processing'] },
    ]);
    // The types the Bureau runs for itself are not offered, and the file's own schedule is the trigger in its file.
    const digest = pickerOptions().find((option) => (option.textContent ?? '').includes('Digest'));
    expect(digest?.getAttribute('aria-disabled')).toBe('true');
    expect(digest?.textContent).toContain(COPY.inFile);
  });

  test('puts the workflows the newest schedules start under Recent, once each', async () => {
    open({
      schedules: [
        scheduleFixture('old', 'order-processing', { createdAt: 1_000 }),
        scheduleFixture('new', 'inventory-sync-sweep', { createdAt: 3_000 }),
        scheduleFixture('newer', 'inventory-sync-sweep', { createdAt: 4_000 }),
      ],
    });
    await openPicker();
    await waitFor(() => expect(listed().map((entry) => entry.group)).toContain(COPY.groups.recent));
    expect(listed()).toEqual([
      { group: COPY.groups.builtIn, labels: [COPY.chat.label] },
      { group: COPY.groups.recent, labels: ['Inventory Sync Sweep', 'Order Processing'] },
      { group: COPY.groups.all, labels: ['Digest'] },
    ]);
  });

  test('filters by typing, by the words, the identifier or the description, and offers to create a workflow when nothing matches', async () => {
    open();
    const input = await view().findByRole('combobox', { name: /^Workflow/ });
    await fireEvent.focus(input);
    await waitFor(() => expect(pickerOptions().length).toBeGreaterThan(1));

    await fireEvent.input(input, { target: { value: 'warehouse' } });
    await waitFor(() => expect(pickerOptions()).toHaveLength(1));
    expect(pickerOptions()[0]?.textContent).toContain('Inventory Sync Sweep');

    await fireEvent.input(input, { target: { value: 'nothing like this' } });
    const none = await view().findByTestId('new-schedule-no-match');
    expect(none.textContent).toContain(COPY.noMatch);
    await fireEvent.click(within(none).getByRole('link', { name: COPY.createOne }));
    expect(router.pathname).toBe('/workflows/new');
  });

  test('says the workflows could not be listed, and still offers the chat', async () => {
    open({}, (installed) =>
      installed.on('weft.workflows.definitions.list', () => {
        throw workflowFaults.unavailable();
      }),
    );
    const alert = await view().findByTestId('new-schedule-catalog-failed');
    expect(alert.textContent).toContain(COPY.catalogFailed.title);
    await choose('Workflow', 'chat', COPY.chat.label);
    await view().findByTestId('new-schedule-chat-input');
  });

  test('Cancel leaves for the list and makes nothing', async () => {
    open();
    await fireEvent.click(await view().findByRole('link', { name: COPY.cancel }));
    expect(router.pathname).toBe('/schedules');
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
  });

  test('refuses a caller who may not write schedules, with the reason', async () => {
    open(
      {},
      () => undefined,
      AUTHORIZATION_SCOPES.filter((scope) => scope !== 'schedules:write'),
    );
    await choose('Workflow', 'chat', COPY.chat.label);
    await view().findByTestId('new-schedule-chat-input');
    expect(create()).toBeDisabled();
    expect(create().getAttribute('title')).toBeTruthy();
  });
});

describe('Chat with an agent', () => {
  /** Chooses the chat, an agent and a message, which is all it takes. */
  async function fillChat(message = 'Summarize yesterday.'): Promise<void> {
    await choose('Workflow', 'chat', COPY.chat.label);
    await fireEvent.change(
      await view().findByLabelText(new RegExp(`^${SCHEDULE_COPY.form.agentLabel}`)),
      {
        target: { value: 'tool-runner' },
      },
    );
    await fireEvent.input(view().getByLabelText(new RegExp(`^${SCHEDULE_COPY.form.inputLabel}`)), {
      target: { value: message },
    });
  }

  test('asks for an agent, a message and a chat to continue, and not for an input schema', async () => {
    open();
    await choose('Workflow', 'chat', COPY.chat.label);
    await view().findByTestId('new-schedule-chat-input');
    const agent = await view().findByLabelText(new RegExp(`^${SCHEDULE_COPY.form.agentLabel}`));
    expect([...(agent as HTMLSelectElement).options].map((option) => option.value)).toEqual([
      '',
      'tool-runner',
      'assistant',
    ]);
    expect(view().getByLabelText(new RegExp(`^${SCHEDULE_COPY.form.inputLabel}`))).not.toBeNull();
    expect(await view().findByRole('combobox', { name: COPY.chatLabel })).not.toBeNull();
    // Nothing asks for a raw session identifier, and a code-defined workflow's fields are not there.
    expect(view().queryByLabelText(/session/i)).toBeNull();
    expect(view().queryByLabelText('Jitter')).toBeNull();
    expect(view().queryByTestId('new-schedule-workflow-input')).toBeNull();
  });

  test('makes the schedule through the Bureau, with the zone it was read in, and opens it', async () => {
    open();
    await fillChat();
    await fireEvent.input(view().getByLabelText(COPY.descriptionLabel), {
      target: { value: 'Nightly' },
    });
    await waitFor(() => expect(create()).not.toBeDisabled());
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.create').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.create')[0]?.params).toMatchObject({
      agentName: 'tool-runner',
      spec: '0 9 * * *',
      input: 'Summarize yesterday.',
      description: 'Nightly',
      overlap: 'skip',
      timeZone: expect.any(String),
    });
    // Nothing went to the engine's create.
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
    await waitFor(() => expect(router.pathname).toMatch(/^\/schedules\/schedule-created-/));
  });

  test('sends an interval as a duration, in no zone', async () => {
    open();
    await fillChat();
    await everyTwentyMinutes();
    await waitFor(() => expect(create()).not.toBeDisabled());
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.create').length).toBe(1));
    const params = stub?.callsTo('bureau.schedules.create')[0]?.params;
    expect(params).toMatchObject({ spec: '20m' });
    expect(params).not.toHaveProperty('timeZone');
  });

  test('continues the chat that was picked, and takes that chat’s agent', async () => {
    open();
    await choose('Workflow', 'chat', COPY.chat.label);
    await choose(COPY.chatLabel, 'weekly', 'Weekly numbers');
    await fireEvent.input(view().getByLabelText(new RegExp(`^${SCHEDULE_COPY.form.inputLabel}`)), {
      target: { value: 'And now?' },
    });

    const agent = (await view().findByLabelText(
      new RegExp(`^${SCHEDULE_COPY.form.agentLabel}`),
    )) as HTMLSelectElement;
    await waitFor(() => expect(agent.value).toBe('assistant'));
    expect(agent.disabled).toBe(true);
    await waitFor(() => expect(create()).not.toBeDisabled());
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.create').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.create')[0]?.params).toMatchObject({
      agentName: 'assistant',
      sessionId: 'chat-1',
    });
  });

  test('can stop continuing a chat, which frees the agent', async () => {
    open();
    await choose('Workflow', 'chat', COPY.chat.label);
    await choose(COPY.chatLabel, 'weekly', 'Weekly numbers');
    await fireEvent.click(await view().findByRole('button', { name: COPY.chatClear }));

    const agent = (await view().findByLabelText(
      new RegExp(`^${SCHEDULE_COPY.form.agentLabel}`),
    )) as HTMLSelectElement;
    expect(agent.disabled).toBe(false);
    expect(view().queryByRole('button', { name: COPY.chatClear })).toBeNull();
  });

  test('refuses an overlap of allow for a schedule that continues a chat, before it asks the Bureau', async () => {
    open();
    await fillChat('Hello');
    await choose(COPY.chatLabel, 'weekly', 'Weekly numbers');
    await fireEvent.click(view().getByLabelText(SCHEDULE_COPY.form.skipOverlapLabel));

    await view().findByText(SCHEDULE_COPY.form.sessionWithAllow, { exact: false });
    expect(create()).toBeDisabled();
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
  });

  test('says what the Bureau refused, and keeps what was typed', async () => {
    open({}, (installed) =>
      installed.on('bureau.schedules.create', () => {
        throw workflowFaults.invalidParams();
      }),
    );
    await fillChat('Keep me');
    await waitFor(() => expect(create()).not.toBeDisabled());
    await fireEvent.click(create());

    await view().findByText(/contains a dot/);
    expect(
      (
        view().getByLabelText(
          new RegExp(`^${SCHEDULE_COPY.form.inputLabel}`),
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('Keep me');
    expect(router.pathname).toBe('/schedules/new');
  });

  test('says the schedule may exist when the answer was lost, and asks again only when told to', async () => {
    open({}, (installed) =>
      installed.on('bureau.schedules.create', () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await fillChat();
    await waitFor(() => expect(create()).not.toBeDisabled());
    await fireEvent.click(create());

    const lost = await view().findByTestId('new-schedule-maybe-made');
    expect(lost.textContent).toContain(SCHEDULE_COPY.lost.title);
    expect(within(lost).getByRole('link', { name: SCHEDULE_COPY.lost.check })).not.toBeNull();
    expect(router.pathname).toBe('/schedules/new');
  });

  test('takes a typed agent name when the Bureau cannot list the agents', async () => {
    open({}, (installed) =>
      installed.on('bureau.agents.list', () => {
        throw workflowFaults.unavailable();
      }),
    );
    await choose('Workflow', 'chat', COPY.chat.label);
    const agent = await view().findByLabelText(new RegExp(`^${SCHEDULE_COPY.form.agentLabel}`));
    await waitFor(() => expect(agent.tagName).toBe('INPUT'));
    await fireEvent.input(agent, { target: { value: 'assistant' } });
    await fireEvent.input(view().getByLabelText(new RegExp(`^${SCHEDULE_COPY.form.inputLabel}`)), {
      target: { value: 'Hello' },
    });
    await waitFor(() => expect(create()).not.toBeDisabled());
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.create').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.create')[0]?.params).toMatchObject({
      agentName: 'assistant',
    });
  });

  test('says there are no agents when the Bureau lists none, with a way to make one', async () => {
    open({ agents: [] });
    await choose('Workflow', 'chat', COPY.chat.label);
    await view().findByText(COPY.noAgents.title);
    await fireEvent.click(view().getByRole('link', { name: COPY.noAgents.action }));
    expect(router.pathname).toBe('/agents/new');
  });

  test('starts a new chat each run when the Bureau cannot list the chats', async () => {
    open({ failContexts: true });
    await fillChat();
    const picker = await view().findByRole('combobox', { name: COPY.chatLabel });
    expect((picker as HTMLInputElement).disabled).toBe(true);
    await view().findByText(COPY.chatUnavailable);
    await waitFor(() => expect(create()).not.toBeDisabled());
  });

  test('says a description that is too long is, and is created once it is short enough', async () => {
    open();
    await fillChat();
    const description = view().getByLabelText(COPY.descriptionLabel);
    await fireEvent.input(description, { target: { value: 'x'.repeat(2_001) } });
    await view().findByText(SCHEDULE_COPY.form.descriptionTooLong(2_000), { exact: false });
    expect(create()).toBeDisabled();
    await fireEvent.input(description, { target: { value: 'x'.repeat(2_000) } });
    await waitFor(() => expect(create()).not.toBeDisabled());
  });
});

describe('a workflow', () => {
  async function chooseOrder(): Promise<void> {
    await choose('Workflow', 'order', 'Order Processing');
    await view().findByTestId('new-schedule-input');
  }

  const orderField = () => view().getByLabelText(/^Order id/);

  test('shows the chosen workflow’s description, and asks for its input from its schema, not for an agent', async () => {
    open();
    await choose('Workflow', 'inventory', 'Inventory Sync Sweep');
    const described = await view().findByTestId('new-schedule-workflow-description');
    expect(described.textContent).toContain('Counts the stock of every warehouse.');
    await choose('Workflow', 'order', 'Order Processing');
    await view().findByTestId('new-schedule-input');
    expect(orderField()).not.toBeNull();
    expect(view().queryByLabelText(new RegExp(`^${SCHEDULE_COPY.form.agentLabel}`))).toBeNull();
    expect(view().queryByTestId('new-schedule-chat-input')).toBeNull();
    // The engine’s own options are plain sections, not a disclosure.
    expect(view().getByLabelText('Jitter')).not.toBeNull();
    expect(view().queryByRole('button', { name: 'Advanced' })).toBeNull();
  });

  test('says it takes no input when it declares no schema, and makes the schedule without one', async () => {
    open();
    await choose('Workflow', 'inventory', 'Inventory Sync Sweep');
    const none = await view().findByTestId('new-schedule-no-input');
    expect(none.textContent).toBe(COPY.noInput);
    await waitFor(() => expect(create()).not.toBeDisabled());
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('POST /schedules').length).toBe(1));
    expect(stub?.callsTo('POST /schedules')[0]?.params).toMatchObject({
      type: 'inventory-sync-sweep',
    });
    expect(stub?.callsTo('POST /schedules')[0]?.params).not.toHaveProperty('input');
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
    await waitFor(() => expect(router.pathname).toMatch(/^\/schedules\/schedule-engine-/));
  });

  test('makes the schedule through the engine with the input the form collected', async () => {
    open();
    await chooseOrder();
    await fireEvent.input(orderField(), { target: { value: 'A-1001' } });
    await fireEvent.blur(orderField());
    await fireEvent.input(view().getByLabelText(COPY.descriptionLabel), {
      target: { value: 'Orders' },
    });
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('POST /schedules').length).toBe(1));
    expect(stub?.callsTo('POST /schedules')[0]?.params).toMatchObject({
      type: 'order-processing',
      input: { orderId: 'A-1001' },
      description: 'Orders',
    });
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
  });

  test('shows the form’s own errors and makes nothing when the input is invalid', async () => {
    open();
    await chooseOrder();
    await fireEvent.input(orderField(), { target: { value: 'A' } });
    await fireEvent.blur(orderField());
    await fireEvent.click(create());

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="new-schedule-input"] [aria-invalid="true"]'),
      ).not.toBeNull(),
    );
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
  });

  test('does not make a schedule on a plain Enter, which only checks the input', async () => {
    open();
    await chooseOrder();
    await fireEvent.input(orderField(), { target: { value: 'A-1001' } });
    const form = document.querySelector('[data-testid="new-schedule-input"] form');
    if (form === null) throw new Error('Expected the input form.');
    await fireEvent.submit(form);
    await fireEvent.keyDown(orderField(), { key: 'Enter' });

    await quietFor(50);
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
    expect(router.pathname).toBe('/schedules/new');
  });

  test('starts turned off when asked, by making the schedule and then pausing it', async () => {
    open();
    await choose('Workflow', 'inventory', 'Inventory Sync Sweep');
    await view().findByTestId('new-schedule-no-input');
    await fireEvent.click(view().getByLabelText(COPY.startPausedLabel));
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('POST pause /schedules/:schedule').length).toBe(1));
    expect(stub?.callsTo('POST /schedules')).toHaveLength(1);
    await waitFor(() => expect(router.pathname).toMatch(/^\/schedules\/schedule-engine-/));
  });

  test('opens the schedule and says so when it was made but could not be turned off', async () => {
    open({}, (installed) =>
      installed.on('POST pause /schedules/:schedule', () => {
        throw new Error('no');
      }),
    );
    await choose('Workflow', 'inventory', 'Inventory Sync Sweep');
    await view().findByTestId('new-schedule-no-input');
    await fireEvent.click(view().getByLabelText(COPY.startPausedLabel));
    await fireEvent.click(create());

    await waitFor(() => expect(router.pathname).toMatch(/^\/schedules\/schedule-engine-/));
    expect(stub?.callsTo('POST /schedules')).toHaveLength(1);
  });

  test('says so, and makes nothing, when the chosen workflow was listed but is gone', async () => {
    open({}, (installed) =>
      installed.on('weft.workflows.definitions.get', () => {
        throw workflowFaults.notFound('definition inventory-sync-sweep');
      }),
    );
    await choose('Workflow', 'inventory', 'Inventory Sync Sweep');

    await view().findByText(COPY.workflowGone);
    expect(create()).toBeDisabled();
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
  });

  test('sends an interval as a cadence in milliseconds, in no zone', async () => {
    open();
    await choose('Workflow', 'inventory', 'Inventory Sync Sweep');
    await view().findByTestId('new-schedule-no-input');
    await everyTwentyMinutes();
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('POST /schedules').length).toBe(1));
    const params = stub?.callsTo('POST /schedules')[0]?.params;
    expect(params).toMatchObject({ every: 1_200_000 });
    expect(params).not.toHaveProperty('timeZone');
  });

  test('is made in the zone that was chosen', async () => {
    open();
    await choose('Workflow', 'inventory', 'Inventory Sync Sweep');
    await view().findByTestId('new-schedule-no-input');
    await choose('Time zone', 'Asia/Tokyo', 'Asia/Tokyo');
    await waitFor(() =>
      expect(view().getByTestId('new-schedule-summary').textContent).toContain('Asia/Tokyo'),
    );
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('POST /schedules').length).toBe(1));
    expect(stub?.callsTo('POST /schedules')[0]?.params).toMatchObject({
      cronExpression: '0 9 * * *',
      timeZone: 'Asia/Tokyo',
    });
  });

  test('refuses while the cadence builder shows a field out of range, and makes nothing', async () => {
    open();
    await choose('Workflow', 'inventory', 'Inventory Sync Sweep');
    await view().findByTestId('new-schedule-no-input');
    await fireEvent.change(await view().findByLabelText('Repeats'), { target: { value: 'cron' } });
    await fireEvent.input(view().getByLabelText('Hour'), { target: { value: '99' } });
    // The builder keeps the last cadence it emitted, so the draft is still valid and Create is on.
    await fireEvent.click(create());

    await view().findByText(COPY.invalidCadence);
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
    expect(router.pathname).toBe('/schedules/new');
  });
});
