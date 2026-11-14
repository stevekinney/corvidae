/**
 * The Decisions part of `/settings/models` (COR-2160): both model rows choose among the rows the
 * Bureau reports (`bureau.decisions.models`), each marked available or needs setup, and the decision
 * model row names the row that answers from the Bureau's own field. The page copies no Bureau rule,
 * so each case here serves the Bureau's answer and reads what the page makes of it.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { MODELS_COPY } from '../../../app/copy/models.ts';
import { SETTINGS_COPY } from '../../../app/copy/settings.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import type { DecisionModelRow } from '../../../lib/bureau-decisions.ts';
import type { BureauStub } from '../../../lib/bureau-stub.test-support.ts';
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

const copy = MODELS_COPY.decisions;

let stub: BureauStub | undefined;
let host: FakeHost | undefined;
let pluginHost: FakePluginHost | undefined;

afterEach(() => {
  cleanup();
  pluginHost?.restore();
  pluginHost = undefined;
  host?.restore();
  host = undefined;
  stub?.restore();
  stub = undefined;
});

/** A row as the Bureau reports it. */
function decisionRow(
  provider: string,
  name: string,
  extra: Partial<DecisionModelRow> = {},
): DecisionModelRow {
  return {
    provider,
    model: name,
    availability: 'available',
    decisionOnly: false,
    answering: false,
    fallback: false,
    ...extra,
  };
}

const HAIKU = decisionRow('anthropic', 'claude-haiku-5-5', { answering: true, fallback: true });
const GPT = decisionRow('openai', 'gpt-5', { availability: 'needs-setup' });
const JEV = decisionRow('typesafe', 'jev', { decisionOnly: true });

function open(
  options: {
    rows?: readonly DecisionModelRow[];
    served?: SettingsServed;
    plugins?: PluginFixture[];
  } = {},
) {
  stub = installSettingsBureau(options.served ?? servedSettings(), {
    'bureau.agents.catalog': () => ({ models: [], tools: [] }),
    'bureau.decisions.models': () => ({ rows: options.rows ?? [HAIKU, GPT, JEV] }),
    // The plugins' titles name the groups of rows: TypeSafe is no chat provider and is not in the
    // host's providers list, but its plugin is.
    'bureau.plugins.contributions': () => ({
      providers: ['anthropic', 'openai', 'typesafe'].map((name) => ({
        plugin: name,
        name,
        configuration: null,
      })),
      triggers: [],
      reactions: [],
    }),
  });
  host = installFakeHost({
    keys: { anthropic: true, openai: false, gemini: false },
    offered: { anthropic: [model('anthropic', 'claude-haiku-5-5')], openai: [], gemini: [] },
  });
  pluginHost = installFakePluginHost(
    options.plugins ?? [
      { name: 'typesafe', title: 'TypeSafe', status: 'running' },
      { name: 'anthropic', title: 'Anthropic' },
      { name: 'openai', title: 'OpenAI' },
    ],
  );
  landAt('/settings/models');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const row = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLElement>(`[data-setting="${key}"]`)!;
const section = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-section="decisions"]')!;
const trigger = (container: HTMLElement, key: string) =>
  within(row(container, key)).getByRole('combobox');

/** Opens a row's select and returns the options it lists. */
async function optionsOf(container: HTMLElement, key: string): Promise<HTMLElement[]> {
  await fireEvent.click(trigger(container, key));
  const body = container.ownerDocument.body;
  await waitFor(() => expect(body.querySelectorAll('[role="option"]').length).toBeGreaterThan(0));
  return [...body.querySelectorAll<HTMLElement>('[role="option"]')];
}

const ready = (container: HTMLElement) =>
  waitFor(() => expect(trigger(container, 'decisions.model')).toBeDefined());

describe('the decisions section', () => {
  test('is the decision model, its fallback and its limit per task, and nothing else of Settings', async () => {
    const { container, findByRole } = open();
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    expect(
      [...container.querySelectorAll<HTMLElement>('[data-setting]')].map(
        (entry) => entry.dataset['setting'],
      ),
    ).toEqual(['decisions.model', 'decisions.fallbackModel', 'decisions.maximumPerTask']);
    expect(container.textContent).toContain(copy.description);
    // The limit is an ordinary setting: a field that is not held while the Bureau lists rows.
    expect(row(container, 'decisions.maximumPerTask').querySelector('input')?.disabled).toBe(false);
    expect(container.textContent).not.toContain(SETTINGS_COPY.saveAction);
  });
});

