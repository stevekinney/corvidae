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

/** Types into a number field and leaves it, which is when it commits the value. */
async function typeNumber(field: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(field, { target: { value } });
  await fireEvent.blur(field);
}

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
    expect(queryAllByRole('tab')).toHaveLength(0);
    const current = container.querySelector('nav a[aria-current="page"]');
    expect(current?.textContent?.trim()).toBe('Models');
    expect(current?.getAttribute('href')).toBe('/settings/models');
  });

  test('shows a Connected dot and Manage for a provider with a key, and only Connect for one without', async () => {
    const { container } = open();
    await loaded(container);

    const connected = providerOf(container, 'anthropic');
    expect(connected?.textContent).toContain(MODELS_COPY.providers.connected);
    expect(within(connected!).getByRole('button', { name: /Manage/ })).toBeDefined();
    expect(within(connected!).queryByRole('button', { name: /Connect/ })).toBeNull();

    const unconnected = providerOf(container, 'openai');
    expect(within(unconnected!).getByRole('button', { name: /Connect/ })).toBeDefined();
    expect(within(unconnected!).queryByRole('button', { name: /Manage/ })).toBeNull();
    expect(unconnected?.textContent).not.toContain(MODELS_COPY.providers.connected);
    expect(container.textContent?.toLowerCase()).not.toContain('not connected');
  });

  test('shows a provider whose plugin needs setup as needing setup, with a link to the plugin', async () => {
    const { container } = open({
      plugins: [
        { name: 'anthropic', status: 'running' },
        { name: 'gemini', status: 'needs-setup' },
      ],
    });
    await loaded(container);

    const gemini = providerOf(container, 'gemini')!;
    await waitFor(() => expect(gemini.textContent).toContain(MODELS_COPY.providers.needsSetup));
    const link = within(gemini).getByRole('link', {
      name: MODELS_COPY.providers.pluginLink('Gemini'),
    });
    expect(link.getAttribute('href')).toBe('/settings/plugins?plugin=gemini');
    // It can still be connected from here, which is what sets the plugin up.
    expect(within(gemini).getByRole('button', { name: /Connect/ })).toBeDefined();
    // A provider whose plugin is running, or that has no plugin, says nothing of the sort.
    expect(providerOf(container, 'anthropic')?.textContent).not.toContain(
      MODELS_COPY.providers.needsSetup,
    );
    expect(providerOf(container, 'openai')?.textContent).not.toContain(
      MODELS_COPY.providers.needsSetup,
    );
    expect(within(providerOf(container, 'openai')!).queryByRole('link')).toBeNull();
  });

  test('lists every model the connected providers offer, with context, abilities and price', async () => {
    const { container } = open();
    await loaded(container);

    await waitFor(() => expect(rowOf(container, 'anthropic/claude-sonnet-5')).not.toBeNull());
    expect(rowOf(container, 'openai/gpt-5')).toBeNull();
    const sonnet = rowOf(container, 'anthropic/claude-sonnet-5')!;
    expect(sonnet.textContent).toContain('200K');
    expect(sonnet.textContent).toContain('Tools');
    expect(sonnet.textContent).toContain('Structured output');
    expect(sonnet.textContent).toContain('$3.00 in, $15.00 out');
    expect(rowOf(container, 'anthropic/claude-haiku-4-5')?.textContent).toContain('Images');
  });

  test('marks the controls that call a write, and none that only read', async () => {
    const { container, getByRole } = open();
    await loaded(container);
    await waitFor(() => expect(rowOf(container, 'anthropic/claude-sonnet-5')).not.toBeNull());

    expect(
      getByRole('button', { name: MODELS_COPY.models.save }).hasAttribute('data-changes'),
    ).toBe(true);
    expect(
      getByRole('button', { name: MODELS_COPY.providers.reload }).hasAttribute('data-changes'),
    ).toBe(true);
    await fireEvent.click(within(providerOf(container, 'openai')!).getByRole('button'));
    const dialog = await within(container.ownerDocument.body).findByRole('dialog');
    expect(
      within(dialog)
        .getByRole('button', { name: MODELS_COPY.connectDialog.connect })
        .hasAttribute('data-changes'),
    ).toBe(true);
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

  test('reads the files again on request', async () => {
    const { container, getByRole } = open();
    await loaded(container);
    await fireEvent.click(getByRole('button', { name: MODELS_COPY.providers.reload }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: 'POST', path: '/host/providers/reload' });
  });
});

