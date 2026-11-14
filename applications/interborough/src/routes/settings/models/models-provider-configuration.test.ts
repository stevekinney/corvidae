/**
 * A provider plugin's configuration on `/settings/models` (COR-2148): the Connect and Manage
 * dialogs draw the schema the Bureau reports for the provider's plugin through
 * `contributed-configuration-form` and store it through `PUT /host/plugins/<plugin>`, the value
 * Settings › Plugins edits. The Bureau is a stub and both host routes are stand-ins.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { MODELS_COPY } from '../../../app/copy/models.ts';
import { PLUGINS_COPY } from '../../../app/copy/plugins.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import type { BureauStub } from '../../../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../../../lib/live-source/fetch.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import {
  installFakePluginHost,
  type FakePluginHost,
  type PluginFixture,
} from '../plugins/plugins-host.test-support.ts';
import { installSettingsBureau, servedSettings } from '../settings-fixtures.test-support.ts';
import { installFakeHost, model, type FakeHost } from './models-host.test-support.ts';

const KEY = 'sk-live-0123456789-never-print-this';

const OPENAI_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { baseURL: { type: 'string', description: 'Where the API is served.' } },
  additionalProperties: false,
};
const ANTHROPIC_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    models: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    baseURL: { type: 'string' },
  },
  additionalProperties: false,
};

let stub: BureauStub | undefined;
let host: FakeHost | undefined;
let pluginHost: FakePluginHost | undefined;
let restoreSpy: (() => void) | undefined;
/** Every write to the host, in the order it was made, across both routes. */
let order: string[] = [];

afterEach(() => {
  cleanup();
  restoreSpy?.();
  restoreSpy = undefined;
  pluginHost?.restore();
  pluginHost = undefined;
  host?.restore();
  host = undefined;
  stub?.restore();
  stub = undefined;
});

function open(
  options: {
    plugins?: PluginFixture[];
    /** What `bureau.plugins.contributions` reports for the providers. */
    providers?: { plugin: string; name: string; configuration: Record<string, unknown> | null }[];
    /** The providers that declare no secret, which the host reports connected with no key saved. */
    keyless?: string[];
    /** The address the page is opened at; `/settings/models` unless given. */
    at?: string;
  } = {},
) {
  order = [];
  stub = installSettingsBureau(servedSettings(), {
    'bureau.agents.catalog': () => ({ models: [], tools: [] }),
    'bureau.plugins.contributions': () => ({
      providers: options.providers ?? [
        { plugin: 'openai', name: 'openai', configuration: OPENAI_SCHEMA },
        { plugin: 'anthropic', name: 'anthropic', configuration: ANTHROPIC_SCHEMA },
      ],
      triggers: [],
      reactions: [],
    }),
  });
  host = installFakeHost({
    keys: { anthropic: true, openai: false, gemini: false },
    ...(options.keyless === undefined ? {} : { keyless: options.keyless }),
    offered: {
      anthropic: [model('anthropic', 'claude-sonnet-5')],
      openai: [model('openai', 'gpt-5')],
      gemini: [],
      ollama: [model('ollama', 'llama-3')],
    },
  });
  pluginHost = installFakePluginHost(
    options.plugins ?? [
      { name: 'openai', title: 'OpenAI', configurationSchema: OPENAI_SCHEMA },
      {
        name: 'anthropic',
        title: 'Anthropic',
        configurationSchema: ANTHROPIC_SCHEMA,
        configuration: { models: ['claude-sonnet-5'], keptOnSave: 'stays' },
      },
    ],
  );
  const underneath = globalThis.fetch;
  restoreSpy = installFetchImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = new URL(url, 'http://localhost').pathname;
    if (method !== 'GET' && path.startsWith('/host/') && !path.endsWith('/test')) {
      order.push(`${method} ${path}`);
    }
    return underneath(input, init);
  });
  landAt(options.at ?? '/settings/models');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const providerOf = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`[data-provider="${name}"]`);
const dialogOf = (container: HTMLElement) =>
  within(container.ownerDocument.body).findByRole('dialog');
const pluginWrites = () => (pluginHost?.requests ?? []).filter((r) => r.method !== 'GET');
const keyWrites = () =>
  (host?.requests ?? []).filter((r) => r.method === 'PUT' && r.path.startsWith('/host/providers'));

async function loaded(container: HTMLElement) {
  await waitFor(() => expect(providerOf(container, 'anthropic')).not.toBeNull());
}

