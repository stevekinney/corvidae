/**
 * COR-1893: a hook action kind a running plugin contributes is a choice under Then, and its
 * configuration is drawn from the schema the Bureau reports (`bureau.plugins.contributions`). An event in a
 * hook's deliveries shows its plain words and its raw kind: a delivery holds no payload, so no
 * formatter's sentence is written for it.
 */
import { HttpClient } from '@lostgradient/weft';
import { focusManager } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  StubFault,
  installBureauStub,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';
import { HOOKS_COPY } from './hook-copy.ts';
import { eventOptionLabel } from './hook-presentation.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const PAGE_KIND = {
  plugin: 'pager',
  kind: 'page',
  description: 'Pages the on-call person.',
  version: '1.0.0',
  dryRun: false,
  configuration: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { team: { type: 'string', description: 'The team to page.' } },
    required: ['team'],
  },
};

const CATALOG = ['review.requested', 'schedule.missed'].map((kind) => ({
  kind,
  origin: 'run',
  scopes: [],
  description: `Describes ${kind}`,
  payload: [],
}));

function delivery(kind: string, id: string) {
  return {
    id,
    hookId: 'alpha',
    owner: 'anonymous:local',
    actionType: 'webhook',
    kind,
    test: false,
    status: 'delivered',
    request: { url: 'https://example.com/alpha', headers: {}, body: '{}' },
    work: null,
    attempts: [
      {
        number: 1,
        startedAt: 2_000,
        finishedAt: 2_100,
        outcome: 'response',
        status: 200,
        responseExcerpt: null,
        responseTruncated: null,
        error: null,
        receipt: null,
      },
    ],
    maxAttempts: 5,
    createdAt: 2_000,
    updatedAt: 2_100,
  };
}

const ALPHA = {
  id: 'alpha',
  owner: 'anonymous:local',
  name: null,
  action: { type: 'webhook', url: 'https://example.com/alpha' },
  events: ['review.requested'],
  scope: null,
  enabled: true,
  createdAt: 1_000,
  updatedAt: 1_000,
  revision: 1,
};

function open(path: string, handlers: Parameters<typeof installBureauStub>[0] = {}) {
  stub = installBureauStub({
    'bureau.hooks.list': () => ({ hooks: [] }),
    'bureau.hooks.get': () => ALPHA,
    'bureau.hooks.deliveries': () => ({
      deliveries: [delivery('review.requested', 'd1'), delivery('schedule.missed', 'd2')],
    }),
    'bureau.hooks.create': (params) => ({ ...ALPHA, id: 'created', ...params }),
    'bureau.events.catalog': () => ({ events: CATALOG }),
    'bureau.plugins.contributions': () => ({ triggers: [], reactions: [PAGE_KIND] }),
    ...handlers,
  });
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

async function chooseEvent(view: ReturnType<typeof open>, search: string, name: string) {
  const input = await view.findByRole('combobox', { name: HOOKS_COPY.editor.event.label });
  await fireEvent.focus(input);
  await fireEvent.input(input, { target: { value: search } });
  const option = await waitFor(() => {
    const found = Array.from(document.body.querySelectorAll('[role="option"]')).find((element) =>
      element.textContent?.includes(name),
    );
    if (found === undefined) throw new Error(`no option ${name}`);
    return found;
  });
  await fireEvent.mouseDown(option);
}

/** Chooses "Run an action from a plugin", then the action titled `title` from the Action Select. */
async function choosePluginAction(view: ReturnType<typeof open>, title: string) {
  const group = await view.findByRole('radiogroup', { name: HOOKS_COPY.editor.action.label });
  await waitFor(() => expect(within(group).getAllByRole('radio').length).toBe(4));
  await fireEvent.click(
    within(group).getByRole('radio', { name: HOOKS_COPY.editor.action.plugin }),
  );
  await fireEvent.click(await view.findByRole('combobox', { name: /^Action/ }));
  const option = await waitFor(() => {
    const found = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (element) => element.querySelector('.cinder-select__option-label')?.textContent === title,
    );
    if (found === undefined) throw new Error(`no action ${title}`);
    return found;
  });
  await fireEvent.click(option);
}

