/**
 * `/settings/models` (COR-1960): Providers, Models and Decisions on one page. The Bureau is a stub
 * (`../settings-fixtures.test-support.ts`) and the host's provider routes a stand-in
 * (`models-host.test-support.ts`); the real ones are exercised by `host-provider-changes.test.ts`
 * and the Playwright suite (`tests/e2e/models.spec.ts`).
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { MODELS_COPY, SETTINGS_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import type { BureauStub } from '../../../lib/bureau-stub.test-support.ts';
import { router } from '../../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import {
  installFakePluginHost,
  type FakePluginHost,
  type PluginFixture,
} from '../plugins/plugins-host.test-support.ts';
import {
  installSettingsBureau,
  servedSettings,
  type SettingsServed,
} from '../settings-fixtures.test-support.ts';
import { installFakeHost, model, type FakeHost } from './models-host.test-support.ts';

const KEY = 'sk-live-0123456789-never-print-this';
const SONNET = model('anthropic', 'claude-sonnet-5', { aliases: ['sonnet'] });
const HAIKU = model('anthropic', 'claude-haiku-4-5', { aliases: ['haiku'], images: true });
const GPT = model('openai', 'gpt-5', { tools: false, structuredOutput: false });

let stub: BureauStub | undefined;
let host: FakeHost | undefined;
let pluginHost: FakePluginHost | undefined;

afterEach(() => {
  cleanup();
  // Newest first: each stand-in restores the fetch it found.
  pluginHost?.restore();
  pluginHost = undefined;
  host?.restore();
  host = undefined;
  stub?.restore();
  stub = undefined;
});

function open(
  options: {
    keys?: Record<string, boolean>;
    catalog?: Parameters<typeof installFakeHost>[0]['catalog'];
    lockReason?: 'deployment';
    served?: SettingsServed;
    plugins?: PluginFixture[];
    /** The address the page is opened at; `/settings/models` unless given. */
    at?: string;
    /** The file agents the Bureau lists, by identifier, with the model each names. */
    agents?: Record<string, string>;
    /** Extra models an agent may be switched to, by identifier. */
    listedModels?: Record<string, string[]>;
    /** Makes the Bureau refuse to describe an agent, as when it does not answer. */
    agentsUnreadable?: boolean;
  } = {},
) {
  const agents = options.agents ?? {};
  stub = installSettingsBureau(options.served ?? servedSettings(), {
    'bureau.agents.catalog': () => ({ models: [], tools: [] }),
    'bureau.agents.list': () => ({
      agents: Object.keys(agents).map((name) => ({
        name,
        displayName: name,
        description: null,
        definitionRevision: 1,
        kind: 'file',
        a2a: false,
      })),
    }),
    'bureau.agents.definitions.get': (params) => {
      if (options.agentsUnreadable === true) throw new Error('The Bureau did not answer.');
      const id = String(params['id']);
      return {
        id,
        source: 'file',
        state: 'ready',
        name: id,
        description: null,
        a2a: false,
        hash: null,
        problem: null,
        definition: {
          name: id,
          description: null,
          a2a: false,
          model: agents[id] ?? '',
          models: options.listedModels?.[id] ?? null,
          tools: [],
          skillDescriptors: [],
          instructions: '',
        },
      };
    },
  });
  host = installFakeHost({
    keys: options.keys ?? { anthropic: true, openai: false, gemini: false },
    offered: { anthropic: [SONNET, HAIKU], openai: [GPT], gemini: [] },
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(options.lockReason === undefined ? {} : { lockReason: options.lockReason }),
  });
  if (options.plugins !== undefined) pluginHost = installFakePluginHost(options.plugins);
  landAt(options.at ?? '/settings/models');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const writes = () => (host?.requests ?? []).filter((request) => request.method !== 'GET');
const rowOf = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`[data-model="${name}"]`);
const providerOf = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`[data-provider="${name}"]`);

/** Everything the page shows or holds in a field, for a test that a value is nowhere on it. */
function everything(container: HTMLElement): string {
  const fields = [...container.ownerDocument.querySelectorAll('input, textarea')]
    .map((field) => (field as HTMLInputElement).value)
    .join('\n');
  return [
    container.ownerDocument.body.innerHTML,
    container.ownerDocument.body.textContent,
    fields,
  ].join('\n');
}

