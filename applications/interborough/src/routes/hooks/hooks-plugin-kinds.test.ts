/**
 * COR-1893: a hook action kind a running plugin contributes is a choice under Then, and its
 * configuration is drawn from the schema the Bureau reports (`bureau.plugins.kinds`). An event in a
 * hook's deliveries shows the sentence a plugin's formatter writes for its kind
 * (`bureau.events.format`), and the raw kind when none claims it.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { PLUGIN_KINDS_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import { installBureauStub, type BureauStub } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';
import { HOOKS_COPY } from './hook-copy.ts';

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
    'bureau.plugins.kinds': () => ({ triggerKinds: [], hookActionKinds: [PAGE_KIND] }),
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

describe('a contributed hook action under Then', () => {
  test('is offered beside the built-in actions, and its schema fields render when chosen', async () => {
    const view = open('/hooks/new');
    const select = (await view.findByLabelText(
      HOOKS_COPY.editor.action.label,
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(4));
    expect([...select.options].map((option) => option.textContent?.trim())).toEqual([
      HOOKS_COPY.editor.action.webhook,
      HOOKS_COPY.editor.action.startWorkflow,
      HOOKS_COPY.editor.action.notify,
      PLUGIN_KINDS_COPY.hookAction('pager', 'page'),
    ]);

    await fireEvent.change(select, { target: { value: 'pager:page' } });
    await waitFor(() => expect(view.getByLabelText(/team/i)).toBeTruthy());
    expect(view.getByTestId('contributed-action').textContent).toContain(
      'Pages the on-call person.',
    );
    // The built-in webhook fields are gone.
    expect(view.queryByLabelText(HOOKS_COPY.editor.webhook.urlLabel)).toBeNull();
  });

  test('creates a hook with a plugin action holding the configuration typed into its fields', async () => {
    const view = open('/hooks/new');
    const select = (await view.findByLabelText(
      HOOKS_COPY.editor.action.label,
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(4));
    await chooseEvent(view, 'review', 'Review requested');
    await fireEvent.change(select, { target: { value: 'pager:page' } });
    await fireEvent.input(await waitFor(() => view.getByLabelText(/team/i)), {
      target: { value: 'ops' },
    });
    expect(view.getByTestId('hook-sentence').textContent).toContain(
      HOOKS_COPY.sentence.plugin('pager', 'page'),
    );

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.create }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.create').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.create')[0]?.params).toEqual({
      events: ['review.requested'],
      action: { type: 'plugin', plugin: 'pager', kind: 'page', configuration: { team: 'ops' } },
    });
    await waitFor(() => expect(router.pathname).toBe('/hooks/created'));
  });

  test('offers only the built-in actions when the host cannot say what plugins add', async () => {
    const view = open('/hooks/new', {
      'bureau.plugins.kinds': () => {
        throw new Error('down');
      },
    });
    const select = (await view.findByLabelText(
      HOOKS_COPY.editor.action.label,
    )) as HTMLSelectElement;
    await waitFor(() => expect(stub?.callsTo('bureau.plugins.kinds').length).toBe(1));
    expect(select.options.length).toBe(3);
  });
});

describe('an event in a hook’s deliveries', () => {
  test('shows the sentence a formatter writes for its kind, and the raw kind for one no formatter claims', async () => {
    const view = open('/hooks/alpha', {
      'bureau.events.format': (params) => ({
        events: (params['events'] as Array<{ kind: string }>).map(({ kind }) =>
          kind === 'review.requested'
            ? { kind, title: 'Someone asked for a review', formattedBy: 'inbox/reviews' }
            : { kind, title: kind },
        ),
      }),
    });
    const deliveries = await view.findByTestId('hook-deliveries');
    await within(deliveries).findByText('Someone asked for a review');
    const kinds = within(deliveries).getAllByTestId('event-kind');
    expect(kinds.map((element) => element.textContent)).toEqual(['schedule.missed']);
    // The plain words stay ahead of a raw kind, as the event picker has them.
    expect(within(deliveries).getByText('Schedule missed')).toBeTruthy();
  });

  test('names the plugin an event came from', async () => {
    const view = open('/hooks/alpha', {
      'bureau.events.format': (params) => ({
        events: (params['events'] as Array<{ kind: string }>).map(({ kind }) => ({
          kind,
          title: kind,
          source: 'inbox',
        })),
      }),
    });
    const deliveries = await view.findByTestId('hook-deliveries');
    const badges = await waitFor(() => {
      const found = within(deliveries).getAllByTestId('event-source');
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(badges[0]?.textContent?.trim()).toBe(PLUGIN_KINDS_COPY.fromPlugin('inbox'));
  });

  test('shows the raw kind when the Bureau cannot format events', async () => {
    const view = open('/hooks/alpha');
    const deliveries = await view.findByTestId('hook-deliveries');
    await waitFor(() => expect(stub?.callsTo('bureau.events.format').length).toBeGreaterThan(0));
    const kinds = within(deliveries).getAllByTestId('event-kind');
    expect(kinds.map((element) => element.textContent)).toEqual([
      'review.requested',
      'schedule.missed',
    ]);
  });
});