describe('a contributed hook action under Then', () => {
  test('is offered beside the built-in actions, and its schema fields render when chosen', async () => {
    const view = open('/hooks/new');
    // A plugin adds one more choice beside the built-in actions: "Run an action from a plugin".
    const group = await view.findByRole('radiogroup', { name: HOOKS_COPY.editor.action.label });
    await waitFor(() => expect(within(group).getAllByRole('radio').length).toBe(4));
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.textContent?.trim()),
    ).toEqual([
      HOOKS_COPY.editor.action.webhook,
      HOOKS_COPY.editor.action.startWorkflow,
      HOOKS_COPY.editor.action.notify,
      HOOKS_COPY.editor.action.plugin,
    ]);

    await choosePluginAction(view, 'Page');
    await waitFor(() => expect(view.getByLabelText(/team/i)).toBeTruthy());
    expect(view.getByTestId('contributed-action').textContent).toContain(
      'Pages the on-call person.',
    );
    // The built-in webhook fields are gone.
    expect(view.queryByLabelText(HOOKS_COPY.editor.webhook.urlLabel)).toBeNull();
  });

  test('creates a hook with a plugin action holding the configuration typed into its fields', async () => {
    const view = open('/hooks/new');
    await chooseEvent(view, 'review', 'A review is waiting');
    await choosePluginAction(view, 'Page');
    await fireEvent.input(await waitFor(() => view.getByLabelText(/team/i)), {
      target: { value: 'ops' },
    });

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.create }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.create').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.create')[0]?.params).toEqual({
      events: ['review.requested'],
      action: { type: 'plugin', plugin: 'pager', kind: 'page', configuration: { team: 'ops' } },
    });
    await waitFor(() => expect(router.pathname).toBe('/hooks/created'));
  });

  test('creates a hook from an untouched form with the choices it shows', async () => {
    const view = open('/hooks/new', {
      'bureau.plugins.contributions': () => ({
        triggers: [],
        reactions: [
          {
            ...PAGE_KIND,
            configuration: {
              type: 'object',
              properties: { urgency: { enum: ['low', 'high'] } },
              required: ['urgency'],
            },
          },
        ],
      }),
    });
    await chooseEvent(view, 'review', 'A review is waiting');
    await choosePluginAction(view, 'Page');
    await view.findByTestId('contributed-configuration');

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.create }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.create').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.create')[0]?.params).toEqual({
      events: ['review.requested'],
      action: { type: 'plugin', plugin: 'pager', kind: 'page', configuration: { urgency: 'low' } },
    });
  });

  test('offers only the built-in actions when the host cannot say what plugins add', async () => {
    const view = open('/hooks/new', {
      'bureau.plugins.contributions': () => {
        throw new Error('down');
      },
    });
    await waitFor(() => expect(stub?.callsTo('bureau.plugins.contributions').length).toBe(1));
    // The built-in actions alone are the segmented control, and there is no select to choose from.
    const awaited213 = await view.findAllByRole('radio');
    expect(awaited213.length).toBe(3);
    expect(view.queryByRole('combobox', { name: HOOKS_COPY.editor.action.label })).toBeNull();
  });
});

/** A saved hook that runs `pager/page`, and the test delivery the Bureau answers for it. */
const PAGER_HOOK = {
  ...ALPHA,
  id: 'pager-hook',
  action: { type: 'plugin', plugin: 'pager', kind: 'page', configuration: { team: 'ops' } },
};

function testDelivery(status: 'delivered' | 'exhausted') {
  return {
    ...delivery('hook.test', 'test-1'),
    hookId: 'pager-hook',
    actionType: 'plugin',
    test: true,
    status,
    request: null,
    attempts: [
      {
        number: 1,
        startedAt: 2_000,
        finishedAt: 2_100,
        outcome: status === 'delivered' ? 'completed' : 'error',
        status: null,
        responseExcerpt: null,
        responseTruncated: null,
        error: status === 'delivered' ? null : 'The pager is down',
        receipt: null,
      },
    ],
    maxAttempts: 1,
  };
}

