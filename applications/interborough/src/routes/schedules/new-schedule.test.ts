/**
 * `/schedules/new`: the page that makes a schedule (COR-2018, rows 74a–75o, 06i–06k). The form
 * reads What runs, Input, When, the two policy selects, then Name. A workflow is chosen from the
 * picker (Built in, Recent, All workflows); only the built-in chat asks for an agent, a message
 * and whether to continue one chat; any other workflow asks for its own input; Create stays
 * enabled and moves focus to the first problem; leaving after typing asks first.
 *
 * Driven against `installWorkflowWorld`, as `schedule-edit-pages.test.ts` is. The timings (a status
 * at ten seconds) are proved with fake timers, never slept.
 */
import { RUN_ENGINE_WORKFLOW_TYPES } from '@lostgradient/operative/run-engine-workflow-types';
import { quietFor } from '@lostgradient/testing/wait-until';
import type { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
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
  jest.useRealTimers();
  stub?.restore();
  stub = undefined;
});

const AGENTS = ['assistant', 'tool-runner'].map((name) => ({
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

const REFUND_SCHEMA = {
  type: 'object',
  properties: {
    orderNumber: { type: 'string', title: 'Order number' },
    lineItems: {
      type: 'array',
      title: 'Line items',
      items: {
        type: 'object',
        properties: { sku: { type: 'string' }, quantity: { type: 'integer' } },
      },
    },
  },
  required: ['orderNumber', 'lineItems'],
};

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    folder: { type: 'string', title: 'Folder' },
    messages: { type: 'string', title: 'Messages', enum: ['unread', 'all'] },
    flagUrgent: {
      type: 'boolean',
      title: 'Flag urgent messages',
      description: 'Mark anything that looks urgent for a review.',
    },
  },
  required: ['folder'],
};

function world(overrides: Partial<World> = {}): World {
  return emptyWorld({
    definitions: [
      codeDefinition('order-processing', {
        contract: { name: 'order-processing', inputSchema: ORDER_SCHEMA },
      }),
      codeDefinition('triage-inbox', {
        description: 'Sorts new messages and flags anything urgent.',
        contract: { name: 'triage-inbox', inputSchema: TRIAGE_SCHEMA },
      }),
      codeDefinition('order-refund', {
        description: 'Looks up an order, waits for approval, then refunds it.',
        contract: { name: 'order-refund', inputSchema: REFUND_SCHEMA },
      }),
      codeDefinition('inventory-sync-sweep', {
        description: 'Counts the stock of every warehouse.',
        contract: { name: 'inventory-sync-sweep', workflowVersion: '1.0.0' },
      }),
      codeDefinition('release-notes', {
        description: 'Collects merged changes into a draft.',
        contract: {
          name: 'release-notes',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      }),
      // Every type the Bureau's run engine registers is in the registry of a host whose console is the Bureau's.
      ...RUN_ENGINE_WORKFLOW_TYPES.map((type) => codeDefinition(type)),
      sourceDefinition('digest'),
    ],
    files: [readyFile('digest')],
    agents: AGENTS,
    agentModels: { 'tool-runner': 'sonnet' },
    contexts: [contextFixture('chat-1', { title: 'Weekly numbers', agentName: 'assistant' })],
    ...overrides,
  });
}

/** `before` changes how the services answer, ahead of the first request the page makes. */
function open(
  overrides: Partial<World> = {},
  before: (installed: WorkflowStub) => void = () => undefined,
  scopes: readonly AuthorizationScope[] = AUTHORIZATION_SCOPES,
  onQueryClient?: (queryClient: QueryClient) => void,
) {
  stub = installWorkflowWorld(world(overrides));
  before(stub);
  router.navigate('/schedules/new', { replace: true });
  return render(IndexHarness, {
    props: { client: stub.client, externalBureau: true, scopes, onQueryClient },
  });
}

const view = () => within(document.body);
const create = () => view().getByRole('button', { name: /^Create schedule$|^Creating…$/ });
const trigger = () => view().findByRole('combobox', { name: /^Workflow/ });
const footer = () => view().getByTestId('new-schedule-summary').textContent;
const field = (label: RegExp | string) => view().getByLabelText(label);

/** Opens the picker and waits for its options to be listed. */
async function openPicker(): Promise<void> {
  const workflow = await trigger();
  // The field does not open while the workflow list loads.
  await waitFor(() => expect(workflow.getAttribute('aria-busy')).not.toBe('true'));
  await fireEvent.click(workflow);
  await waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
}

/** Opens the picker and chooses the option whose text includes `text`, as a person does. */
async function choose(text: string): Promise<void> {
  await openPicker();
  const option = [...document.querySelectorAll('[role="option"]')].find((entry) =>
    (entry.textContent ?? '').includes(text),
  );
  if (option === undefined) throw new Error(`Expected ${text} to be offered.`);
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

/** The first element of `selector` whose text is `text`, in the open picker's panel, which a role query does not reach while it is positioned. */
function inPanel(selector: string, text: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (element) => element.textContent?.trim() === text,
  );
  if (found === undefined) throw new Error(`Expected ${text} in the picker.`);
  return found;
}

/** Confirms the dialog that asks whether to discard what was typed, as a person leaving does. */
async function discardAndLeave(): Promise<void> {
  await fireEvent.click(
    within(await view().findByRole('dialog')).getByRole('button', {
      name: COPY.discard.confirm,
    }),
  );
}

/** Sets one field of the cron builder to a specific value. */
async function setCronField(name: string, value: string): Promise<void> {
  const input = field(name);
  await fireEvent.input(input, { target: { value } });
  await fireEvent.change(input, { target: { value } });
  await fireEvent.blur(input);
}

/** Sets the cadence to every 20 minutes, which is an interval and so is read in no zone. */
async function everyTwentyMinutes(): Promise<void> {
  await fireEvent.change(await view().findByLabelText('Repeats'), {
    target: { value: 'interval' },
  });
  await fireEvent.change(field('Unit'), { target: { value: 'minutes' } });
  const every = field('Every');
  await fireEvent.input(every, { target: { value: '20' } });
  await fireEvent.change(every, { target: { value: '20' } });
  await fireEvent.blur(every);
}

/** Chooses the chat, and fills its message: the agent is the default one. */
async function fillChat(message = 'Summarize yesterday’s chats and open reviews.'): Promise<void> {
  await choose(COPY.chat.label);
  await waitFor(() => expect((field(/^Agent/) as HTMLSelectElement).value).toBe('assistant'));
  await fireEvent.input(field(/^Message/), { target: { value: message } });
}

describe('the page', () => {
  test('opens at the initial state: What runs, When and Name, the picker empty and the footer saying to pick', async () => {
    open();
    await view().findByRole('heading', { level: 1, name: COPY.title });
    expect(document.querySelector('[data-page="schedule-new"] p')?.textContent).toMatch(
      /^Pick what runs, then when, then name it\. Next runs show in .+ before you save\.$/,
    );
    const headings = [...document.querySelectorAll('[data-page="schedule-new"] h2')].map(
      (heading) => heading.textContent?.trim(),
    );
    expect(headings).toEqual([COPY.whatRunsHeading, COPY.whenHeading]);
    const workflow = await trigger();
    expect(workflow.textContent).toContain(COPY.workflowPlaceholder);
    expect(document.querySelector('label[for="ib-schedule-new-workflow"]')?.textContent).toContain(
      'Workflow',
    );
    expect(view().queryByTestId('new-schedule-chat-input')).toBeNull();
    expect(view().queryByTestId('new-schedule-workflow-input')).toBeNull();
    const name = field(/^Name/) as HTMLInputElement;
    expect(name.placeholder).toBe(COPY.namePlaceholder);
    expect(name.value).toBe('');
    expect(view().getByText(COPY.nameDescription)).not.toBeNull();
    expect(footer()).toBe(COPY.footer.nothing);
    // Create stays enabled, and a required field is marked by its dot and never by the word.
    expect(create().hasAttribute('disabled')).toBe(false);
    expect(document.body.textContent).not.toMatch(/\brequired\b/i);
  });

  test('orders the form What runs, When, the two policy selects, then Name, with Input between for a workflow that has one', async () => {
    open();
    await choose(COPY.chat.label);
    await view().findByTestId('new-schedule-chat-input');
    const order = [
      '#ib-schedule-new-workflow',
      '#ib-schedule-new-agent',
      '#ib-schedule-new-message',
      '[data-testid="schedule-when"]',
      '#ib-schedule-new-name',
    ].map((selector) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`Expected ${selector}.`);
      return element;
    });
    for (const [index, element] of order.entries()) {
      const next = order[index + 1];
      if (next === undefined) continue;
      expect(element.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The policy selects are in the When block, before Name.
    expect(view().getByLabelText(SCHEDULE_COPY.create.catchUpLabel)).not.toBeNull();
    expect(view().getByLabelText('If a run is still going')).not.toBeNull();
    expect((field('If a run is still going') as HTMLSelectElement).selectedOptions[0]?.text).toBe(
      'Skip this one',
    );
    expect(
      (field(SCHEDULE_COPY.create.catchUpLabel) as HTMLSelectElement).selectedOptions[0]?.text,
    ).toBe('Don’t catch up on missed runs');
  });

  test('groups the picker: the chat built in, Recent by the newest schedules, then All workflows, each with its description', async () => {
    open({
      schedules: [
        scheduleFixture('old', 'order-processing', { createdAt: 1_000 }),
        scheduleFixture('new', 'release-notes', { createdAt: 3_000 }),
      ],
    });
    await openPicker();
    await waitFor(() => expect(listed().map((entry) => entry.group)).toContain(COPY.groups.recent));
    expect(listed()).toEqual([
      { group: COPY.groups.builtIn, labels: [COPY.chat.label] },
      { group: COPY.groups.recent, labels: ['Release notes', 'Order processing'] },
      {
        group: COPY.groups.all,
        labels: ['Digest', 'Inventory sync sweep', 'Order refund', 'Triage inbox'],
      },
    ]);
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain(
      'Collects merged changes into a draft.',
    );
    // The footer is below the options, always visible: "No match? Create one".
    expect(document.body.textContent).toContain(`${COPY.noMatchFooter} ${COPY.createOne}`);
  });

  test('says nothing matches a search and keeps the footer with its link, which opens the workflow builder', async () => {
    open();
    await openPicker();
    const search = document.querySelector<HTMLInputElement>('.cinder-combobox__search input');
    if (search === null) throw new Error('Expected the picker’s search field.');
    await fireEvent.input(search, { target: { value: 'refnud' } });
    await waitFor(() => expect(document.body.textContent).toContain(COPY.noMatch('refnud')));
    const link = inPanel('a', COPY.createOne);
    await fireEvent.click(link);
    expect(router.pathname).toBe('/workflows/new');
  });

  test('draws the closed field as two lines once a workflow is chosen: its name and its description', async () => {
    open();
    await choose('Triage inbox');
    const workflow = await trigger();
    await waitFor(() => expect(workflow.textContent).toContain('Triage inbox'));
    expect(workflow.textContent).toContain('Sorts new messages and flags anything urgent.');
  });

  test('keeps the picker a combobox, with Chat with an agent to choose, when the workflows could not be listed', async () => {
    open({}, (installed) =>
      installed.on('weft.workflows.definitions.list', () => {
        throw workflowFaults.unavailable();
      }),
    );
    await openPicker();
    expect(document.body.textContent).toContain(COPY.catalogFailed.title);
    expect(document.body.textContent).toContain(COPY.catalogFailed.description);
    expect(inPanel('button', 'Try again')).not.toBeNull();
    expect(listed()).toEqual([{ group: COPY.groups.builtIn, labels: [COPY.chat.label] }]);
    const chat = document.querySelector('[role="option"]');
    if (chat === null) throw new Error('Expected the chat to be offered.');
    await fireEvent.mouseDown(chat);
    await view().findByTestId('new-schedule-chat-input');
  });

  test('waits for the workflow list: the field says so, the footer says so, Cancel is live and Create is not', async () => {
    let release: (() => void) | undefined;
    open({}, (installed) =>
      installed.on('weft.workflows.definitions.list', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return undefined;
      }),
    );
    await waitFor(() => expect(footer()).toBe(COPY.footer.waitingForWorkflows));
    const loading = await trigger();
    expect(loading.textContent).toContain(COPY.workflowLoading);
    expect(create().hasAttribute('disabled')).toBe(true);
    expect(view().getByRole('link', { name: COPY.cancel }).hasAttribute('disabled')).toBe(false);
    release?.();
  });

  test('after ten seconds of waiting for the workflow list the field says it is still loading, with a Cancel that shows the list as failed', async () => {
    jest.useFakeTimers();
    open({}, (installed) =>
      installed.on('weft.workflows.definitions.list', () => new Promise(() => undefined)),
    );
    await waitFor(() => expect(footer()).toBe(COPY.footer.waitingForWorkflows));
    expect(document.body.textContent).not.toContain('Still loading');
    jest.advanceTimersByTime(10_000);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        'Still loading. This is taking longer than usual.',
      ),
    );
    const cancel = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Cancel',
    );
    if (cancel === undefined) throw new Error('Expected a Cancel beside the status.');
    await fireEvent.click(cancel);
    await waitFor(() => expect(footer()).toBe(COPY.footer.nothing));
    expect(create().hasAttribute('disabled')).toBe(false);
  });

  test('refuses a caller who may not write schedules, with the reason', async () => {
    open(
      {},
      () => undefined,
      AUTHORIZATION_SCOPES.filter((scope) => scope !== 'schedules:write'),
    );
    await choose(COPY.chat.label);
    await view().findByTestId('new-schedule-chat-input');
    expect(create().hasAttribute('disabled')).toBe(true);
    expect(create().getAttribute('title')).toBeTruthy();
  });
});