async function loaded(container: HTMLElement) {
  await waitFor(() => expect(providerOf(container, 'anthropic')).not.toBeNull());
}

describe('the page', () => {
  test('is one page of three sections with the section navigation, and no tabs', async () => {
    const { container, findByRole, queryAllByRole } = open();
    await loaded(container);
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    expect(
      [...container.querySelectorAll('h2')].map((heading) => heading.textContent?.trim()),
    ).toEqual([MODELS_COPY.providers.heading, MODELS_COPY.models.heading, 'Decisions']);
    expect(container.textContent).toContain(MODELS_COPY.intro);
    expect(queryAllByRole('tab')).toHaveLength(0);
    const current = container.querySelector('nav a[aria-current="page"]');
    expect(current?.textContent?.trim()).toBe('Models');
    expect(current?.getAttribute('href')).toBe('/settings/models');
  });

  test('draws no provider banner and no alert of its own while none is connected', async () => {
    const { container } = open({ keys: { anthropic: false, openai: false, gemini: false } });
    await loaded(container);

    expect(container.querySelector('.cinder-alert, .cinder-banner')).toBeNull();
    expect(container.textContent).toContain(MODELS_COPY.providers.description);
  });
});

describe('the providers', () => {
  test('are Anthropic, OpenAI and Gemini in that order, whatever order the host lists them in, with what their models are called', async () => {
    const { container } = open({ keys: { gemini: false, openai: false, anthropic: false } });
    await loaded(container);

    const rows = [...container.querySelectorAll<HTMLElement>('[data-provider]')];
    expect(rows.map((row) => row.dataset['provider'])).toEqual(['anthropic', 'openai', 'gemini']);
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Anthropic Claude models Connect',
      'OpenAI GPT models Connect',
      'Gemini Gemini models Connect',
    ]);
    // No letter avatars.
    expect(container.querySelector('[data-provider] .cinder-avatar')).toBeNull();
  });

  test('show a Connected dot and Manage for a provider with a key, and only Connect for one without', async () => {
    const { container } = open();
    await loaded(container);

    const connected = providerOf(container, 'anthropic');
    expect(connected?.textContent).toContain(MODELS_COPY.providers.connected);
    expect(within(connected!).getByRole('button', { name: /Manage/ })).toBeDefined();
    expect(within(connected!).queryByRole('button', { name: /Connect/ })).toBeNull();
    expect(within(connected!).queryByRole('button', { name: /Disconnect/ })).toBeNull();

    const unconnected = providerOf(container, 'openai');
    expect(within(unconnected!).getByRole('button', { name: /Connect/ })).toBeDefined();
    expect(within(unconnected!).queryByRole('button', { name: /Manage/ })).toBeNull();
    expect(unconnected?.textContent).not.toContain(MODELS_COPY.providers.connected);
    expect(container.textContent?.toLowerCase()).not.toContain('not connected');
  });

  test('describe themselves by whether one is connected', async () => {
    const none = open({ keys: { anthropic: false, openai: false, gemini: false } });
    await loaded(none.container);
    expect(none.container.textContent).toContain(MODELS_COPY.providers.description);
    expect(none.container.textContent).not.toContain(MODELS_COPY.providers.connectedDescription);
    cleanup();
    host?.restore();
    stub?.restore();

    const some = open();
    await loaded(some.container);
    expect(some.container.textContent).toContain(MODELS_COPY.providers.connectedDescription);
    expect(some.container.textContent).not.toContain(MODELS_COPY.providers.description);
  });

  test('do not badge a provider whose plugin needs setup: Connect is all an unconnected row shows', async () => {
    const { container } = open({
      plugins: [
        { name: 'anthropic', status: 'running' },
        { name: 'gemini', status: 'needs-setup' },
      ],
    });
    await loaded(container);

    const gemini = providerOf(container, 'gemini')!;
    expect(gemini.textContent).not.toMatch(/needs setup/i);
    expect(within(gemini).queryByRole('link')).toBeNull();
    expect(within(gemini).getByRole('button', { name: /Connect/ })).toBeDefined();
  });

  test('mark the controls that call a write, and none that only read', async () => {
    const { container } = open();
    await loaded(container);

    await fireEvent.click(within(providerOf(container, 'openai')!).getByRole('button'));
    const dialog = await within(container.ownerDocument.body).findByRole('dialog');
    expect(
      within(dialog)
        .getByRole('button', { name: MODELS_COPY.connectDialog.connect })
        .hasAttribute('data-changes'),
    ).toBe(true);
  });
});