describe('the configuration of a saved plugin hook when another revision is adopted (COR-2181)', () => {
  const teamField = (view: ReturnType<typeof open>) =>
    waitFor(() => view.getByLabelText(/team/i) as HTMLInputElement);

  test('shows a newer revision’s configuration after a refresh, so the next save does not put the old one back', async () => {
    let served = { ...PAGER_HOOK };
    const view = open('/hooks/pager-hook', {
      'bureau.hooks.get': () => served,
      'bureau.hooks.update': (params) => ({ ...served, ...params, revision: served.revision + 1 }),
    });
    expect((await teamField(view)).value).toBe('ops');

    // Another client changes the configuration; the unedited form adopts the newer revision.
    served = {
      ...PAGER_HOOK,
      revision: 2,
      action: { ...PAGER_HOOK.action, configuration: { team: 'platform' } },
    };
    const reads = stub?.callsTo('bureau.hooks.get').length ?? 0;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.get').length).toBeGreaterThan(reads));
    await waitFor(async () => expect((await teamField(view)).value).toBe('platform'));

    // An edit of the draft keeps the field it was typed into: the form is not made again.
    const field = await teamField(view);
    await fireEvent.input(field, { target: { value: 'platform-oncall' } });
    expect(field.isConnected).toBe(true);
    expect((await teamField(view)).value).toBe('platform-oncall');

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.update')[0]?.params).toMatchObject({
      expectedRevision: 2,
      action: { configuration: { team: 'platform-oncall' } },
    });
  });

  test('shows the reloaded configuration after Reload discards what was typed', async () => {
    let served = { ...PAGER_HOOK };
    const view = open('/hooks/pager-hook', { 'bureau.hooks.get': () => served });
    await fireEvent.input(await teamField(view), { target: { value: 'mine' } });

    // The hook changes under the edit: the form keeps the edit and offers Reload.
    served = {
      ...PAGER_HOOK,
      revision: 2,
      action: { ...PAGER_HOOK.action, configuration: { team: 'theirs' } },
    };
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await view.findByTestId('hook-changed');
    expect((await teamField(view)).value).toBe('mine');

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.reload }));
    await waitFor(async () => expect((await teamField(view)).value).toBe('theirs'));
    expect(view.queryByTestId('hook-changed')).toBeNull();
  });
});