describe('Chat with an agent', () => {
  test('asks for an agent, a message and whether to continue one chat, under an Input section with its lead', async () => {
    open();
    await choose(COPY.chat.label);
    await view().findByTestId('new-schedule-chat-input');
    expect(document.querySelector('[data-testid="new-schedule-chat-input"] h2')?.textContent).toBe(
      'Input',
    );
    expect(view().getByText('What Chat with an agent needs each time it runs.')).not.toBeNull();
    await waitFor(() => expect((field(/^Agent/) as HTMLSelectElement).value).toBe('assistant'));
    expect(
      [...(field(/^Agent/) as HTMLSelectElement).options].map((option) => option.value),
    ).toEqual(['', 'assistant', 'tool-runner']);
    expect(view().getByText(COPY.messageDescription)).not.toBeNull();
    const toggle = view().getByRole('switch', { name: COPY.continueLabel });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(view().getByText(COPY.continueDescription)).not.toBeNull();
    // A scripted agent needs no provider, so there is no notice.
    expect(document.body.textContent).not.toContain(COPY.needsProvider);
  });

  test('starts the name as the agent’s name, and the footer says what a schedule made now starts', async () => {
    open();
    await choose(COPY.chat.label);
    await waitFor(() => expect((field(/^Name/) as HTMLInputElement).value).toBe('Assistant'));
    expect(footer()).toBe('Creates a schedule that starts a chat with Assistant.');
  });

  test('stops following the agent once the name is edited', async () => {
    open();
    await fillChat();
    await fireEvent.input(field(/^Name/), { target: { value: 'Daily summary' } });
    await fireEvent.change(field(/^Agent/), { target: { value: 'tool-runner' } });
    expect((field(/^Name/) as HTMLInputElement).value).toBe('Daily summary');
  });

  test('says a model agent will not run until a provider is connected, with a link that fixes it, and the footer says so', async () => {
    open({ attention: [{ kind: 'no-provider', severity: 'warning' }] });
    await fillChat();
    expect(document.body.textContent).not.toContain(COPY.needsProvider);
    await fireEvent.change(field(/^Agent/), { target: { value: 'tool-runner' } });
    const warning = await waitFor(() => {
      const found = document.querySelector('.cinder-form-field__warning');
      if (found === null) throw new Error('Expected the provider notice.');
      return found;
    });
    expect(warning.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      `${COPY.needsProvider} ${COPY.connectProvider}`,
    );
    await fireEvent.click(
      within(warning as HTMLElement).getByRole('link', { name: COPY.connectProvider }),
    );
    // A chat was started, so leaving for the page that connects a provider asks first.
    await discardAndLeave();
    await waitFor(() => expect(router.pathname).toBe('/settings/models'));
  });

  test('shows the notice only when no provider is connected, and says the schedule will not run in the footer', async () => {
    open({ attention: [{ kind: 'no-provider', severity: 'warning' }] });
    await fillChat();
    await fireEvent.change(field(/^Agent/), { target: { value: 'tool-runner' } });
    await waitFor(() => expect(footer()).toBe(COPY.footer.blocked));
  });

  test('makes the schedule through the Bureau, with the name as its description and the zone it was read in, and opens it', async () => {
    open();
    await fillChat();
    await fireEvent.input(field(/^Name/), { target: { value: 'Daily summary' } });
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.create').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.create')[0]?.params).toMatchObject({
      agentName: 'assistant',
      spec: '0 9 * * *',
      input: 'Summarize yesterday’s chats and open reviews.',
      description: 'Daily summary',
      overlap: 'skip',
      timeZone: expect.any(String),
    });
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
    await waitFor(() => expect(router.pathname).toMatch(/^\/schedules\/schedule-created-/));
  });

  test('sends an interval as a duration, in no zone', async () => {
    open();
    await fillChat();
    await everyTwentyMinutes();
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.create').length).toBe(1));
    const params = stub?.callsTo('bureau.schedules.create')[0]?.params;
    expect(params).toMatchObject({ spec: '20m' });
    expect(params).not.toHaveProperty('timeZone');
  });

  test('continues one chat when the switch is on: the schedule makes the chat’s identifier, and never allows an overlap', async () => {
    open();
    await fillChat();
    await fireEvent.change(field('If a run is still going'), { target: { value: 'allow' } });
    await fireEvent.click(view().getByRole('switch', { name: COPY.continueLabel }));
    // A chat that continues cannot start another run beside itself, so only skipping is offered.
    await waitFor(() =>
      expect(
        [...(field('If a run is still going') as HTMLSelectElement).options].map((o) => o.value),
      ).toEqual(['skip']),
    );
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.create').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.create')[0]?.params).toMatchObject({
      sessionId: expect.stringMatching(/^schedule-chat-/),
      overlap: 'skip',
    });
  });

  test('takes a typed agent name when the Bureau cannot list the agents', async () => {
    open({}, (installed) =>
      installed.on('bureau.agents.list', () => {
        throw workflowFaults.unavailable();
      }),
    );
    await choose(COPY.chat.label);
    const agent = await view().findByLabelText(/^Agent/);
    await waitFor(() => expect(agent.tagName).toBe('INPUT'));
    await fireEvent.input(agent, { target: { value: 'assistant' } });
    await fireEvent.input(field(/^Message/), { target: { value: 'Hello' } });
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.create').length).toBe(1));
    expect(stub?.callsTo('bureau.schedules.create')[0]?.params).toMatchObject({
      agentName: 'assistant',
    });
  });

  test('says there are no agents when the Bureau lists none, with a way to make one', async () => {
    open({ agents: [] });
    await choose(COPY.chat.label);
    await view().findByText(COPY.noAgents.title);
    await fireEvent.click(view().getByRole('link', { name: COPY.noAgents.action }));
    await discardAndLeave();
    await waitFor(() => expect(router.pathname).toBe('/agents/new'));
  });
});