describe('the models', () => {
  const table = (container: HTMLElement) => container.querySelector<HTMLElement>('table');
  const dataRows = (container: HTMLElement) => [
    ...container.querySelectorAll<HTMLElement>('tbody tr'),
  ];
  const cells = (row: HTMLElement) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim());

  test('are a table of Model, Abilities, Context and Allowed for the connected providers’ models', async () => {
    const { container } = open();
    await loaded(container);
    await waitFor(() => expect(table(container)).not.toBeNull());

    expect(
      [...table(container)!.querySelectorAll('th')].map((th) => th.textContent?.trim()),
    ).toEqual(['Model', 'Abilities', 'Context', 'Allowed']);
    expect(container.textContent).toContain(MODELS_COPY.models.description);
    expect(rowOf(container, 'openai/gpt-5')).toBeNull();
    expect(cells(rowOf(container, 'anthropic/claude-sonnet-5')!)).toEqual([
      'Claude Sonnet 5 claude-sonnet-5',
      'Tools',
      '200K',
      'Allowed',
    ]);
    expect(cells(rowOf(container, 'anthropic/claude-haiku-4-5')!)[1]).toBe('Tools · images');
  });

  test('set the identifier small and monospaced under the name, with a green dot for Allowed', async () => {
    const { container } = open();
    await loaded(container);
    await waitFor(() => expect(table(container)).not.toBeNull());

    const row = rowOf(container, 'anthropic/claude-sonnet-5')!;
    expect(row.querySelector('code')?.textContent).toBe('claude-sonnet-5');
    expect(row.querySelector('[data-layout="stacked"]')).not.toBeNull();
    expect(row.querySelector('[data-cinder-status="success"]')).not.toBeNull();
  });

  test('only read: no switch, no Edit, no Add a model and no Save, and nothing is written', async () => {
    const { container, queryByRole } = open();
    await loaded(container);
    await waitFor(() => expect(table(container)).not.toBeNull());

    expect(container.querySelectorAll('tbody [role="switch"], tbody button')).toHaveLength(0);
    expect(queryByRole('button', { name: /Add a model|Save models|Edit/ })).toBeNull();
    expect(writes()).toEqual([]);
  });

  test('read Not allowed for a model the policy denies, its provider denied, or the catalog turned off', async () => {
    const served = servedSettings();
    served.values['modelPolicy'] = {
      deployment: { deniedModels: ['claude-haiku-4-5'] },
      policyRevision: 2,
    };
    const { container } = open({
      served,
      catalog: [{ provider: 'anthropic', model: 'claude-sonnet-5', off: true }],
    });
    await loaded(container);
    await waitFor(() => expect(table(container)).not.toBeNull());

    expect(cells(rowOf(container, 'anthropic/claude-sonnet-5')!)[3]).toBe('Not allowed');
    expect(cells(rowOf(container, 'anthropic/claude-haiku-4-5')!)[3]).toBe('Not allowed');
    expect(
      rowOf(container, 'anthropic/claude-haiku-4-5')!
        .querySelector('[data-cinder-status]')
        ?.getAttribute('data-cinder-status'),
    ).toBe('neutral');
  });

  test('sort by model and by context when a header is pressed', async () => {
    const { container, getByRole } = open();
    await loaded(container);
    await waitFor(() => expect(table(container)).not.toBeNull());
    const order = () => dataRows(container).map((row) => row.dataset['model']);
    expect(order()).toEqual(['anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5']);

    await fireEvent.click(getByRole('button', { name: /^Model/ }));
    expect(order()).toEqual(['anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-5']);
    await fireEvent.click(getByRole('button', { name: /^Model/ }));
    expect(order()).toEqual(['anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5']);
  });

  test('are an empty state with no provider connected: a title, the reason and a quiet link up to Providers', async () => {
    const { container, findByRole } = open({
      keys: { anthropic: false, openai: false, gemini: false },
    });
    const empty = await findByRole('group', { name: MODELS_COPY.models.empty.title });

    expect(empty.textContent).toContain(MODELS_COPY.models.empty.description);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain(MODELS_COPY.models.emptyDescription);
    expect(container.textContent).not.toContain(MODELS_COPY.models.description);

    // A quiet link, not a primary button, and it goes to the Providers section of this page.
    expect(within(empty).queryByRole('button')).toBeNull();
    const link = within(empty).getByRole('link', { name: MODELS_COPY.models.empty.action });
    expect(link.getAttribute('href')).toBe('#ib-models-providers');
    await fireEvent.click(link);
    expect(container.ownerDocument.activeElement?.id).toBe('ib-models-providers');
    expect(router.pathname).toBe('/settings/models');
  });

  test('say they could not load right after a connect: the provider stays Connected and the error is in the catalog', async () => {
    const { container, findByTestId } = open();
    await loaded(container);

    await fireEvent.click(within(providerOf(container, 'openai')!).getByRole('button'));
    const dialog = await within(container.ownerDocument.body).findByRole('dialog');
    await fireEvent.input(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, {
      target: { value: KEY },
    });
    host!.readStatus = 503;
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MODELS_COPY.connectDialog.connect }),
    );

    const failed = await findByTestId('models-catalog-failed');
    expect(failed.textContent).toContain(MODELS_COPY.models.loadFailed.title);
    expect(failed.textContent).toContain('Anthropic and OpenAI are connected');
    expect(failed.textContent).toContain('(503)');
    expect(container.querySelector('table')).toBeNull();
    // The key was saved: the row reads Connected with Manage, and carries no error of its own.
    const row = providerOf(container, 'openai')!;
    expect(row.textContent).toContain(MODELS_COPY.providers.connected);
    expect(within(row).getByRole('button', { name: /Manage/ })).toBeDefined();
    expect(row.textContent).not.toContain('503');
    expect(container.querySelector('[data-testid="models-load-failed"]')).toBeNull();

    delete host!.readStatus;
    await fireEvent.click(
      within(failed).getByRole('button', { name: MODELS_COPY.models.loadFailed.retry }),
    );
    await waitFor(() => expect(rowOf(container, 'openai/gpt-5')).not.toBeNull());
    expect(container.querySelector('[data-testid="models-catalog-failed"]')).toBeNull();
  });

  test('word a failure without a connected provider or a status plainly', () => {
    const words = MODELS_COPY.models.loadFailed.description;
    expect(words(['Anthropic'], 503)).toBe(
      'Anthropic is connected, but its model list didn’t come back (503).',
    );
    expect(words(['Anthropic', 'OpenAI'], undefined)).toBe(
      'Anthropic and OpenAI are connected, but their model lists didn’t come back.',
    );
    expect(words([], 500)).toBe('The model list didn’t come back (500).');
  });
});