describe('Send a test event on a saved plugin hook (COR-2183, reactions-2 matrix line 115)', () => {
  const copy = HOOKS_COPY.editor.check;
  const TESTABLE = () => ({ triggers: [], reactions: [{ ...PAGE_KIND, dryRun: true }] });
  const alertOf = (result: HTMLElement) =>
    result.closest('[data-cinder-variant]') ?? result.querySelector('[data-cinder-variant]');

  async function testButton(view: ReturnType<typeof open>) {
    return (await view.findByRole('button', { name: copy.test })) as HTMLButtonElement;
  }

  /** A result with a link has the Alert's actions box, which holds exactly that one link to the log. */
  function expectOneLogLink(result: HTMLElement) {
    const actions = result.querySelector('.cinder-alert__actions');
    expect(actions).not.toBeNull();
    expect(actions?.querySelectorAll('a')).toHaveLength(1);
    expect(actions?.textContent?.trim()).toBe(HOOKS_COPY.editor.header.jumpToLog);
  }

  /** The button is off but reachable: `aria-disabled`, focusable, described by the reason, and pressing it does nothing. */
  async function expectOff(view: ReturnType<typeof open>, reason: string) {
    const test = await testButton(view);
    // The reason may hold a link ("Settings"), so it is read whole from its own element.
    const text = await waitFor(() => {
      const found = view.getByTestId('hook-test-reason');
      if (found.textContent?.trim() !== reason)
        throw new Error(`The reason reads ${found.textContent ?? ''}`);
      return found;
    });
    await waitFor(() => expect(test.getAttribute('aria-disabled')).toBe('true'));
    expect(test.disabled).toBe(false);
    expect(test.getAttribute('aria-describedby')).toBe(text.id);
    test.focus();
    expect(document.activeElement).toBe(test);
    await fireEvent.click(test);
    expect(stub?.callsTo('bureau.hooks.test')).toHaveLength(0);
    expect(stub?.callsTo('bureau.hooks.draft.test')).toHaveLength(0);
  }

  test('is on for an action that offers a test, and says nothing was sent, with its link in the Alert’s actions', async () => {
    const view = open('/hooks/pager-hook', {
      'bureau.hooks.get': () => PAGER_HOOK,
      'bureau.plugins.contributions': TESTABLE,
      'bureau.hooks.test': () => testDelivery('delivered'),
    });
    const test = await testButton(view);
    await waitFor(() => expect(test.getAttribute('aria-disabled')).toBeNull());
    expect(test.getAttribute('aria-describedby')).toBeNull();
    expect(view.queryByTestId('hook-test-reason')).toBeNull();

    await fireEvent.click(test);
    const result = await view.findByTestId('hook-test-result');
    expect(result.textContent).toContain(copy.testPluginRan('Page'));
    expect(result.textContent).toContain(
      'Test ran. Page checked the event without doing it; nothing was sent.',
    );
    expect(result.textContent).not.toContain('Test event sent');
    expect(result.textContent).not.toMatch(/dry run/i);
    expect(alertOf(result)?.getAttribute('data-cinder-variant')).toBe('success');
    // A plugin delivery sends no request, so the one link is to the log; it sits in the actions slot.
    expect(result.textContent).not.toContain(HOOKS_COPY.editor.webhook.seePayload);
    expectOneLogLink(result);
    expect(stub?.callsTo('bureau.hooks.test')).toHaveLength(1);
    expect(stub?.callsTo('bureau.hooks.test')[0]?.params).toEqual({ hookId: 'pager-hook' });
    expect(stub?.callsTo('bureau.hooks.draft.test')).toHaveLength(0);
  });

  test('draws a failed test as a danger Alert, without repeating the plugin’s text, with a link to the log', async () => {
    const view = open('/hooks/pager-hook', {
      'bureau.hooks.get': () => PAGER_HOOK,
      'bureau.plugins.contributions': TESTABLE,
      'bureau.hooks.test': () => testDelivery('exhausted'),
    });
    const test = await testButton(view);
    await waitFor(() => expect(test.getAttribute('aria-disabled')).toBeNull());
    await fireEvent.click(test);
    const result = await view.findByTestId('hook-test-result');
    expect(result.textContent).toContain('Test failed. The action couldn’t check the event.');
    expect(result.textContent).not.toContain('The pager is down');
    expect(result.textContent).not.toMatch(/dry run/i);
    expect(alertOf(result)?.getAttribute('data-cinder-variant')).toBe('danger');
    expectOneLogLink(result);
  });

  test('draws a test that is waiting as a warning, not a failure', async () => {
    const view = open('/hooks/pager-hook', {
      'bureau.hooks.get': () => PAGER_HOOK,
      'bureau.plugins.contributions': TESTABLE,
      'bureau.hooks.test': () => ({
        ...testDelivery('delivered'),
        status: 'pending',
        attempts: [],
      }),
    });
    const test = await testButton(view);
    await waitFor(() => expect(test.getAttribute('aria-disabled')).toBeNull());
    await fireEvent.click(test);
    const result = await view.findByTestId('hook-test-result');
    expect(result.textContent).toContain('Pager needs setup before this test can run.');
    expect(alertOf(result)?.getAttribute('data-cinder-variant')).toBe('warning');
    expectOneLogLink(result);
  });

  test('says the plugin needs setup, as a warning and in the editor’s words, when the Bureau refuses the test for it', async () => {
    const view = open('/hooks/pager-hook', {
      'bureau.hooks.get': () => PAGER_HOOK,
      'bureau.plugins.contributions': TESTABLE,
      'bureau.hooks.test': () => {
        throw new StubFault(
          'InvalidParams',
          400,
          'The plugin "pager" needs setup, so its hook action kind cannot be tested yet',
          { issues: [{ path: ['action'], message: 'needs setup', code: 'custom' }] },
        );
      },
    });
    const test = await testButton(view);
    await waitFor(() => expect(test.getAttribute('aria-disabled')).toBeNull());
    await fireEvent.click(test);
    const result = await view.findByTestId('hook-test-result');
    expect(result.textContent).toContain('Pager needs setup before this action can be tested.');
    expect(result.textContent).not.toContain('hook action kind');
    expect(alertOf(result)?.getAttribute('data-cinder-variant')).toBe('warning');
    // Nothing to read in the log, so no link and no actions box.
    expect(result.querySelector('.cinder-alert__actions')).toBeNull();
  });

  test('draws a test the Bureau could not answer as a danger Alert with no actions box', async () => {
    const view = open('/hooks/pager-hook', {
      'bureau.hooks.get': () => PAGER_HOOK,
      'bureau.plugins.contributions': TESTABLE,
      'bureau.hooks.test': () => {
        throw new StubFault('InternalError', 500, 'The Bureau fell over.');
      },
    });
    const test = await testButton(view);
    await waitFor(() => expect(test.getAttribute('aria-disabled')).toBeNull());
    await fireEvent.click(test);
    const result = await view.findByTestId('hook-test-result');
    expect(result.textContent).toContain(copy.testFailed);
    expect(alertOf(result)?.getAttribute('data-cinder-variant')).toBe('danger');
    expect(result.querySelector('.cinder-alert__actions')).toBeNull();
  });

  test('says a reaction that cannot be tested would do its work for real', async () => {
    const view = open('/hooks/pager-hook', { 'bureau.hooks.get': () => PAGER_HOOK });
    // R10-19: exactly this sentence.
    await expectOff(view, 'This action would do what it does for real, so it has no test.');
    expect(view.queryByText(/dry run/i)).toBeNull();
  });

  test('says to turn the plugin on when it is off or not listed', async () => {
    const view = open('/hooks/pager-hook', {
      'bureau.hooks.get': () => PAGER_HOOK,
      'bureau.plugins.contributions': () => ({ triggers: [], reactions: [] }),
    });
    await expectOff(view, 'Turn on Pager in Settings to test this action.');
  });

  test('says it could not check when the list of plugin actions failed to load', async () => {
    const view = open('/hooks/pager-hook', {
      'bureau.hooks.get': () => PAGER_HOOK,
      'bureau.plugins.contributions': () => {
        throw new Error('down');
      },
    });
    await expectOff(view, 'Couldn’t check whether this action can be tested.');
  });

  test('says to save first for a new hook whose action offers a test, and says a reaction without one would run for real', async () => {
    const offered = open('/hooks/new', { 'bureau.plugins.contributions': TESTABLE });
    await choosePluginAction(offered, 'Page');
    await expectOff(offered, 'Save hook, then send a test.');
    cleanup();
    stub?.restore();

    const refused = open('/hooks/new');
    await choosePluginAction(refused, 'Page');
    await expectOff(refused, 'This action would do what it does for real, so it has no test.');
    // The built-in sentence no longer claims that only a webhook is tested.
    expect(refused.queryByText(copy.testWebhookOnly)).toBeNull();
  });

  test('keeps a test delivery of a plugin action from reading as a missing payload in the log', async () => {
    const view = open('/hooks/pager-hook', {
      'bureau.hooks.get': () => PAGER_HOOK,
      'bureau.plugins.contributions': TESTABLE,
      'bureau.hooks.deliveries': () => ({ deliveries: [testDelivery('delivered')] }),
    });
    const log = await view.findByTestId('hook-deliveries');
    const item = await waitFor(() => {
      const found = log.querySelector<HTMLElement>('li[data-delivery="test-1"]');
      if (found === null) throw new Error('no delivery');
      return found;
    });
    await fireEvent.click(item.querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    const payload = await within(item).findByTestId('hook-delivery-payload');
    expect(payload.textContent).toBe(HOOKS_COPY.editor.deliveries.noPayloadTest);
    expect(payload.textContent).not.toContain('sent no payload');
  });

  test('shows a reaction’s receipt in the open delivery: its summary as text, its url as a link, its id as an identifier (COR-2182)', async () => {
    const withReceipt = testDelivery('delivered');
    withReceipt.attempts[0]!.receipt = {
      runId: null,
      notificationId: null,
      id: 'page-1',
      url: 'https://pager.example/incidents/1',
      summary: 'Paged the on-call team',
    } as never;
    const view = open('/hooks/pager-hook', {
      'bureau.hooks.get': () => PAGER_HOOK,
      'bureau.plugins.contributions': TESTABLE,
      'bureau.hooks.deliveries': () => ({ deliveries: [withReceipt] }),
    });
    const log = await view.findByTestId('hook-deliveries');
    const item = await waitFor(() => {
      const found = log.querySelector<HTMLElement>('li[data-delivery="test-1"]');
      if (found === null) throw new Error('no delivery');
      return found;
    });
    await fireEvent.click(item.querySelector<HTMLButtonElement>('button[aria-expanded]')!);

    const facts = await within(item).findByTestId('hook-delivery-facts');
    const facts_copy = HOOKS_COPY.editor.deliveries.facts;
    expect(within(facts).getByText('Paged the on-call team')).toBeTruthy();
    const link = within(facts).getByRole('link', { name: 'pager.example' });
    expect(link.getAttribute('href')).toBe('https://pager.example/incidents/1');
    expect(link.getAttribute('rel')).toContain('noopener');
    const reference = within(facts).getByText('page-1');
    expect(reference.tagName).toBe('CODE');
    expect(facts.textContent).toContain(facts_copy.made);
    expect(facts.textContent).toContain(facts_copy.link);
    expect(facts.textContent).toContain(facts_copy.reference);
  });

  test('shows no receipt facts for a delivery whose attempt made none', async () => {
    const view = open('/hooks/pager-hook', {
      'bureau.hooks.get': () => PAGER_HOOK,
      'bureau.plugins.contributions': TESTABLE,
      'bureau.hooks.deliveries': () => ({ deliveries: [testDelivery('delivered')] }),
    });
    const log = await view.findByTestId('hook-deliveries');
    const item = await waitFor(() => {
      const found = log.querySelector<HTMLElement>('li[data-delivery="test-1"]');
      if (found === null) throw new Error('no delivery');
      return found;
    });
    await fireEvent.click(item.querySelector<HTMLButtonElement>('button[aria-expanded]')!);

    const facts = await within(item).findByTestId('hook-delivery-facts');
    expect(facts.textContent).not.toContain(HOOKS_COPY.editor.deliveries.facts.made);
    expect(within(facts).queryByRole('link')).toBeNull();
  });
});

describe('an event in a hook’s deliveries', () => {
  test('shows its plain words and its raw kind, and never asks a formatter for a sentence', async () => {
    const view = open('/hooks/alpha', {
      'bureau.events.format': () => ({
        events: [
          { kind: 'review.requested', title: 'Someone asked for a review', formattedBy: 'x' },
        ],
      }),
    });
    const deliveries = await view.findByTestId('hook-deliveries');
    const kinds = await waitFor(() => {
      const found = within(deliveries).getAllByTestId('event-kind');
      expect(found.length).toBe(2);
      return found;
    });
    expect(kinds.map((element) => element.textContent)).toEqual([
      'review.requested',
      'schedule.missed',
    ]);
    expect(within(deliveries).getByText(eventOptionLabel('schedule.missed'))).toBeTruthy();
    expect(within(deliveries).queryByText('Someone asked for a review')).toBeNull();
    expect(stub?.callsTo('bureau.events.format')).toHaveLength(0);
  });
});