describe('disconnecting a provider', () => {
  async function ask(container: HTMLElement, name = 'anthropic') {
    await fireEvent.click(
      within(providerOf(container, name)!).getByRole('button', { name: /^Disconnect/ }),
    );
    return within(container.ownerDocument.body).findByRole('dialog');
  }
  const confirm = (dialog: HTMLElement) =>
    within(dialog).getByRole('button', { name: MODELS_COPY.disconnectDialog.confirm });

  test('is offered for a provider with a key, and not for one without', async () => {
    const { container } = open();
    await loaded(container);

    expect(
      within(providerOf(container, 'anthropic')!).getByRole('button', { name: /^Disconnect/ }),
    ).toBeDefined();
    expect(
      within(providerOf(container, 'openai')!).queryByRole('button', { name: /^Disconnect/ }),
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
      name: /^Disconnect/,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(writes()).toEqual([]);
  });
});

describe('a catalog that changed while it was being edited', () => {
  const save = (getByRole: ReturnType<typeof render>['getByRole']) =>
    getByRole('button', { name: MODELS_COPY.models.save }) as HTMLButtonElement;
  const haiku = (container: HTMLElement) => rowOf(container, 'anthropic/claude-haiku-4-5')!;
  const sonnetOff = { provider: 'anthropic', model: 'claude-sonnet-5', off: true };

  async function startEditing(container: HTMLElement) {
    await loaded(container);
    await waitFor(() => expect(rowOf(container, 'anthropic/claude-sonnet-5')).not.toBeNull());
    await fireEvent.click(within(haiku(container)).getByRole('switch'));
  }

  test('is found when the files are read again, and holds Save with the working copy kept', async () => {
    const { container, getByRole, findByTestId } = open();
    await startEditing(container);
    // A hand edit that the person then asks the host to read.
    host!.catalog = [sonnetOff];
    await fireEvent.click(getByRole('button', { name: MODELS_COPY.providers.reload }));

    const prompt = await findByTestId('models-changed-elsewhere');
    expect(prompt.textContent).toContain(MODELS_COPY.models.changedElsewhere.title);
    expect(save(getByRole).disabled).toBe(true);
    // The person's edit is still on the table.
    expect(haiku(container).dataset['off']).toBe('true');
    expect(writes().map((write) => write.path)).toEqual(['/host/providers/reload']);
  });

  test('is found by the host when Save is pressed first, which writes nothing and keeps the edit', async () => {
    const { container, getByRole, findByTestId } = open();
    await startEditing(container);
    // Another tab saved. This page has not read it yet.
    host!.catalog = [sonnetOff];

    await fireEvent.click(save(getByRole));

    await findByTestId('models-changed-elsewhere');
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: '/host/catalog',
        body: {
          edits: [{ provider: 'anthropic', model: 'claude-haiku-4-5', off: true }],
          base: [],
        },
      },
    ]);
    // The other tab's edit stands, and the person's is still being held.
    expect(host!.catalog).toEqual([sonnetOff]);
    expect(haiku(container).dataset['off']).toBe('true');
    expect(save(getByRole).disabled).toBe(true);
    expect(container.querySelector('[data-testid="models-failure"]')).toBeNull();
  });

  test('is cleared by Reload, which takes what the host holds and drops the working copy', async () => {
    const { container, getByRole, findByTestId, queryByTestId } = open();
    await startEditing(container);
    host!.catalog = [sonnetOff];
    await fireEvent.click(save(getByRole));
    await findByTestId('models-changed-elsewhere');

    await fireEvent.click(
      getByRole('button', { name: MODELS_COPY.models.changedElsewhere.action }),
    );

    await waitFor(() =>
      expect(queryByTestId('models-changed-elsewhere')?.outerHTML ?? null).toBeNull(),
    );
    await waitFor(() =>
      expect(rowOf(container, 'anthropic/claude-sonnet-5')?.dataset['off']).toBe('true'),
    );
    expect(haiku(container).dataset['off']).toBe('false');
    expect(save(getByRole).disabled).toBe(true);
    expect(host!.catalog).toEqual([sonnetOff]);
  });

  test('is cleared by Discard too, and a new edit then starts from what the host holds', async () => {
    const { container, getByRole, findByTestId, queryByTestId } = open();
    await startEditing(container);
    host!.catalog = [sonnetOff];
    await fireEvent.click(save(getByRole));
    await findByTestId('models-changed-elsewhere');

    await fireEvent.click(getByRole('button', { name: MODELS_COPY.models.discard }));
    await waitFor(() =>
      expect(queryByTestId('models-changed-elsewhere')?.outerHTML ?? null).toBeNull(),
    );
    await waitFor(() =>
      expect(rowOf(container, 'anthropic/claude-sonnet-5')?.dataset['off']).toBe('true'),
    );
    await fireEvent.click(within(haiku(container)).getByRole('switch'));
    await fireEvent.click(save(getByRole));

    await waitFor(() => expect(writes().filter((write) => write.method === 'PUT')).toHaveLength(2));
    const second = writes().filter((write) => write.method === 'PUT')[1];
    expect(second?.body).toMatchObject({ base: [sonnetOff] });
    await waitFor(() =>
      expect(host!.catalog).toEqual([
        sonnetOff,
        { provider: 'anthropic', model: 'claude-haiku-4-5', off: true },
      ]),
    );
  });

  test('is not claimed after the person’s own save, which changes what the host holds', async () => {
    const { container, getByRole, queryByTestId } = open();
    await startEditing(container);

    await fireEvent.click(save(getByRole));

    await waitFor(() => expect(save(getByRole).disabled).toBe(true));
    await waitFor(() => expect(host!.catalog).toHaveLength(1));
    expect(queryByTestId('models-changed-elsewhere')?.outerHTML ?? null).toBeNull();
  });
});