describe('a workflow', () => {
  const orderField = () => field(/^Order id/);

  async function chooseOrder(): Promise<void> {
    await choose('Order processing');
    await view().findByTestId('new-schedule-input');
  }

  test('asks for the input its schema declares under an Input section that names it, not for an agent', async () => {
    open();
    await chooseOrder();
    expect(view().getByText('What Order processing needs each time it runs.')).not.toBeNull();
    expect(orderField()).not.toBeNull();
    expect(view().queryByLabelText(/^Agent/)).toBeNull();
    expect(view().queryByRole('switch', { name: COPY.continueLabel })).toBeNull();
    expect((field(/^Name/) as HTMLInputElement).value).toBe('Order processing');
    expect(footer()).toBe('Creates a schedule that starts Order processing.');
  });

  test('draws the input as the Input variant: short fields share a row and a switch carries its description', async () => {
    open();
    await choose('Triage inbox');
    await view().findByTestId('new-schedule-input');
    expect(view().getByRole('switch', { name: 'Flag urgent messages' })).not.toBeNull();
    expect(view().getByText('Mark anything that looks urgent for a review.')).not.toBeNull();
    const fields = document.querySelector('.cinder-schema-form__fields');
    expect(fields?.getAttribute('data-cinder-columns')).toBe('two');
  });

  test('says it takes no input, as one line with no fields, when its schema says so', async () => {
    open();
    await choose('Release notes');
    await view().findByText('Release notes takes no input.');
    expect(view().queryByTestId('new-schedule-input')).toBeNull();
    await fireEvent.click(create());
    await waitFor(() => expect(stub?.callsTo('POST /schedules').length).toBe(1));
    expect(stub?.callsTo('POST /schedules')[0]?.params?.['input']).toEqual({});
  });

  test('asks for optional JSON when it declares no schema, and makes the schedule without one when left empty', async () => {
    open();
    await choose('Inventory sync sweep');
    await view().findByTestId('new-schedule-input');
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('POST /schedules').length).toBe(1));
    expect(stub?.callsTo('POST /schedules')[0]?.params).toMatchObject({
      type: 'inventory-sync-sweep',
    });
    expect(stub?.callsTo('POST /schedules')[0]?.params).not.toHaveProperty('input');
    await waitFor(() => expect(router.pathname).toMatch(/^\/schedules\/schedule-engine-/));
  });

  test('makes the schedule through the engine with the input the form collected, the policy selects and the name', async () => {
    open();
    await chooseOrder();
    await fireEvent.input(orderField(), { target: { value: 'A-1001' } });
    await fireEvent.blur(orderField());
    await fireEvent.change(field('If a run is still going'), { target: { value: 'allow' } });
    await fireEvent.change(field(COPY.catchUpLabel), { target: { value: 'on' } });
    await fireEvent.input(field(/^Name/), { target: { value: 'Orders' } });
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('POST /schedules').length).toBe(1));
    expect(stub?.callsTo('POST /schedules')[0]?.params).toMatchObject({
      type: 'order-processing',
      input: { orderId: 'A-1001' },
      description: 'Orders',
      overlap: 'allow',
      backfill: true,
    });
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
  });

  test('shows the form’s own problem and makes nothing when the input is invalid, focusing the field', async () => {
    open();
    await chooseOrder();
    await fireEvent.input(orderField(), { target: { value: 'A' } });
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

  test('waits for the input fields, with placeholders, and the footer says so while Create is off', async () => {
    let release: (() => void) | undefined;
    open({}, (installed) =>
      installed.on('weft.workflows.definitions.get', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return undefined;
      }),
    );
    await choose('Order processing');
    await waitFor(() => expect(footer()).toBe(COPY.footer.waitingForInput));
    expect(view().getByText('What Order processing needs each time it runs.')).not.toBeNull();
    expect(
      document.querySelector('.cinder-skeleton-group[data-cinder-variant="form"]'),
    ).not.toBeNull();
    expect(create().hasAttribute('disabled')).toBe(true);
    expect(view().getByRole('link', { name: COPY.cancel }).hasAttribute('disabled')).toBe(false);
    release?.();
  });

  test('draws an array of objects as a JSON editor with its own validity line and Format, and plain inputs above it', async () => {
    open();
    await choose('Order refund');
    await view().findByTestId('new-schedule-input');
    expect(view().getByText('What Order refund needs each time it runs.')).not.toBeNull();
    expect((field(/^Order number/) as HTMLInputElement).tagName).toBe('INPUT');
    const editor = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="new-schedule-input"] textarea',
    );
    if (editor === null) throw new Error('Expected the Line items editor.');
    expect(view().getByText('Line items')).not.toBeNull();
    await fireEvent.input(editor, {
      target: { value: '[{"sku":"mug-12","quantity":1}]' },
    });
    await view().findByText('Valid JSON · array of 1 item');
    expect(view().getByRole('button', { name: 'Format' })).not.toBeNull();
  });

  test('after ten seconds of waiting for the input fields the placeholders say so, with a Cancel that clears the choice', async () => {
    jest.useFakeTimers();
    open({}, (installed) =>
      installed.on('weft.workflows.definitions.get', () => new Promise(() => undefined)),
    );
    await choose('Order processing');
    await waitFor(() => expect(footer()).toBe(COPY.footer.waitingForInput));
    expect(document.body.textContent).not.toContain('Still loading');
    jest.advanceTimersByTime(10_000);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        'Still loading. This is taking longer than usual.',
      ),
    );
    // It is the skeleton's own status line and not a banner.
    expect(document.querySelector('.cinder-skeleton-status')).not.toBeNull();
    const cancel = document.querySelector('.cinder-skeleton-status button');
    if (cancel === null) throw new Error('Expected a Cancel beside the status.');
    await fireEvent.click(cancel);
    await waitFor(() => expect(footer()).toBe(COPY.footer.nothing));
  });

  test('says so, and makes nothing, when the chosen workflow was listed but is gone', async () => {
    open({}, (installed) =>
      installed.on('weft.workflows.definitions.get', () => {
        throw workflowFaults.notFound('definition inventory-sync-sweep');
      }),
    );
    await choose('Inventory sync sweep');

    await view().findByText(COPY.workflowGone);
    await fireEvent.click(create());
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
  });

  test('is made in the zone that was chosen, and an interval in none', async () => {
    open();
    await choose('Inventory sync sweep');
    await view().findByTestId('new-schedule-input');
    await everyTwentyMinutes();
    await fireEvent.click(create());

    await waitFor(() => expect(stub?.callsTo('POST /schedules').length).toBe(1));
    const params = stub?.callsTo('POST /schedules')[0]?.params;
    expect(params).toMatchObject({ every: 1_200_000 });
    expect(params).not.toHaveProperty('timeZone');
  });
});

