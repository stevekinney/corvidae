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
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
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

afterEach(() => {
  cleanup();
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
  } = {},
) {
  stub = installSettingsBureau(options.served ?? servedSettings(), {
    'bureau.agents.catalog': () => ({ models: [], tools: [] }),
  });
  host = installFakeHost({
    keys: options.keys ?? { anthropic: true, openai: false, gemini: false },
    offered: { anthropic: [SONNET, HAIKU], openai: [GPT], gemini: [] },
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(options.lockReason === undefined ? {} : { lockReason: options.lockReason }),
  });
  landAt('/settings/models');
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
      body: { edits: [{ provider: 'anthropic', model: 'claude-haiku-4-5', off: true }] },
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
    expect(writes()[0]?.body).toEqual({ edits: [] });
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
    expect([...select.options].map((option) => option.value)).toContain('typesafe');

    await fireEvent.change(select, { target: { value: 'typesafe' } });
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));

    await waitFor(() => expect(stub?.callsTo('bureau.settings.update')).toHaveLength(1));
    expect(stub?.callsTo('bureau.settings.update')[0]?.params['patch']).toEqual({
      'decisions.model': 'typesafe',
    });
    expect(served.values['decisions.model']).toBe('typesafe');
  });
});