describe('the models', () => {
  const save = (getByRole: ReturnType<typeof render>['getByRole']) =>
    getByRole('button', { name: MODELS_COPY.models.save }) as HTMLButtonElement;

  async function ready(container: HTMLElement) {
    await loaded(container);
    await waitFor(() => expect(rowOf(container, 'anthropic/claude-sonnet-5')).not.toBeNull());
  }

  test('saves nothing until Save, and Save is held while nothing changed', async () => {
    const { container, getByRole } = open();
    await ready(container);
    expect(save(getByRole).disabled).toBe(true);

    await fireEvent.click(
      within(rowOf(container, 'anthropic/claude-haiku-4-5')!).getByRole('switch'),
    );

    expect(rowOf(container, 'anthropic/claude-haiku-4-5')?.dataset['off']).toBe('true');
    expect(save(getByRole).disabled).toBe(false);
    expect(writes()).toEqual([]);
  });

  test('turns a model off through the catalog edits, and the table reads it back off', async () => {
    const { container, getByRole } = open();
    await ready(container);
    await fireEvent.click(
      within(rowOf(container, 'anthropic/claude-haiku-4-5')!).getByRole('switch'),
    );
    await fireEvent.click(save(getByRole));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'PUT',
      path: '/host/catalog',
      body: { edits: [{ provider: 'anthropic', model: 'claude-haiku-4-5', off: true }], base: [] },
    });
    await waitFor(() => expect(save(getByRole).disabled).toBe(true));
    expect(rowOf(container, 'anthropic/claude-haiku-4-5')?.dataset['off']).toBe('true');
    expect(container.textContent).toContain(MODELS_COPY.models.saved);
  });

  test('turns a model back on by dropping its edit', async () => {
    const { container, getByRole } = open({
      catalog: [{ provider: 'anthropic', model: 'haiku', off: true }],
    });
    await ready(container);
    expect(rowOf(container, 'anthropic/claude-haiku-4-5')?.dataset['off']).toBe('true');

    await fireEvent.click(
      within(rowOf(container, 'anthropic/claude-haiku-4-5')!).getByRole('switch'),
    );
    await fireEvent.click(save(getByRole));

    await waitFor(() => expect(writes()).toHaveLength(1));
    // The save names the edits it started from, which the host compares.
    expect(writes()[0]?.body).toEqual({
      edits: [],
      base: [{ provider: 'anthropic', model: 'haiku', off: true }],
    });
  });

  test('puts the edits back on Discard, and when a switch is flipped twice', async () => {
    const { container, getByRole } = open();
    await ready(container);
    const haiku = () => within(rowOf(container, 'anthropic/claude-haiku-4-5')!).getByRole('switch');

    await fireEvent.click(haiku());
    await fireEvent.click(getByRole('button', { name: MODELS_COPY.models.discard }));
    expect(rowOf(container, 'anthropic/claude-haiku-4-5')?.dataset['off']).toBe('false');
    expect(save(getByRole).disabled).toBe(true);

    await fireEvent.click(haiku());
    await fireEvent.click(haiku());
    expect(save(getByRole).disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  test('edits a row’s limits and price in a dialog that writes nothing until Save', async () => {
    const { container, getByRole } = open();
    await ready(container);

    await fireEvent.click(
      within(rowOf(container, 'anthropic/claude-sonnet-5')!).getByRole('button', { name: /Edit/ }),
    );
    const dialog = await within(container.ownerDocument.body).findByRole('dialog');
    await typeNumber(within(dialog).getByLabelText(MODELS_COPY.rowDialog.contextWindow), '100000');
    await typeNumber(within(dialog).getByLabelText(MODELS_COPY.rowDialog.outputPrice), '20');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MODELS_COPY.rowDialog.apply }),
    );

    await waitFor(() =>
      expect(rowOf(container, 'anthropic/claude-sonnet-5')?.textContent).toContain('100K'),
    );
    expect(writes()).toEqual([]);
    await fireEvent.click(save(getByRole));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({
      edits: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          contextWindowTokens: 100_000,
          pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 20, currency: 'USD' },
        },
      ],
      base: [],
    });
  });

  test('refuses a limit a form can see is wrong, and sends nothing', async () => {
    const { container } = open();
    await ready(container);
    await fireEvent.click(
      within(rowOf(container, 'anthropic/claude-sonnet-5')!).getByRole('button', { name: /Edit/ }),
    );
    const dialog = await within(container.ownerDocument.body).findByRole('dialog');
    await typeNumber(within(dialog).getByLabelText(MODELS_COPY.rowDialog.maxOutput), '900000');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MODELS_COPY.rowDialog.apply }),
    );

    expect(dialog.textContent).toContain(MODELS_COPY.rowDialog.outputTooLarge);
    expect(writes()).toEqual([]);
  });

  test('adds a model the built-in list lacks, based on one it has', async () => {
    const { container, getByRole } = open();
    await ready(container);

    await fireEvent.click(getByRole('button', { name: MODELS_COPY.models.add }));
    const dialog = await within(container.ownerDocument.body).findByRole('dialog');
    await fireEvent.input(within(dialog).getByLabelText(MODELS_COPY.rowDialog.model), {
      target: { value: 'claude-next' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: MODELS_COPY.rowDialog.add }));

    await waitFor(() => expect(rowOf(container, 'anthropic/claude-next')).not.toBeNull());
    expect(rowOf(container, 'anthropic/claude-next')?.textContent).toContain(
      MODELS_COPY.models.added,
    );
    await fireEvent.click(save(getByRole));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({
      edits: [{ provider: 'anthropic', model: 'claude-next', basedOn: 'claude-sonnet-5' }],
    });
    await waitFor(() => expect(save(getByRole).disabled).toBe(true));
  });

  test('refuses a name the provider already lists', async () => {
    const { container, getByRole } = open();
    await ready(container);
    await fireEvent.click(getByRole('button', { name: MODELS_COPY.models.add }));
    const dialog = await within(container.ownerDocument.body).findByRole('dialog');
    await fireEvent.input(within(dialog).getByLabelText(MODELS_COPY.rowDialog.model), {
      target: { value: 'sonnet' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: MODELS_COPY.rowDialog.add }));
    expect(dialog.textContent).toContain(MODELS_COPY.rowDialog.modelExists);
  });

  test('keeps the edits and says why when the host refuses them', async () => {
    const { container, getByRole } = open();
    await ready(container);
    await fireEvent.click(
      within(rowOf(container, 'anthropic/claude-haiku-4-5')!).getByRole('switch'),
    );
    host!.refuseNext = Response.json(
      { error: 'invalid', field: 'catalog[0].model', message: 'Invalid catalog[0].model.' },
      { status: 400 },
    );
    await fireEvent.click(save(getByRole));

    const failure = await waitFor(() => {
      const alert = container.querySelector('[data-testid="models-failure"]');
      expect(alert).not.toBeNull();
      return alert!;
    });
    expect(failure.textContent).toContain('Invalid catalog[0].model.');
    expect(rowOf(container, 'anthropic/claude-haiku-4-5')?.dataset['off']).toBe('true');
    expect(save(getByRole).disabled).toBe(false);
  });

  test('holds every control and says why when the host is locked', async () => {
    const { container, getByRole } = open({ lockReason: 'deployment' });
    await ready(container);
    const row = rowOf(container, 'anthropic/claude-haiku-4-5')!;
    expect((within(row).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect((within(row).getByRole('button', { name: /Edit/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (getByRole('button', { name: MODELS_COPY.models.add }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('with no provider connected', () => {
  test('says there are no models, with Connect a provider as the action, and no status string', async () => {
    const { container, findByRole } = open({
      keys: { anthropic: false, openai: false, gemini: false },
    });
    const empty = await findByRole('group', { name: MODELS_COPY.models.empty.title });

    expect(empty.getAttribute('data-cinder-kind')).toBe('first-use');
    expect(empty.textContent).toContain(MODELS_COPY.models.empty.description);
    expect(container.querySelector('table')).toBeNull();

    await fireEvent.click(
      within(empty).getByRole('button', { name: MODELS_COPY.models.empty.action }),
    );
    const dialog = await within(container.ownerDocument.body).findByRole('dialog');
    expect(dialog.textContent).toContain('Anthropic');
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
  });

  test('save a switched decision model in one settings update', async () => {
    const served = servedSettings();
    const { container, findByRole } = open({ served });
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const select = row(container, 'decisions.model')!.querySelector('select')!;
    expect([...select.options].map((option) => option.value)).toContain('typesafe:jev');

    await fireEvent.change(select, { target: { value: 'typesafe:jev' } });
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.settings.update')).toHaveLength(1));
    expect(stub?.callsTo('bureau.settings.update')[0]?.params['patch']).toEqual({
      'decisions.model': 'typesafe:jev',
    });
    expect(served.values['decisions.model']).toBe('typesafe:jev');
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