describe('a problem', () => {
  test('moves focus to the first problem with its message at the field, and makes nothing', async () => {
    open();
    const workflow = await trigger();
    await waitFor(() => expect(workflow.getAttribute('aria-busy')).not.toBe('true'));
    await fireEvent.click(create());

    await waitFor(() => expect(workflow.getAttribute('aria-invalid')).toBe('true'));
    expect(view().getByText(COPY.required)).not.toBeNull();
    await waitFor(() => expect(document.activeElement === workflow).toBe(true));
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
  });

  test('is the message when a chat has none, and then the name when that is cleared', async () => {
    open();
    await fillChat('');
    await fireEvent.click(create());
    const message = field(/^Message/);
    await waitFor(() => expect(document.activeElement === message).toBe(true));
    expect(view().getByText(SCHEDULE_COPY.form.inputRequired)).not.toBeNull();

    await fireEvent.input(message, { target: { value: 'Hello' } });
    await fireEvent.input(field(/^Name/), { target: { value: '  ' } });
    await fireEvent.click(create());
    await waitFor(() => expect(document.activeElement === field(/^Name/)).toBe(true));
    expect(view().getByText(COPY.nameRequired)).not.toBeNull();
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
  });

  test('is a cron field out of range: its message sits at the field, the footer says where Create will go, and Create focuses it', async () => {
    open();
    await fillChat();
    await fireEvent.change(await view().findByLabelText('Repeats'), { target: { value: 'cron' } });
    await setCronField('Day of week', '8');
    await waitFor(() => expect(footer()).toContain('focus moves to Day of week.'));
    expect(footer()).toBe(
      `${COPY.footer.chat('Assistant')} ${COPY.footer.stillEnabled('Day of week')}`,
    );
    expect(create().hasAttribute('disabled')).toBe(false);
    await fireEvent.click(create());

    await waitFor(() => expect(document.activeElement === field('Day of week')).toBe(true));
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
    expect(router.pathname).toBe('/schedules/new');
  });

  test('is a name another schedule has: danger text at the field with a link to that schedule, no banner, the rest kept', async () => {
    open({
      schedules: [
        scheduleFixture('existing', 'order-processing', { description: 'Daily summary' }),
      ],
    });
    await fillChat();
    await fireEvent.input(field(/^Name/), { target: { value: 'Daily summary' } });
    await fireEvent.click(create());

    const taken = await view().findByText(COPY.nameTaken);
    expect(taken.closest('.cinder-form-field__error')?.querySelector('svg')).not.toBeNull();
    const open_ = view().getByRole('link', { name: 'Open Daily summary' });
    expect(open_.getAttribute('href')).toBe('/schedules/existing');
    expect(view().queryByTestId('new-schedule-failed')).toBeNull();
    expect(footer()).toBe(COPY.footer.chat('Assistant'));
    expect((field(/^Message/) as HTMLTextAreaElement).value).toBe(
      'Summarize yesterday’s chats and open reviews.',
    );
    expect(create().hasAttribute('disabled')).toBe(false);
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
    await waitFor(() => expect(document.activeElement === field(/^Name/)).toBe(true));
  });
});

