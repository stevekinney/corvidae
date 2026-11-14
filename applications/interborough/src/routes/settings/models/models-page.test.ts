/**
 * `/settings/models` (COR-1960): Providers, Models and Decisions on one page. The Bureau is a stub
 * (`../settings-fixtures.test-support.ts`) and the host's provider routes a stand-in
 * (`models-host.test-support.ts`); the real ones are exercised by `host-provider-changes.test.ts`
 * and the Playwright suite (`tests/e2e/models.spec.ts`).
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { MODELS_COPY } from '../../../app/copy/models.ts';
import { SETTINGS_COPY } from '../../../app/copy/settings.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import {
  catalogModelFixture,
  type BureauStub,
  type CatalogModelFixture,
} from '../../../lib/bureau-stub.test-support.ts';
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
import { maskedKey } from './format-model.ts';
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
    /** The rows the Bureau's agent catalog holds, which the decision selects offer. */
    agentCatalog?: readonly CatalogModelFixture[];
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
    'bureau.agents.catalog': () => ({
      models: (options.agentCatalog ?? []).map(catalogModelFixture),
      tools: [],
    }),
    'bureau.decisions.models': () => ({ rows: [] }),
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
          card: [],
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
    expect(cells(rowOf(container, 'anthropic/claude-haiku-4-5')!)[1]).toBe('Tools, images');
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
    host!.readStatusAfterWrite = 503;
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

    delete host!.readStatusAfterWrite;
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

/** The page's text and markup, without what is typed into a field, for a test that a key is not printed. */
function printed(container: HTMLElement): string {
  return `${container.ownerDocument.body.innerHTML}\n${container.ownerDocument.body.textContent}`;
}

const dialogOf = (container: HTMLElement) =>
  within(container.ownerDocument.body).findByRole('dialog');
const posts = () => (host?.requests ?? []).filter((request) => request.method === 'POST');