describe('the whole page failing to load', () => {
  test('says the providers are unavailable, with Try again, when the first read fails', async () => {
    const { container, findByTestId } = open();
    host!.readStatus = 500;
    const alert = await findByTestId('models-load-failed');

    expect(alert.textContent).toContain(MODELS_COPY.loadFailed.title);
    expect(container.querySelector('[data-testid="models-catalog-failed"]')).toBeNull();
    delete host!.readStatus;
    await fireEvent.click(within(alert).getByRole('button', { name: /Try again/ }));
    await loaded(container);
  });
});

describe('connecting a provider', () => {
  async function connect(container: HTMLElement, key: string) {
    await fireEvent.click(within(providerOf(container, 'openai')!).getByRole('button'));
    const dialog = await within(container.ownerDocument.body).findByRole('dialog');
    const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
    await fireEvent.input(field, { target: { value: key } });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MODELS_COPY.connectDialog.connect }),
    );
    return { dialog, field };
  }

  test('sends the key once, adds the provider’s models without a restart, and shows it connected', async () => {
    const { container } = open();
    await loaded(container);

    await connect(container, KEY);

    await waitFor(() => expect(rowOf(container, 'openai/gpt-5')).not.toBeNull());
    expect(writes()).toEqual([
      { method: 'PUT', path: '/host/providers/openai', body: { apiKey: KEY } },
    ]);
    expect(providerOf(container, 'openai')?.textContent).toContain(MODELS_COPY.providers.connected);
    expect(
      within(providerOf(container, 'openai')!).getByRole('button', { name: /Manage/ }),
    ).toBeDefined();
    // The agent editor’s choices are read again with the catalog.
    await waitFor(() =>
      expect(stub?.callsTo('bureau.agents.catalog').length).toBeGreaterThanOrEqual(1),
    );
  });

  test('never echoes the key after it is saved: not on the page, not in a field, not on reopening', async () => {
    const { container } = open();
    await loaded(container);

    await connect(container, KEY);
    await waitFor(() => expect(rowOf(container, 'openai/gpt-5')).not.toBeNull());

    expect(everything(container)).not.toContain(KEY);
    await fireEvent.click(
      within(providerOf(container, 'openai')!).getByRole('button', { name: /Manage/ }),
    );
    const dialog = await within(container.ownerDocument.body).findByRole('dialog');
    expect(dialog.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
    expect(everything(container)).not.toContain(KEY);
  });

  test('never echoes the key when the host refuses it, however the refusal is worded', async () => {
    const refusals = [
      Response.json(
        { error: 'invalid', field: 'apiKey', message: 'Invalid apiKey: expected a key.' },
        { status: 400 },
      ),
      Response.json({ error: 'invalid', field: 'apiKey', message: `Bad ${KEY}.` }, { status: 400 }),
      Response.json(
        { error: 'failed', message: 'The provider could not be changed.' },
        { status: 500 },
      ),
      new Response(`<html>${KEY}</html>`, { status: 502 }),
    ];
    for (const refusal of refusals) {
      const { container } = open();
      await loaded(container);
      host!.refuseNext = refusal;

      const { dialog, field } = await connect(container, KEY);

      await within(dialog).findByTestId('provider-connect-failure');
      expect(field.value).toBe('');
      expect(everything(container)).not.toContain(KEY);
      expect(rowOf(container, 'openai/gpt-5')).toBeNull();
      cleanup();
      host?.restore();
      stub?.restore();
    }
  });

  test('says the host keeps its keys itself when the host is locked, and sends nothing', async () => {
    const { container } = open({ lockReason: 'deployment' });
    await loaded(container);

    expect(container.querySelector('[data-testid="providers-locked"]')?.textContent).toContain(
      MODELS_COPY.locked,
    );
    const button = within(providerOf(container, 'openai')!).getByRole(
      'button',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  test('asks for the key before sending anything', async () => {
    const { container } = open();
    await loaded(container);
    await fireEvent.click(within(providerOf(container, 'openai')!).getByRole('button'));
    const dialog = await within(container.ownerDocument.body).findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MODELS_COPY.connectDialog.connect }),
    );
    expect(dialog.textContent).toContain(MODELS_COPY.connectDialog.keyRequired);
    expect(writes()).toEqual([]);
  });
});