/** Opens Connect for OpenAI and waits for its settings to be drawn. */
async function beginConnect(container: HTMLElement) {
  await fireEvent.click(
    within(providerOf(container, 'openai')!).getByRole('button', { name: /^Connect/ }),
  );
  const dialog = await dialogOf(container);
  await waitFor(() => expect(within(dialog).getByTestId('provider-configuration')).toBeDefined());
  return dialog;
}

/** Opens Manage for Anthropic and waits for its settings to be drawn. */
async function beginManage(container: HTMLElement) {
  await fireEvent.click(
    within(providerOf(container, 'anthropic')!).getByRole('button', { name: /^Manage/ }),
  );
  const dialog = await dialogOf(container);
  await waitFor(() => expect(within(dialog).getByTestId('provider-configuration')).toBeDefined());
  return dialog;
}

const baseUrlField = (dialog: HTMLElement) =>
  within(dialog).getByLabelText(/base ?url/i) as HTMLInputElement;

describe('connecting a provider whose plugin has settings', () => {
  const copy = MODELS_COPY.connectDialog;

  test('draws the plugin’s fields below the key, outside the key form, with no submit button of their own', async () => {
    const { container } = open();
    await loaded(container);

    const dialog = await beginConnect(container);

    const key = within(dialog).getByLabelText(copy.keyLabel);
    expect(baseUrlField(dialog)).toBeDefined();
    expect(
      key.compareDocumentPosition(baseUrlField(dialog)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('heading', { name: MODELS_COPY.configuration.heading }),
    ).toBeDefined();
    expect(dialog.querySelector('form form')).toBeNull();
    expect(dialog.querySelector('.cinder-schema-form__submit')).toBeNull();
    // The settings are not wrapped in a box of their own.
    expect(dialog.querySelector('[data-testid="provider-configuration"] .cinder-card')).toBeNull();
    expect(pluginWrites()).toEqual([]);
  });

  test('stores the settings, then the key, once the key has passed its test', async () => {
    const { container } = open();
    await loaded(container);
    const dialog = await beginConnect(container);

    await fireEvent.input(baseUrlField(dialog), { target: { value: 'http://localhost:1234/v1' } });
    await fireEvent.input(within(dialog).getByLabelText(copy.keyLabel), {
      target: { value: KEY },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: copy.connect }));

    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-connect-success')).toBeDefined(),
    );
    expect(pluginWrites()).toEqual([
      {
        method: 'PUT',
        path: '/host/plugins/openai',
        body: expect.objectContaining({ configuration: { baseURL: 'http://localhost:1234/v1' } }),
      },
    ]);
    expect(order).toEqual(['PUT /host/plugins/openai', 'PUT /host/providers/openai']);
  });

  test('stores nothing for the settings when they were not edited', async () => {
    const { container } = open();
    await loaded(container);
    const dialog = await beginConnect(container);

    await fireEvent.input(within(dialog).getByLabelText(copy.keyLabel), {
      target: { value: KEY },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: copy.connect }));

    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-connect-success')).toBeDefined(),
    );
    expect(pluginWrites()).toEqual([]);
    expect(order).toEqual(['PUT /host/providers/openai']);
  });

  test('shows a value the host refuses at its field, and saves neither the settings nor the key', async () => {
    const { container } = open();
    await loaded(container);
    const dialog = await beginConnect(container);
    pluginHost!.refuseNext = Response.json(
      { error: 'invalid', field: 'configuration.baseURL', message: 'baseURL must be a URL.' },
      { status: 400 },
    );

    await fireEvent.input(baseUrlField(dialog), { target: { value: 'not a url' } });
    await fireEvent.input(within(dialog).getByLabelText(copy.keyLabel), {
      target: { value: KEY },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: copy.connect }));

    await waitFor(() => expect(dialog.textContent).toContain('baseURL must be a URL.'));
    expect(baseUrlField(dialog).getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).queryByTestId('provider-connect-success')).toBeNull();
    expect(keyWrites()).toEqual([]);
    expect(pluginHost!.stored['openai']).toBeUndefined();
    // Fixing the value clears the refusal, and Connect goes through.
    await fireEvent.input(baseUrlField(dialog), { target: { value: 'http://localhost:1234' } });
    await fireEvent.click(within(dialog).getByRole('button', { name: copy.connect }));
    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-connect-success')).toBeDefined(),
    );
    expect(keyWrites()).toHaveLength(1);
  });

  test('says in a callout when the host answers a refusal that names no field', async () => {
    const { container } = open();
    await loaded(container);
    const dialog = await beginConnect(container);
    pluginHost!.refuseNext = Response.json({ error: 'failed', message: '' }, { status: 500 });

    await fireEvent.input(baseUrlField(dialog), { target: { value: 'http://localhost:1234' } });
    await fireEvent.input(within(dialog).getByLabelText(copy.keyLabel), {
      target: { value: KEY },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: copy.connect }));

    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-configuration-failed').textContent).toContain(
        PLUGINS_COPY.configuration.failed,
      ),
    );
    expect(keyWrites()).toEqual([]);
  });

  test('draws nothing for a plugin that takes no settings, and says so by name for one it cannot draw', async () => {
    const { container } = open({
      providers: [
        { plugin: 'openai', name: 'openai', configuration: { type: 'object', properties: {} } },
        { plugin: 'anthropic', name: 'anthropic', configuration: null },
      ],
    });
    await loaded(container);

    await fireEvent.click(
      within(providerOf(container, 'openai')!).getByRole('button', { name: /^Connect/ }),
    );
    const dialog = await dialogOf(container);
    await waitFor(() => expect(within(dialog).getByLabelText(copy.keyLabel)).toBeDefined());
    expect(within(dialog).queryByTestId('provider-configuration')).toBeNull();
    expect(
      within(dialog).queryByRole('heading', { name: MODELS_COPY.configuration.heading }),
    ).toBeNull();
    expect(dialog.textContent).not.toContain('takes no settings');
    expect(within(dialog).queryByTestId('provider-configuration-unavailable')).toBeNull();
    expect(pluginWrites()).toEqual([]);
  });

  test('says by name that the settings cannot be shown when the schema could not be written', async () => {
    const { container } = open({
      providers: [{ plugin: 'anthropic', name: 'anthropic', configuration: null }],
    });
    await loaded(container);

    await fireEvent.click(
      within(providerOf(container, 'anthropic')!).getByRole('button', { name: /^Manage/ }),
    );
    const dialog = await dialogOf(container);

    await waitFor(() =>
      expect(within(dialog).getByTestId('provider-configuration-unavailable').textContent).toBe(
        MODELS_COPY.configuration.unavailable('Anthropic'),
      ),
    );
    expect(dialog.textContent).not.toContain('this kind');
  });
});