describe('the rows of the decision model and the fallback model', () => {
  test('are every row the Bureau reports, grouped by provider, a row that needs setup marked and still selectable', async () => {
    const { container, findByRole } = open();
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await waitFor(() => expect(row(container, 'decisions.model')).not.toBeNull());
    await ready(container);

    const options = await optionsOf(container, 'decisions.model');

    // The empty option, then the three rows the Bureau listed, TypeSafe's among them.
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining(copy.model.none),
      expect.stringContaining('Claude Haiku 5.5'),
      expect.stringContaining('GPT 5'),
      expect.stringContaining('Jev'),
    ]);
    const body = container.ownerDocument.body.textContent ?? '';
    for (const provider of ['Anthropic', 'OpenAI', 'TypeSafe']) expect(body).toContain(provider);
    // Only the row that needs setup carries the mark, and it is not disabled.
    const marked = options.filter((option) => option.textContent?.includes(copy.needsSetup));
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain('GPT 5');
    expect(marked[0]?.getAttribute('aria-disabled')).not.toBe('true');
  });

  test('give the fallback model the same rows and marks', async () => {
    const { container, findByRole } = open();
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await ready(container);

    const options = await optionsOf(container, 'decisions.fallbackModel');

    expect(options.filter((option) => option.textContent?.includes(copy.needsSetup))).toHaveLength(
      1,
    );
    expect(options.map((option) => option.textContent).join('|')).toContain('Jev');
  });

  test('save the row that is chosen, with a needs-setup row allowed', async () => {
    const served = servedSettings();
    const { container, findByRole } = open({ served });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await ready(container);

    const options = await optionsOf(container, 'decisions.model');
    await fireEvent.click(options.find((option) => option.textContent?.includes('GPT 5'))!);

    await waitFor(() => expect(stub?.callsTo('bureau.settings.update')).toHaveLength(1));
    expect(stub?.callsTo('bureau.settings.update')[0]?.params['patch']).toEqual({
      'decisions.model': 'openai/gpt-5',
    });
    expect(served.values['decisions.model']).toBe('openai/gpt-5');
  });
});

describe('the decision model row', () => {
  test('names the row the Bureau marks as answering while no decision model is chosen', async () => {
    const { container, findByRole } = open();
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain(
        copy.model.fallbackAnswers('Claude Haiku 5.5'),
      ),
    );
    expect(row(container, 'decisions.model').textContent).not.toContain(copy.model.description);
    expect(section(container).dataset['waiting']).toBe('true');
  });

  test('takes the name from the Bureau’s field, not from a rule of its own', async () => {
    // Another row is marked: the page names that one, whatever its price or structure.
    const { container, findByRole } = open({
      rows: [
        decisionRow('anthropic', 'claude-haiku-5-5'),
        decisionRow('openai', 'gpt-5', { answering: true, fallback: true }),
      ],
    });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain(
        copy.model.fallbackAnswers('GPT 5'),
      ),
    );
  });

  test('says nothing about an answering row while the chosen row is available', async () => {
    const served = servedSettings();
    served.values['decisions.model'] = 'typesafe/jev';
    // The Bureau marks the chosen row as the one a decision goes to; the fallback is another.
    const { container, findByRole } = open({
      served,
      rows: [{ ...HAIKU, answering: false }, GPT, { ...JEV, answering: true }],
    });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain(copy.model.description),
    );
    expect(row(container, 'decisions.model').textContent).not.toContain('answers until');
    expect(section(container).dataset['waiting']).toBeUndefined();
  });

  test('reads the host’s default decision model as the one in force while none is stored, and says nothing while it answers', async () => {
    const served = servedSettings({ effective: { 'decisions.model': 'typesafe/jev' } });
    const { container, findByRole } = open({
      served,
      rows: [{ ...HAIKU, answering: false }, GPT, { ...JEV, answering: true }],
    });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain(copy.model.description),
    );
    expect(trigger(container, 'decisions.model').textContent).toContain(
      SETTINGS_COPY.defaultOption('Jev'),
    );
  });

  test('names the fallback while the host’s default decision model needs setup', async () => {
    const served = servedSettings({ effective: { 'decisions.model': 'typesafe/jev' } });
    const { container, findByRole } = open({
      served,
      rows: [HAIKU, GPT, { ...JEV, availability: 'needs-setup' }],
    });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain(
        copy.model.fallbackAnswers('Claude Haiku 5.5'),
      ),
    );
  });

  test('names the answering row while the chosen row needs setup, and keeps that row chosen', async () => {
    const served = servedSettings();
    served.values['decisions.model'] = 'openai/gpt-5';
    const { container, findByRole } = open({ served });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain(
        copy.model.fallbackAnswers('Claude Haiku 5.5'),
      ),
    );
    expect(trigger(container, 'decisions.model').textContent).toContain('GPT 5');
  });

  test('says nothing can answer when the Bureau marks no row, and offers Connect TypeSafe while its plugin waits', async () => {
    const { container, findByRole } = open({
      rows: [decisionRow('openai', 'gpt-5', { availability: 'needs-setup' })],
      plugins: [{ name: 'typesafe', status: 'needs-setup' }],
    });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain(copy.model.nothingAnswers),
    );
    const link = within(row(container, 'decisions.model')).getByRole('link', {
      name: copy.model.connect,
    });
    expect(link.getAttribute('href')).toBe('/settings/plugins?plugin=typesafe');
  });

  test('leaves out Connect TypeSafe once its plugin is running', async () => {
    const { container, findByRole } = open({ rows: [] });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain(copy.model.nothingAnswers),
    );
    expect(
      within(row(container, 'decisions.model')).queryByRole('link', { name: copy.model.connect }),
    ).toBeNull();
  });
});