describe('a name another schedule has, found when the list cannot be read again', () => {
  test('is still refused from the list the page already had', async () => {
    open({
      schedules: [
        scheduleFixture('existing', 'order-processing', { description: 'Daily summary' }),
      ],
    });
    await fillChat();
    await fireEvent.input(field(/^Name/), { target: { value: 'Daily summary' } });
    // The list read when the page opened is the one left once the read made at Create fails.
    if (stub !== undefined) stub.world.failSchedules = true;
    await fireEvent.click(create());

    expect(await view().findByText(COPY.nameTaken)).not.toBeNull();
    expect(stub?.callsTo('bureau.schedules.create')).toEqual([]);
  });

  test('its link opens that schedule, after asking to discard what was typed', async () => {
    open({
      schedules: [
        scheduleFixture('existing', 'order-processing', { description: 'Daily summary' }),
      ],
    });
    await fillChat();
    await fireEvent.input(field(/^Name/), { target: { value: 'Daily summary' } });
    await fireEvent.click(create());

    await fireEvent.click(await view().findByRole('link', { name: 'Open Daily summary' }));
    await discardAndLeave();

    await waitFor(() => expect(router.pathname).toBe('/schedules/existing'));
  });
});

describe('a workflow list that could not be read', () => {
  test('is read again from the field’s own retry', async () => {
    let failing = true;
    open({}, (installed) =>
      installed.on('weft.workflows.definitions.list', () => {
        if (failing) throw workflowFaults.unavailable();
        return [];
      }),
    );
    const workflow = await trigger();
    await waitFor(() => expect(workflow.getAttribute('aria-busy')).not.toBe('true'));
    await fireEvent.click(workflow);
    const retry = await waitFor(() => {
      const found = [...document.querySelectorAll('button')].find((button) =>
        /try again|retry/i.test(button.textContent ?? ''),
      );
      if (found === undefined) throw new Error('Expected a retry beside the failure.');
      return found;
    });
    const before = stub?.callsTo('weft.workflows.definitions.list').length ?? 0;
    failing = false;
    await fireEvent.click(retry);
    await waitFor(() =>
      expect(stub?.callsTo('weft.workflows.definitions.list').length ?? 0).toBeGreaterThan(before),
    );
  });
});