describe('connecting a provider', () => {
  const copy = MODELS_COPY.connectDialog;

  /** Presses Connect on a provider's row and returns the dialog and its field. */
  async function begin(container: HTMLElement, name = 'openai') {
    await fireEvent.click(within(providerOf(container, name)!).getByRole('button'));
    const dialog = await dialogOf(container);
    const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
    return { dialog, field };
  }
  const press = (dialog: HTMLElement, name: string) =>
    fireEvent.click(within(dialog).getByRole('button', { name }));

  async function connect(container: HTMLElement, key: string) {
    const opened = await begin(container);
    await fireEvent.input(opened.field, { target: { value: key } });
    await press(opened.dialog, copy.connect);
    return opened;
  }

  test('opens empty: a subtitle, a required API key field, the help line with its link, and Cancel, Test and Connect', async () => {
    const { container } = open();
    await loaded(container);

    const { dialog, field } = await begin(container);

    expect(within(dialog).getByRole('heading', { name: copy.title('OpenAI') })).toBeDefined();
    expect(dialog.textContent).toContain(copy.subtitle.idle);
    expect(dialog.getAttribute('aria-describedby')).not.toBeNull();
    expect(within(dialog).getByLabelText(copy.keyLabel)).toBe(field);
    expect(field.value).toBe('');
    expect(field.placeholder).toBe(copy.keyPlaceholder);
    expect(dialog.querySelector('.cinder-_required-marker')).not.toBeNull();
    expect(dialog.textContent).toContain(copy.keyHelp);
    const link = within(dialog).getByRole('link', { name: copy.getKey });
    expect(link.getAttribute('href')).toBe('https://platform.openai.com/api-keys');
    expect(link.getAttribute('target')).toBe('_blank');
    // Connect is always enabled, Test is the optional secondary, and Test comes before Connect.
    const labels = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim())
      .filter((label) => label !== undefined && label !== '');
    expect(labels).toEqual([copy.cancel, copy.test, copy.connect]);
    expect(
      (within(dialog).getByRole('button', { name: copy.connect }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(writes()).toEqual([]);
  });

  test('tests the key first, then saves it, adds the models with no restart, and says Connected with a single Done', async () => {
    const { container } = open();
    await loaded(container);

    const { dialog } = await connect(container, KEY);

    await within(dialog).findByTestId('provider-connect-success');
    // The test came first and stored nothing; the save followed it.
    expect((host?.requests ?? []).filter((request) => request.method !== 'GET')).toEqual([
      { method: 'POST', path: '/host/providers/openai/test', body: { apiKey: KEY } },
      {
        method: 'PUT',
        path: '/host/providers/openai',
        body: {
          apiKey: KEY,
          operationId: expect.any(String),
          expectedRevision: JSON.stringify([{ anthropic: true, openai: false, gemini: false }, []]),
        },
      },
    ]);
    expect(dialog.textContent).toContain(copy.subtitle.connected);
    const banner = within(dialog).getByTestId('provider-connect-success');
    expect(banner.textContent).toContain(copy.connectedTitle);
    expect(banner.textContent).toContain(copy.models(1));
    expect(within(dialog).getByTestId('provider-connect-result').getAttribute('role')).toBe(
      'status',
    );
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim())
      .filter((label) => label !== undefined && label !== '');
    expect(buttons).toContain(copy.done);
    expect(buttons).not.toContain(copy.cancel);
    expect(buttons).not.toContain(copy.test);
    expect(buttons).not.toContain(copy.connect);
    // The field shows a masked key, never the one that was typed.
    const masked = dialog.querySelector<HTMLInputElement>('input');
    expect(masked?.disabled).toBe(true);
    expect(masked?.value.startsWith('sk-')).toBe(true);
    expect(masked?.value).not.toContain(KEY);

    await waitFor(() => expect(rowOf(container, 'openai/gpt-5')).not.toBeNull());
    expect(providerOf(container, 'openai')?.textContent).toContain(MODELS_COPY.providers.connected);
    expect(
      within(providerOf(container, 'openai')!).getByRole('button', { name: /Manage/ }),
    ).toBeDefined();
    // The rows that can answer decisions are read again: the provider's rows needed setup until
    // its key was saved. (The agent editor's choices are marked stale too, and read when it opens.)
    await waitFor(() =>
      expect(stub?.callsTo('bureau.decisions.models').length).toBeGreaterThanOrEqual(2),
    );

    await press(dialog, copy.done);
    await waitFor(() =>
      expect(container.ownerDocument.querySelector('dialog[open]')?.outerHTML ?? null).toBeNull(),
    );
    expect(printed(container)).not.toContain(KEY);
  });

  test('shows the test running: the subtitle, the masked field, a status with a spinner, a disabled Testing… and an enabled Cancel', async () => {
    const { container } = open();
    await loaded(container);
    host!.holdTests = true;

    const { dialog, field } = await connect(container, KEY);

    await waitFor(() => expect(dialog.textContent).toContain(copy.subtitle.testing));
    // The field shows the key's masked form while it is tested, never the key.
    expect(field.value).toBe(maskedKey('openai'));
    expect(field.value).not.toContain(KEY);
    expect(field.readOnly).toBe(true);
    expect(dialog.textContent).toContain(copy.testing);
    expect(
      dialog.querySelector('.cinder-inline-loading [role="status"], .cinder-spinner'),
    ).not.toBeNull();
    const primary = within(dialog).getByRole('button', { name: copy.connecting });
    expect((primary as HTMLButtonElement).disabled).toBe(true);
    expect(
      (within(dialog).getByRole('button', { name: copy.cancel }) as HTMLButtonElement).disabled,
    ).toBe(false);
    // Nothing is saved while the provider is being asked.
    expect(writes().filter((request) => request.method === 'PUT')).toEqual([]);

    host!.heldTests.splice(0).forEach((release) => release());
    await within(dialog).findByTestId('provider-connect-success');
  });

  test('stops at Cancel while the test runs: the key is not saved, even if the provider answers afterwards', async () => {
    const { container } = open();
    await loaded(container);
    host!.holdTests = true;
    const { dialog } = await connect(container, KEY);
    await waitFor(() => expect(host?.heldTests).toHaveLength(1));

    await press(dialog, copy.cancel);
    host!.heldTests.splice(0).forEach((release) => release());
    await waitFor(() =>
      expect(container.ownerDocument.querySelector('dialog[open]')?.outerHTML ?? null).toBeNull(),
    );

    expect(writes().filter((request) => request.method === 'PUT')).toEqual([]);
    expect(providerOf(container, 'openai')?.textContent).not.toContain(
      MODELS_COPY.providers.connected,
    );
    // Opening it again starts empty.
    const again = await begin(container);
    expect(again.field.value).toBe('');
    expect(again.dialog.textContent).toContain(copy.subtitle.idle);
  });

  test('puts a refused key at the field with the status and what to do, keeps Cancel, Test and Connect enabled, and saves nothing', async () => {
    const { container } = open();
    await loaded(container);
    const refused = `${KEY}-rejected-key`;

    const { dialog, field } = await connect(container, refused);

    await waitFor(() => expect(dialog.textContent).toContain(copy.subtitle.failed));
    expect(dialog.textContent).toContain(MODELS_COPY.keyTest.rejected('OpenAI', 401));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    // The refused key stays masked until the person goes back into the field to change it.
    expect(field.value).toBe(maskedKey('openai'));
    await fireEvent.focus(field);
    expect(field.type).toBe('password');
    expect(field.value).toBe(refused);
    for (const name of [copy.cancel, copy.test, copy.connect]) {
      expect(
        (within(dialog).getByRole('button', { name }) as HTMLButtonElement).disabled,
        name,
      ).toBe(false);
    }
    expect(writes().filter((request) => request.method === 'PUT')).toEqual([]);
    expect(dialog.textContent).not.toContain(refused);

    // Typing again takes the refusal away.
    await fireEvent.input(field, { target: { value: KEY } });
    expect(dialog.textContent).toContain(copy.subtitle.idle);
    expect(dialog.textContent).not.toContain(MODELS_COPY.keyTest.rejected('OpenAI', 401));
    expect(
      field.hasAttribute('aria-invalid') && field.getAttribute('aria-invalid') === 'true',
    ).toBe(false);
  });

  test('words a test that could not finish without blaming the key', async () => {
    const { container } = open();
    await loaded(container);
    const opened = await begin(container);
    host!.testAnswer = { ok: false, status: 503 };

    await fireEvent.input(opened.field, { target: { value: KEY } });
    await press(opened.dialog, copy.test);

    await waitFor(() =>
      expect(opened.dialog.textContent).toContain(MODELS_COPY.keyTest.unfinished('OpenAI', 503)),
    );
    expect(opened.dialog.textContent).not.toContain(MODELS_COPY.keyTest.rejected('OpenAI', 503));
  });

  test('Test only asks: a passing test says the key works and saves nothing, and Connect then saves without testing again', async () => {
    const { container } = open();
    await loaded(container);
    const { dialog, field } = await begin(container);

    await fireEvent.input(field, { target: { value: KEY } });
    await press(dialog, copy.test);

    const banner = await within(dialog).findByTestId('provider-connect-success');
    expect(banner.textContent).toContain(copy.testedTitle);
    expect(dialog.textContent).toContain(copy.subtitle.tested);
    expect(writes()).toEqual([
      { method: 'POST', path: '/host/providers/openai/test', body: { apiKey: KEY } },
    ]);
    expect(within(dialog).getByRole('button', { name: copy.connect })).toBeDefined();

    await press(dialog, copy.connect);

    await waitFor(() => expect(dialog.textContent).toContain(copy.subtitle.connected));
    expect(posts()).toHaveLength(1);
    expect(writes().filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  test('asks for the key before sending anything, at the field', async () => {
    const { container } = open();
    await loaded(container);
    const { dialog } = await begin(container);

    await press(dialog, copy.connect);

    expect(dialog.textContent).toContain(copy.keyRequired);
    expect(writes()).toEqual([]);
  });

  test('never prints the key after it is saved: not on the page, not in a field, not on reopening', async () => {
    const { container } = open();
    await loaded(container);

    const { dialog } = await connect(container, KEY);
    await within(dialog).findByTestId('provider-connect-success');
    await press(dialog, copy.done);
    await waitFor(() => expect(rowOf(container, 'openai/gpt-5')).not.toBeNull());

    expect(everything(container)).not.toContain(KEY);
    await fireEvent.click(
      within(providerOf(container, 'openai')!).getByRole('button', { name: /Manage/ }),
    );
    await dialogOf(container);
    expect(everything(container)).not.toContain(KEY);
  });

  test('never prints the key when the host refuses to save it, however the refusal is worded', async () => {
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

      const { dialog } = await connect(container, KEY);

      await within(dialog).findByTestId('provider-connect-failure');
      expect(dialog.textContent).toContain(copy.subtitle.saveFailed);
      expect(printed(container)).not.toContain(KEY);
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
});

describe('managing a connected provider', () => {
  const copy = MODELS_COPY.manageDialog;

  async function manage(container: HTMLElement, name = 'anthropic') {
    await fireEvent.click(
      within(providerOf(container, name)!).getByRole('button', { name: /^Manage/ }),
    );
    return dialogOf(container);
  }

  test('opens a dialog named for the provider: connected, how many models, Remove key, Replace key and a primary Done', async () => {
    const { container } = open();
    await loaded(container);

    const dialog = await manage(container);

    expect(within(dialog).getByRole('heading', { name: 'Anthropic' })).toBeDefined();
    // Said once, by the status: the dialog has no description to say it again.
    expect(dialog.textContent?.split(copy.connected)).toHaveLength(2);
    expect(within(dialog).getByTestId('provider-manage-body').textContent).toContain(
      copy.connected,
    );
    expect(within(dialog).getByTestId('provider-manage-body').textContent).toContain(
      copy.models(2),
    );
    expect(
      dialog.querySelector('[data-cinder-status="success"], .cinder-status-dot'),
    ).not.toBeNull();
    const labels = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim())
      .filter((label) => label !== undefined && label !== '');
    expect(labels).toEqual([copy.removeKey, copy.replaceKey, copy.done]);
    expect(
      within(dialog).getByRole('button', { name: copy.done }).getAttribute('data-cinder-variant'),
    ).toBe('primary');
    // The saved key is never shown again: there is no field.
    expect(dialog.querySelector('input')).toBeNull();
    expect(writes()).toEqual([]);

    await fireEvent.click(within(dialog).getByRole('button', { name: copy.done }));
    await waitFor(() =>
      expect(container.ownerDocument.querySelector('dialog[open]')?.outerHTML ?? null).toBeNull(),
    );
    expect(writes()).toEqual([]);
  });

  test('is offered on the row as Manage for a provider with a key, and not as Disconnect', async () => {
    const { container } = open();
    await loaded(container);

    expect(
      within(providerOf(container, 'anthropic')!).queryByRole('button', { name: /^Disconnect/ }),
    ).toBeNull();
    expect(
      within(providerOf(container, 'openai')!).queryByRole('button', { name: /^Manage/ }),
    ).toBeNull();
  });
});

describe('replacing a provider’s key', () => {
  const copy = MODELS_COPY.replaceDialog;

  async function replace(container: HTMLElement) {
    await fireEvent.click(
      within(providerOf(container, 'anthropic')!).getByRole('button', { name: /^Manage/ }),
    );
    const manage = await dialogOf(container);
    await fireEvent.click(
      within(manage).getByRole('button', { name: MODELS_COPY.manageDialog.replaceKey }),
    );
    const dialog = await waitFor(() => {
      const found = [...container.ownerDocument.querySelectorAll<HTMLElement>('dialog[open]')].find(
        (candidate) => candidate.textContent?.includes(copy.subtitle),
      );
      expect(found).toBeDefined();
      return found!;
    });
    return { dialog, field: dialog.querySelector<HTMLInputElement>('input[type="password"]')! };
  }

  test('opens with the old key staying in use, an empty New API key field and no required mark', async () => {
    const { container } = open();
    await loaded(container);

    const { dialog, field } = await replace(container);

    expect(within(dialog).getByRole('heading', { name: copy.title('Anthropic') })).toBeDefined();
    expect(dialog.textContent).toContain(copy.subtitle);
    expect(within(dialog).getByLabelText(copy.keyLabel)).toBe(field);
    expect(field.value).toBe('');
    expect(dialog.querySelector('.cinder-_required-marker')).toBeNull();
    expect(dialog.textContent).not.toContain(MODELS_COPY.connectDialog.keyHelp);
    expect(writes()).toEqual([]);
  });

  test('tests the new key while the old one stays in use, then replaces it and says so', async () => {
    const { container } = open();
    await loaded(container);
    const { dialog, field } = await replace(container);
    host!.holdTests = true;

    await fireEvent.input(field, { target: { value: KEY } });
    await fireEvent.click(within(dialog).getByRole('button', { name: copy.replace }));

    await waitFor(() => expect(dialog.textContent).toContain(copy.testing));
    expect(
      (within(dialog).getByRole('button', { name: copy.replace }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(dialog).getByRole('button', { name: copy.cancel }) as HTMLButtonElement).disabled,
    ).toBe(false);
    // The old key is still the one in use: nothing has been saved.
    expect(writes().filter((request) => request.method === 'PUT')).toEqual([]);
    expect(providerOf(container, 'anthropic')?.textContent).toContain(
      MODELS_COPY.providers.connected,
    );

    host!.heldTests.splice(0).forEach((release) => release());

    await waitFor(() =>
      expect(writes().filter((request) => request.method === 'PUT')).toEqual([
        {
          method: 'PUT',
          path: '/host/providers/anthropic',
          body: {
            apiKey: KEY,
            operationId: expect.any(String),
            expectedRevision: expect.any(String),
          },
        },
      ]),
    );
    await waitFor(() =>
      expect(container.ownerDocument.body.textContent).toContain(copy.toast('Anthropic')),
    );
    await waitFor(() =>
      expect(container.ownerDocument.querySelector('dialog[open]')?.outerHTML ?? null).toBeNull(),
    );
    expect(printed(container)).not.toContain(KEY);
  });

  test('leaves the old key alone when the new one is refused, with the reason at the field', async () => {
    const { container } = open();
    await loaded(container);
    const { dialog, field } = await replace(container);

    await fireEvent.input(field, { target: { value: `${KEY}-rejected-key` } });
    await fireEvent.click(within(dialog).getByRole('button', { name: copy.replace }));

    await waitFor(() =>
      expect(dialog.textContent).toContain(MODELS_COPY.keyTest.rejected('Anthropic', 401)),
    );
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(writes().filter((request) => request.method === 'PUT')).toEqual([]);
    expect(providerOf(container, 'anthropic')?.textContent).toContain(
      MODELS_COPY.providers.connected,
    );
  });
});

describe('removing a provider’s key', () => {
  const copy = MODELS_COPY.removeDialog;
  const MODEL_AGENTS = {
    'Tool runner': 'anthropic/claude-sonnet-5',
    'Request human input': 'anthropic/claude-haiku-4-5',
    'Model switcher': 'anthropic/claude-sonnet-5',
    'Workflow author': 'anthropic/claude-sonnet-5',
    Assistant: '',
  };

  /** Opens Manage, presses Remove key, and returns the confirmation that follows. */
  async function ask(container: HTMLElement, name = 'anthropic') {
    await fireEvent.click(
      within(providerOf(container, name)!).getByRole('button', { name: /^Manage/ }),
    );
    const manage = await dialogOf(container);
    await fireEvent.click(
      within(manage).getByRole('button', { name: MODELS_COPY.manageDialog.removeKey }),
    );
    return waitFor(() => {
      const found = [...container.ownerDocument.querySelectorAll<HTMLElement>('dialog[open]')].find(
        (candidate) => candidate.textContent?.includes(copy.title(providerName(name))),
      );
      expect(found).toBeDefined();
      return found!;
    });
  }
  const providerName = (name: string) =>
    name === 'anthropic' ? 'Anthropic' : name === 'openai' ? 'OpenAI' : 'Gemini';
  const confirm = (dialog: HTMLElement) =>
    within(dialog).getByRole('button', { name: copy.confirm });

  test('is a confirm dialog that names the four model agents and not the scripted ones, with a solid danger button', async () => {
    const { container } = open({ agents: MODEL_AGENTS });
    await loaded(container);

    const dialog = await ask(container);

    expect(
      within(dialog).getByRole('heading', { name: 'Remove the Anthropic key?' }),
    ).toBeDefined();
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        'Tool runner, Request human input, Model switcher and Workflow author stop answering until you add a key. Run now on their schedules is disabled too. Chats and runs stay.',
      ),
    );
    expect(dialog.textContent).not.toContain('Assistant');
    expect(confirm(dialog).getAttribute('data-cinder-variant')).toBe('danger');
    expect(within(dialog).getByRole('button', { name: copy.cancel })).toBeDefined();
    expect(writes()).toEqual([]);
  });

  test('removes the key and the models with it, and says so', async () => {
    const { container } = open({ agents: MODEL_AGENTS });
    await loaded(container);
    await waitFor(() => expect(rowOf(container, 'anthropic/claude-sonnet-5')).not.toBeNull());
    const dialog = await ask(container);
    await waitFor(() => expect(dialog.textContent).toContain('Workflow author stop'));

    await fireEvent.click(confirm(dialog));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'DELETE',
      path: '/host/providers/anthropic',
      body: {
        operationId: expect.any(String),
        expectedRevision: JSON.stringify([{ anthropic: true, openai: false, gemini: false }, []]),
      },
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
    expect(container.ownerDocument.body.textContent).toContain(copy.toast('Anthropic'));
    expect(everything(container)).not.toContain(KEY);
  });

  test('sends nothing on Cancel and leaves the provider connected', async () => {
    const { container } = open({ agents: MODEL_AGENTS });
    await loaded(container);
    const dialog = await ask(container);

    await fireEvent.click(within(dialog).getByRole('button', { name: copy.cancel }));

    await waitFor(() =>
      expect(container.ownerDocument.querySelector('dialog[open]')?.outerHTML ?? null).toBeNull(),
    );
    expect(writes()).toEqual([]);
    expect(providerOf(container, 'anthropic')?.textContent).toContain(
      MODELS_COPY.providers.connected,
    );
  });

  test('says so when no agent uses the provider’s models', async () => {
    const { container } = open({ agents: { helper: 'openai/gpt-5' } });
    await loaded(container);

    const dialog = await ask(container);

    await waitFor(() =>
      expect(dialog.textContent).toContain(copy.descriptionNoAgents('Anthropic')),
    );
  });

  test('speaks of one agent in the singular, and notes agents that only lose listed models', async () => {
    const { container } = open({
      agents: { writer: 'anthropic/sonnet', switcher: 'openai/gpt-5' },
      listedModels: { switcher: ['anthropic/haiku'] },
    });
    await loaded(container);

    const dialog = await ask(container);

    await waitFor(() =>
      expect(dialog.textContent).toContain(
        'Writer stops answering until you add a key. Run now on its schedules is disabled too.',
      ),
    );
    expect(within(dialog).getByTestId('provider-remove-trimmed').textContent).toContain(
      copy.trimmedNote(['Switcher'], 'Anthropic'),
    );
    expect(within(dialog).queryByTestId('provider-remove-embedder')).toBeNull();
  });

  test('flags the memory embedder for a provider that offers one', async () => {
    const { container } = open({ keys: { anthropic: true, openai: true, gemini: false } });
    await loaded(container);

    const dialog = await ask(container, 'openai');

    expect(within(dialog).getByTestId('provider-remove-embedder').textContent).toContain(
      copy.embedderNote,
    );
  });

  test('says which agents are unknown when they cannot be read, and still lets the person remove the key', async () => {
    const { container } = open({ agents: { writer: 'anthropic/sonnet' }, agentsUnreadable: true });
    await loaded(container);

    const dialog = await ask(container);

    await waitFor(() => expect(dialog.textContent).toContain(copy.agentsUnknown('Anthropic')));
    expect((confirm(dialog) as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(confirm(dialog));
    await waitFor(() => expect(writes()).toHaveLength(1));
  });

  test('keeps the dialog open and says the key was not removed when the host refuses', async () => {
    const { container } = open({ agents: MODEL_AGENTS });
    await loaded(container);
    const dialog = await ask(container);
    host!.refuseNext = Response.json({ error: 'failed', message: '' }, { status: 500 });

    await fireEvent.click(confirm(dialog));

    await waitFor(() => expect(dialog.textContent).toContain(copy.failedTitle));
    expect(dialog.textContent).toContain(copy.failed);
    expect(confirm(dialog)).toBeDefined();
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