describe('managing a provider whose plugin has settings', () => {
  const copy = MODELS_COPY.manageDialog;

  test('draws the stored settings and keeps Done while nothing changed, saving nothing', async () => {
    const { container } = open();
    await loaded(container);

    const dialog = await beginManage(container);

    // The form shows `models` as the stored allowlist; an empty list it would show is no change.
    expect(dialog.textContent).toContain('claude-sonnet-5');
    expect(within(dialog).getByRole('button', { name: copy.done })).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: copy.save })).toBeNull();
    expect(pluginWrites()).toEqual([]);
  });

  test('turns Done into Save when a field changes, stores the settings with the undrawn stored fields kept, and says when they apply', async () => {
    const { container } = open();
    await loaded(container);
    const dialog = await beginManage(container);

    await fireEvent.input(baseUrlField(dialog), { target: { value: 'https://proxy.example/v1' } });

    const save = await within(dialog).findByRole('button', { name: copy.save });
    expect(within(dialog).queryByRole('button', { name: copy.done })).toBeNull();
    await fireEvent.click(save);

    await waitFor(() => expect(pluginWrites()).toHaveLength(1));
    expect(pluginWrites()[0]?.path).toBe('/host/plugins/anthropic');
    expect(pluginWrites()[0]?.body).toMatchObject({
      configuration: {
        models: ['claude-sonnet-5'],
        baseURL: 'https://proxy.example/v1',
        keptOnSave: 'stays',
      },
    });
    await waitFor(() =>
      expect(container.ownerDocument.body.textContent).toContain(PLUGINS_COPY.configuration.saved),
    );
    // Stored, so the dialog is Done again, and still open.
    await within(dialog).findByRole('button', { name: copy.done });
    expect(within(dialog).queryByRole('button', { name: copy.save })).toBeNull();
    expect(keyWrites()).toEqual([]);
  });

  test('shows a refused value at its field, saves nothing and keeps Save for another try', async () => {
    const { container } = open();
    await loaded(container);
    const dialog = await beginManage(container);
    pluginHost!.refuseNext = Response.json(
      { error: 'invalid', field: 'configuration.baseURL', message: 'baseURL must be a URL.' },
      { status: 400 },
    );

    await fireEvent.input(baseUrlField(dialog), { target: { value: 'nope' } });
    await fireEvent.click(await within(dialog).findByRole('button', { name: copy.save }));

    await waitFor(() => expect(dialog.textContent).toContain('baseURL must be a URL.'));
    expect(pluginHost!.stored['anthropic']).toBeUndefined();
    expect(within(dialog).getByRole('button', { name: copy.save })).toBeDefined();
  });
});