describe('the fallback model row', () => {
  test('names the row the Bureau marks as the default in its empty option', async () => {
    const served = servedSettings();
    delete served.values['decisions.fallbackModel'];
    served.values['decisions.model'] = 'typesafe/jev';
    // The decision model answers, so it is not the fallback: the empty option names the fallback row.
    const { container, findByRole } = open({
      served,
      rows: [{ ...HAIKU, answering: false }, GPT, { ...JEV, answering: true }],
    });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(trigger(container, 'decisions.fallbackModel').textContent).toContain(
        SETTINGS_COPY.defaultOption('Claude Haiku 5.5'),
      ),
    );
  });
});

describe('a decision model the Bureau cannot use', () => {
  test('is a warning on the decision model row when the stored row is not one the Bureau lists, with its name kept', async () => {
    const served = servedSettings();
    served.values['decisions.model'] = 'acme/vanished';
    const { container, findByRole } = open({ served });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain(
        copy.model.missing('acme/vanished'),
      ),
    );
    // Not a silent default: the select still shows the stored name, and the row that answers is named.
    expect(trigger(container, 'decisions.model').textContent).toContain('acme/vanished');
    expect(row(container, 'decisions.model').textContent).toContain(
      copy.model.fallbackAnswers('Claude Haiku 5.5'),
    );
    // An advisory, not a refusal: nothing was refused and nothing is marked invalid.
    expect(row(container, 'decisions.model').querySelector('[aria-invalid="true"]')).toBeNull();
  });

  test('is a warning on the row when the Bureau set a stored catalog value aside and fell back to the default', async () => {
    const served = servedSettings({
      problems: {
        'decisions.model': 'The "catalog" decision model no longer exists; name a catalog row',
      },
    });
    delete served.values['decisions.model'];
    const { container, findByRole } = open({ served });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain(copy.model.dropped),
    );
    // The page words it, never the Bureau's settings-file syntax.
    expect(row(container, 'decisions.model').textContent).not.toContain('name a catalog row');
  });

  test('draws the key-state problem of the decision model row and no other row’s', async () => {
    const served = servedSettings({
      problems: { 'decisions.model': 'The "catalog" decision model no longer exists' },
    });
    const { container, findByRole } = open({ served });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain(copy.model.dropped),
    );
    expect(row(container, 'decisions.fallbackModel').textContent).not.toContain(copy.model.dropped);
    // Said once, on the row: not again in an alert above the page.
    expect(
      [...container.querySelectorAll('[role="alert"]')].some((alert) =>
        alert.textContent?.includes(copy.model.dropped),
      ),
    ).toBe(false);
    expect(container.textContent?.split(copy.model.dropped)).toHaveLength(2);
  });

  test('shows no warning for a row that is only waiting on setup', async () => {
    const served = servedSettings();
    served.values['decisions.model'] = 'openai/gpt-5';
    const { container, findByRole } = open({ served });
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await waitFor(() =>
      expect(row(container, 'decisions.model').textContent).toContain('answers until'),
    );
    expect(row(container, 'decisions.model').textContent).not.toContain(copy.model.dropped);
    expect(row(container, 'decisions.model').textContent).not.toContain(
      copy.model.missing('openai/gpt-5'),
    );
  });
});