describe('disconnecting a provider', () => {
  /** Opens Manage, presses Remove key, and returns the Disconnect dialog that follows. */
  async function ask(container: HTMLElement, name = 'anthropic') {
    await fireEvent.click(
      within(providerOf(container, name)!).getByRole('button', { name: /^Manage/ }),
    );
    const manage = await within(container.ownerDocument.body).findByRole('dialog');
    await fireEvent.click(
      within(manage).getByRole('button', { name: MODELS_COPY.connectDialog.removeKey }),
    );
    return waitFor(() => {
      const dialogs = within(container.ownerDocument.body).getAllByRole('dialog');
      const disconnect = dialogs.find((dialog) =>
        dialog.textContent?.includes(MODELS_COPY.disconnectDialog.confirm),
      );
      expect(disconnect).toBeDefined();
      return disconnect!;
    });
  }
  const confirm = (dialog: HTMLElement) =>
    within(dialog).getByRole('button', { name: MODELS_COPY.disconnectDialog.confirm });

  test('is offered as Remove key in Manage for a provider with a key, and not on the row or for one without', async () => {
    const { container } = open();
    await loaded(container);

    expect(
      within(providerOf(container, 'anthropic')!).queryByRole('button', { name: /^Disconnect/ }),
    ).toBeNull();
    await fireEvent.click(
      within(providerOf(container, 'anthropic')!).getByRole('button', { name: /^Manage/ }),
    );
    const manage = await within(container.ownerDocument.body).findByRole('dialog');
    expect(
      within(manage).getByRole('button', { name: MODELS_COPY.connectDialog.removeKey }),
    ).toBeDefined();
    await fireEvent.click(within(manage).getByRole('button', { name: /^Cancel/ }));

    await fireEvent.click(
      within(providerOf(container, 'openai')!).getByRole('button', { name: /^Connect/ }),
    );
    const connect = await within(container.ownerDocument.body).findByRole('dialog');
    expect(
      within(connect).queryByRole('button', { name: MODELS_COPY.connectDialog.removeKey }),
    ).toBeNull();
  });

  test('names the agents that use the provider’s models, then removes the key and the models with it', async () => {
    const { container } = open({
      agents: { writer: 'anthropic/claude-sonnet-5', helper: 'openai/gpt-5' },
    });
    await loaded(container);
    await waitFor(() => expect(rowOf(container, 'anthropic/claude-sonnet-5')).not.toBeNull());

    const dialog = await ask(container);
    const named = await within(dialog).findByTestId('provider-disconnect-agents');
    expect(named.textContent).toContain('writer');
    expect(named.textContent).not.toContain('helper');
    expect(named.textContent).toContain(
      MODELS_COPY.disconnectDialog.invalidHeading('Anthropic', 1),
    );
    expect(writes()).toEqual([]);

    await fireEvent.click(confirm(dialog));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'DELETE',
      path: '/host/providers/anthropic',
      body: undefined,
    });
    await waitFor(() =>
      expect(rowOf(container, 'anthropic/claude-sonnet-5')?.outerHTML ?? null).toBeNull(),
    );
    expect(providerOf(container, 'anthropic')?.textContent).not.toContain(
      MODELS_COPY.providers.connected,
    );
    expect(
      within(providerOf(container, 'anthropic')!).getByRole('button', { name: /^Connect/ }),
    ).toBeDefined();
    expect(container.ownerDocument.body.textContent).toContain(
      MODELS_COPY.disconnectDialog.toast('Anthropic'),
    );
    expect(everything(container)).not.toContain(KEY);
  });

  test('says so when no agent names one of the provider’s models', async () => {
    const { container } = open({ agents: { helper: 'openai/gpt-5' } });
    await loaded(container);

    const dialog = await ask(container);

    const none = await within(dialog).findByTestId('provider-disconnect-none');
    expect(none.textContent).toContain(MODELS_COPY.disconnectDialog.noAgents('Anthropic'));
    expect(within(dialog).queryByTestId('provider-disconnect-agents')).toBeNull();
  });

  test('separates agents that become invalid from agents that only lose listed models, and flags the embedder', async () => {
    const { container } = open({
      agents: { writer: 'anthropic/sonnet', switcher: 'openai/gpt-5' },
      listedModels: { switcher: ['anthropic/haiku'] },
    });
    await loaded(container);

    const dialog = await ask(container);

    const invalid = await within(dialog).findByTestId('provider-disconnect-invalid');
    expect(invalid.textContent).toContain('writer');
    expect(invalid.textContent).not.toContain('switcher');
    expect(invalid.textContent).toContain(MODELS_COPY.disconnectDialog.invalidConsequence);
    const trimmed = within(dialog).getByTestId('provider-disconnect-trimmed');
    expect(trimmed.textContent).toContain('switcher');
    expect(trimmed.textContent).toContain(MODELS_COPY.disconnectDialog.trimmedConsequence);
    expect(within(dialog).queryByTestId('provider-disconnect-embedder')).toBeNull();
  });

  test('says which agents are unknown when they cannot be read, and still lets the person disconnect', async () => {
    const { container } = open({ agents: { writer: 'anthropic/sonnet' }, agentsUnreadable: true });
    await loaded(container);

    const dialog = await ask(container);

    const unknown = await within(dialog).findByTestId('provider-disconnect-unknown');
    expect(unknown.textContent).toContain(MODELS_COPY.disconnectDialog.agentsUnknown('Anthropic'));
    await waitFor(() => expect((confirm(dialog) as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(confirm(dialog));
    await waitFor(() => expect(writes()).toHaveLength(1));
  });

  test('holds the confirm button until the agents have been read, and sends nothing on Cancel', async () => {
    const { container } = open({ agents: { writer: 'anthropic/sonnet' } });
    await loaded(container);

    const dialog = await ask(container);
    expect((confirm(dialog) as HTMLButtonElement).disabled).toBe(true);
    await within(dialog).findByTestId('provider-disconnect-agents');
    expect((confirm(dialog) as HTMLButtonElement).disabled).toBe(false);
    expect(confirm(dialog).hasAttribute('data-changes')).toBe(true);

    await fireEvent.click(
      within(dialog).getByRole('button', { name: MODELS_COPY.disconnectDialog.cancel }),
    );

    expect(writes()).toEqual([]);
    expect(providerOf(container, 'anthropic')?.textContent).toContain(
      MODELS_COPY.providers.connected,
    );
  });

  test('keeps the dialog open and says the key was not removed when the host refuses', async () => {
    const { container } = open();
    await loaded(container);
    const dialog = await ask(container);
    await within(dialog).findByTestId('provider-disconnect-none');
    host!.refuseNext = Response.json({ error: 'failed', message: '' }, { status: 500 });

    await fireEvent.click(confirm(dialog));

    const failure = await within(dialog).findByTestId('provider-disconnect-failure');
    expect(failure.textContent).toContain(MODELS_COPY.disconnectDialog.failed);
    expect(providerOf(container, 'anthropic')?.textContent).toContain(
      MODELS_COPY.providers.connected,
    );
  });

  test('is held when the host keeps its keys in its deployment', async () => {
    const { container } = open({ lockReason: 'deployment' });
    await loaded(container);

    const button = within(providerOf(container, 'anthropic')!).getByRole('button', {
      name: /^Manage/,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(writes()).toEqual([]);
  });
});

describe('the decisions', () => {
  const row = (container: HTMLElement, key: string) =>
    container.querySelector<HTMLElement>(`[data-setting="${key}"]`);

  test('are the decision model, its fallback and its limit per task, and nothing else of Settings', async () => {
    const { container, findByRole } = open();
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    expect(
      [...container.querySelectorAll<HTMLElement>('[data-setting]')].map(
        (entry) => entry.dataset['setting'],
      ),
    ).toEqual(['decisions.model', 'decisions.fallbackModel', 'decisions.maximumPerTask']);
    expect(container.textContent).toContain(MODELS_COPY.decisions.description);
  });

  test('wait for TypeSafe while its plugin has no key: Connect TypeSafe, a disabled fallback and a disabled limit', async () => {
    const { container, findByRole } = open({
      plugins: [{ name: 'typesafe', status: 'needs-setup' }],
    });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await waitFor(() => expect(row(container, 'decisions.model')?.dataset['waiting']).toBe('true'));

    const model = row(container, 'decisions.model')!;
    expect(model.textContent).toContain('Decision model');
    expect(model.textContent).toContain('decisions.model');
    expect(model.textContent).toContain(MODELS_COPY.decisions.model.description);
    const connect = within(model).getByRole('link', { name: MODELS_COPY.decisions.model.connect });
    expect(connect.getAttribute('href')).toBe('/settings/plugins?plugin=typesafe');

    const fallback = row(container, 'decisions.fallbackModel')!;
    expect(fallback.textContent).toContain(MODELS_COPY.decisions.fallbackModel.description);
    const select = fallback.querySelector('select')!;
    expect(select.disabled).toBe(true);
    expect(select.selectedOptions[0]?.textContent).toBe(
      MODELS_COPY.decisions.fallbackModel.connectFirst,
    );

    const limit = row(container, 'decisions.maximumPerTask')!;
    expect(limit.textContent).toContain(MODELS_COPY.decisions.maximumPerTask.connectFirst);
    const field = limit.querySelector('input')!;
    expect(field.disabled).toBe(true);
    expect(field.value).toBe('20');
  });

  test('are ordinary settings that save as they are left once TypeSafe has its key', async () => {
    const served = servedSettings();
    const { container, findByRole } = open({
      served,
      plugins: [{ name: 'typesafe', status: 'running' }],
    });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const select = row(container, 'decisions.model')!.querySelector('select')!;
    expect([...select.options].map((option) => option.value)).toContain('typesafe:jev');
    expect(row(container, 'decisions.model')?.dataset['waiting']).toBeUndefined();
    expect(row(container, 'decisions.model')?.textContent).toContain(
      MODELS_COPY.decisions.model.description,
    );
    expect(row(container, 'decisions.model')?.textContent).toContain(
      MODELS_COPY.decisions.model.label,
    );
    expect(row(container, 'decisions.maximumPerTask')?.textContent).toContain(
      MODELS_COPY.decisions.maximumPerTask.label,
    );

    await fireEvent.change(select, { target: { value: 'typesafe:jev' } });

    await waitFor(() => expect(stub?.callsTo('bureau.settings.update')).toHaveLength(1));
    expect(stub?.callsTo('bureau.settings.update')[0]?.params['patch']).toEqual({
      'decisions.model': 'typesafe:jev',
    });
    expect(served.values['decisions.model']).toBe('typesafe:jev');
    // There is no page-level Save.
    expect(container.textContent).not.toContain(SETTINGS_COPY.saveAction);
  });

  test('keep the person’s own choice when it is the chat model fallback, whatever TypeSafe’s plugin says', async () => {
    const served = servedSettings();
    served.values['decisions.model'] = 'catalog';
    const { container, findByRole } = open({
      served,
      plugins: [{ name: 'typesafe', status: 'needs-setup' }],
    });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    const select = row(container, 'decisions.model')!.querySelector('select')!;
    expect(select.value).toBe('catalog');
    expect(row(container, 'decisions.model')?.dataset['waiting']).toBeUndefined();
  });
});

describe('a way back from connecting a provider', () => {
  test('is offered when a page that needs a provider sent the person here, and goes back to that page', async () => {
    const { container, findByTestId, findByRole } = open({
      keys: { anthropic: true, openai: false, gemini: false },
      at: '/settings/models?return=%2Fagents%2Fnew',
    });
    await loaded(container);

    const notice = await findByTestId('models-return');
    expect(notice.textContent).toContain(MODELS_COPY.returnNotice.title);
    // A provider already holds a key, so the notice says to go back.
    expect(notice.textContent).toContain(MODELS_COPY.returnNotice.connectedDescription);
    await fireEvent.click(await findByRole('link', { name: MODELS_COPY.returnNotice.action }));

    expect(router.pathname).toBe('/agents/new');
  });

  test('asks for a key first while no provider holds one', async () => {
    const { container, findByTestId } = open({
      keys: { anthropic: false, openai: false, gemini: false },
      at: '/settings/models?return=%2Fagents%2Fnew',
    });
    await loaded(container);

    const notice = await findByTestId('models-return');
    expect(notice.textContent).toContain(MODELS_COPY.returnNotice.description);
  });

  test('is not offered for an address that is not a page made to be returned to', async () => {
    for (const target of [
      'https://example.com/',
      '//example.com/agents/new',
      '/health',
      '/agents/new?x=1',
    ]) {
      const { container, queryByTestId, unmount } = open({
        at: `/settings/models?return=${encodeURIComponent(target)}`,
      });
      await loaded(container);

      expect(queryByTestId('models-return'), target).toBeNull();
      unmount();
      cleanup();
      host?.restore();
      stub?.restore();
    }
  });

  test('is not offered on a visit with no return address', async () => {
    const { container, queryByTestId } = open();
    await loaded(container);

    expect(queryByTestId('models-return')).toBeNull();
  });
});