describe('a keyless provider (COR-2414)', () => {
  const copy = MODELS_COPY.manageDialog;
  const OLLAMA_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { baseURL: { type: 'string' } },
    additionalProperties: false,
  };
  const ollamaPlugin: PluginFixture = {
    name: 'ollama',
    title: 'Ollama',
    configurationSchema: OLLAMA_SCHEMA,
    configuration: { baseURL: 'http://localhost:11434' },
  };
  const ollamaProvider = { plugin: 'ollama', name: 'ollama', configuration: OLLAMA_SCHEMA };

  test('reads as connected with its plugin’s name, and offers no Connect and no key action', async () => {
    const { container } = open({
      keyless: ['ollama'],
      providers: [ollamaProvider],
      plugins: [ollamaPlugin],
    });
    await waitFor(() => expect(providerOf(container, 'ollama')).not.toBeNull());
    const row = providerOf(container, 'ollama')!;

    await waitFor(() => expect(row.textContent).toContain('Ollama'));
    expect(row.textContent).toContain(MODELS_COPY.providers.connected);
    expect(within(row).queryByRole('button', { name: /^Connect/ })).toBeNull();
    // The page says a provider is connected, so it asks for no provider to be connected.
    expect(container.textContent).not.toContain(MODELS_COPY.providers.description);
    expect(container.textContent).toContain(MODELS_COPY.providers.connectedDescription);
  });

  test('lists its models in the catalog, which only a connected provider’s models are', async () => {
    const { container } = open({
      keyless: ['ollama'],
      providers: [ollamaProvider],
      plugins: [ollamaPlugin],
    });

    await waitFor(() =>
      expect(container.querySelector('[data-model="ollama/llama-3"]')).not.toBeNull(),
    );
  });

  test('has Manage for its settings, whose dialog holds them and no Remove key or Replace key', async () => {
    const { container } = open({
      keyless: ['ollama'],
      providers: [ollamaProvider],
      plugins: [ollamaPlugin],
    });
    await waitFor(() => expect(providerOf(container, 'ollama')).not.toBeNull());
    const manage = await within(providerOf(container, 'ollama')!).findByRole('button', {
      name: /^Manage/,
    });

    await fireEvent.click(manage);
    const dialog = await dialogOf(container);

    expect(within(dialog).getByRole('heading', { name: 'Ollama' })).toBeDefined();
    await waitFor(() => expect(baseUrlField(dialog).value).toBe('http://localhost:11434'));
    expect(within(dialog).queryByRole('button', { name: copy.removeKey })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: copy.replaceKey })).toBeNull();
    expect(within(dialog).getByRole('button', { name: copy.done })).toBeDefined();

    await fireEvent.input(baseUrlField(dialog), { target: { value: 'http://gpu-box:11434' } });
    await fireEvent.click(await within(dialog).findByRole('button', { name: copy.save }));
    await waitFor(() => expect(pluginWrites()).toHaveLength(1));
    expect(pluginWrites()[0]?.path).toBe('/host/plugins/ollama');
    expect(keyWrites()).toEqual([]);
  });

  test('shows only the Connected dot, with no button at all, when its plugin has no settings', async () => {
    const { container } = open({
      keyless: ['ollama'],
      providers: [
        { plugin: 'ollama', name: 'ollama', configuration: { type: 'object', properties: {} } },
      ],
      plugins: [{ name: 'ollama', title: 'Ollama' }],
    });
    await waitFor(() => expect(providerOf(container, 'ollama')).not.toBeNull());
    const row = providerOf(container, 'ollama')!;
    await waitFor(() => expect(row.textContent).toContain('Ollama'));

    expect(row.textContent).toContain(MODELS_COPY.providers.connected);
    expect(within(row).queryAllByRole('button')).toEqual([]);
  });

  test('counts as the connected provider that a page sent the person here to connect', async () => {
    const { container } = open({
      keyless: ['ollama'],
      providers: [ollamaProvider],
      plugins: [ollamaPlugin],
      at: '/settings/models?return=%2Fagents%2Fnew',
    });

    const notice = await within(container).findByTestId('models-return');
    await waitFor(() =>
      expect(notice.textContent).toContain(MODELS_COPY.returnNotice.connectedDescription),
    );
  });
});