describe('leaving by closing the tab', () => {
  test('asks the browser to confirm once something was typed, and not before', async () => {
    open();
    await view().findByRole('combobox', { name: /^Workflow/ });
    const untouched = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(untouched);
    expect(untouched.defaultPrevented).toBe(false);

    await fillChat('Something');
    const typed = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(true);
  });
});

describe('creating', () => {
  /** A create the page is waiting on, which the test answers or never answers. */
  function slowCreate(): { release: () => void } {
    const handle: { release: () => void } = { release: () => undefined };
    stub?.on('bureau.schedules.create', async () => {
      await new Promise<void>((resolve) => {
        handle.release = resolve;
      });
      return undefined;
    });
    return handle;
  }

  test('says only that it is creating, stops the fields taking edits, and keeps Cancel live', async () => {
    open({}, (installed) =>
      installed.on('bureau.schedules.create', () => new Promise(() => undefined)),
    );
    await fillChat();
    await fireEvent.click(create());

    await waitFor(() => expect(footer()).toBe(COPY.footer.creating));
    expect(create().textContent).toContain(COPY.creating);
    expect(create().getAttribute('aria-disabled')).toBe('true');
    expect(
      (document.querySelector('fieldset.ib-schedule-new__fields') as HTMLFieldSetElement).disabled,
    ).toBe(true);
    expect(view().getByRole('link', { name: COPY.cancel }).hasAttribute('disabled')).toBe(false);
  });

  test('adds the slow line after ten seconds, and a second press while it waits starts nothing', async () => {
    jest.useFakeTimers();
    open({}, (installed) =>
      installed.on('bureau.schedules.create', () => new Promise(() => undefined)),
    );
    await fillChat();
    await fireEvent.click(create());
    await waitFor(() => expect(footer()).toBe(COPY.footer.creating));
    await fireEvent.click(create());
    jest.advanceTimersByTime(10_000);
    await waitFor(() =>
      expect(footer()).toBe(
        `${COPY.footer.creating} ${COPY.footer.slow} ${COPY.footer.cancelStops}`,
      ),
    );
    expect(stub?.callsTo('bureau.schedules.create')).toHaveLength(1);
  });

  test('Cancel stops the request and keeps the form: nothing navigates, and what was typed is still there', async () => {
    open();
    slowCreate();
    await fillChat('Keep me');
    await fireEvent.click(create());
    await waitFor(() => expect(footer()).toBe(COPY.footer.creating));
    await fireEvent.click(view().getByRole('link', { name: COPY.cancel }));

    await waitFor(() => expect(footer()).toBe(COPY.footer.chat('Assistant')));
    expect(router.pathname).toBe('/schedules/new');
    expect((field(/^Message/) as HTMLTextAreaElement).value).toBe('Keep me');
    expect(view().queryByTestId('new-schedule-failed')).toBeNull();
  });

  test('says the answer was lost, keeps everything typed, and Create keeps its own label as the retry', async () => {
    open({}, (installed) =>
      installed.on('bureau.schedules.create', () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await fillChat();
    await fireEvent.click(create());

    const alert = await view().findByTestId('new-schedule-failed');
    expect(alert.textContent).toContain(COPY.failed.title);
    expect(alert.textContent).toContain(COPY.failed.message);
    expect(view().queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(create().textContent).toContain(COPY.submit);
    expect(footer()).toBe(COPY.footer.chat('Assistant'));
    expect(router.pathname).toBe('/schedules/new');
  });

  test('says what the Bureau refused, and keeps what was typed', async () => {
    open({}, (installed) =>
      installed.on('bureau.schedules.create', () => {
        throw workflowFaults.invalidParams();
      }),
    );
    await fillChat('Keep me');
    await fireEvent.click(create());

    const alert = await view().findByTestId('new-schedule-failed');
    expect(alert.textContent).toContain(COPY.failed.title);
    expect(alert.textContent).toContain(' What you typed is still here.');
    expect((field(/^Message/) as HTMLTextAreaElement).value).toBe('Keep me');
  });
});

describe('leaving', () => {
  test('after typing asks first, with Keep editing as the default, and leaves only when told to', async () => {
    open();
    await fillChat('Something');
    await fireEvent.click(view().getByRole('link', { name: COPY.cancel }));

    const dialog = await view().findByRole('dialog');
    expect(within(dialog).getByText(COPY.discard.title)).not.toBeNull();
    expect(within(dialog).getByText(COPY.discard.description)).not.toBeNull();
    const keep = within(dialog).getByRole('button', { name: COPY.discard.keep });
    await waitFor(() => expect(document.activeElement === keep).toBe(true));
    await fireEvent.click(keep);
    expect(router.pathname).toBe('/schedules/new');

    await fireEvent.click(view().getByRole('link', { name: COPY.cancel }));
    await discardAndLeave();
    await waitFor(() => expect(router.pathname).toBe('/schedules'));
  });

  test('asks the same when the address changes by any other way, such as a link in the shell', async () => {
    open();
    await fillChat('Something');
    router.navigate('/agents');
    await view().findByRole('dialog');
    expect(router.pathname).toBe('/schedules/new');
  });

  test('does not ask when nothing was typed', async () => {
    open();
    await fireEvent.click(await view().findByRole('link', { name: COPY.cancel }));
    expect(view().queryByRole('dialog')).toBeNull();
    expect(router.pathname).toBe('/schedules');
  });

  test('does not ask once the schedule is made', async () => {
    open();
    await fillChat();
    await fireEvent.click(create());
    await waitFor(() => expect(router.pathname).toMatch(/^\/schedules\/schedule-created-/));
    expect(view().queryByRole('dialog')).toBeNull();
  });
});
