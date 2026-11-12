/**
 * The agent editor's model field, against a stand-in for the Bureau and the host: models grouped
 * by provider, a provider with no key disabled and pointing to Settings › Models, a model the
 * model policy forbids (or one turned off or retired) listed with its reason and not offered, the
 * abilities of the chosen model, and a saved agent's own model that is no longer offered, which is
 * read-only text with a notice that says what a save does with it: kept when it is only turned
 * off, refused when it is retired, gone from the catalog, or forbidden by the model policy.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { AGENT_EDITOR_COPY } from '../../app/copy/agents.ts';
import type { AgentCatalog, AgentDetail } from '../../lib/agent-definitions.ts';
import {
  catalogFixture,
  faults,
  installBureauStub,
  readyAgent,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  chooseModel,
  closeModelList,
  openModelOptions,
  optionDescription,
  optionLabel,
} from './agent-editor-model-support.test-support.ts';
import Harness from './agent-editor-test-harness.test-harness.svelte';

const copy = AGENT_EDITOR_COPY.model;

let stub: BureauStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate('/', { replace: true });
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

/** Two providers with a key, and one model each that differ in what they can do. */
const catalog = (): AgentCatalog =>
  catalogFixture({
    models: [
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        aliases: [{ alias: 'sonnet', resolvesTo: 'claude-sonnet-5' }],
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 64_000,
        structuredOutput: true,
        modalities: { text: { input: true }, image: { input: true } },
      },
      { provider: 'openai', model: 'gpt-4.1', tools: false, streaming: false, modalities: {} },
    ],
  });

type Setup = {
  readonly agent?: AgentDetail;
  readonly catalog?: AgentCatalog;
  /** The providers `/host/providers` reports; left out, the host does not answer. */
  readonly hostProviders?: readonly { readonly name: string; readonly hasKey: boolean }[];
  /** The `modelPolicy` setting; left out, the settings cannot be read. */
  readonly modelPolicy?: unknown;
};

function bureau(setup: Setup = {}): BureauStub {
  const agent = setup.agent ?? readyAgent();
  stub = installBureauStub(
    {
      'bureau.agents.catalog': () => setup.catalog ?? catalog(),
      'bureau.agents.definitions.get': () => agent,
      'bureau.agents.definitions.revisions': () => ({ revisions: [] }),
      'bureau.agents.versions.list': () => ({ versions: [] }),
      'bureau.agents.definitions.create': (params) => ({ id: String(params['id']), hash: 'new' }),
      'bureau.agents.definitions.update': () => ({ id: agent.id, hash: 'hash-2' }),
      ...(setup.modelPolicy === undefined
        ? {}
        : {
            'bureau.settings.get': () => ({
              values: { modelPolicy: setup.modelPolicy },
              effective: { modelPolicy: setup.modelPolicy },
              running: { modelPolicy: setup.modelPolicy },
              revision: 1,
              persisted: true,
              keys: {},
            }),
          }),
    },
    setup.hostProviders === undefined ? {} : { hostProviders: setup.hostProviders },
  );
  return stub;
}

function mountEditor(id?: string) {
  return render(Harness, { props: id === undefined ? {} : { id } } as never);
}

/** The group headings of the open list, with the options under each. */
function groupsOf(): { name: string; options: string[] }[] {
  return [...document.querySelectorAll<HTMLElement>('.cinder-_option-group')].map((group) => ({
    name: group.querySelector('.cinder-_option-group__label')?.textContent?.trim() ?? '',
    options: [...group.querySelectorAll<HTMLElement>('[role="option"]')].map(optionLabel),
  }));
}

describe('the models of a new agent', () => {
  test('are grouped by provider, each provider under its name', async () => {
    bureau({ hostProviders: [{ name: 'anthropic', hasKey: true }] });
    const { findByRole } = mountEditor();
    await openModelOptions(await findByRole('combobox', { name: 'Model' }));

    expect(groupsOf()).toEqual([
      { name: 'Anthropic', options: ['anthropic/claude-sonnet-5'] },
      { name: 'OpenAI', options: ['openai/gpt-4.1'] },
    ]);
  });

  test('are all listed when the field is opened as it stands, with the chosen model in it', async () => {
    bureau({ hostProviders: [{ name: 'anthropic', hasKey: true }] });
    const { findByRole } = mountEditor();
    const field = await findByRole('combobox', { name: 'Model' });
    expect(field).toHaveValue('anthropic/claude-sonnet-5');

    // Nothing is cleared: the text is the chosen model's name, which must not narrow the list to it.
    await openModelOptions(field, { clear: false });
    expect(groupsOf()).toEqual([
      { name: 'Anthropic', options: ['anthropic/claude-sonnet-5'] },
      { name: 'OpenAI', options: ['openai/gpt-4.1'] },
    ]);

    // Typing narrows it as before.
    await fireEvent.input(field, { target: { value: 'gpt' } });
    expect(groupsOf()).toEqual([{ name: 'OpenAI', options: ['openai/gpt-4.1'] }]);
  });

  test('list a provider with no key as one disabled option, and point to Settings › Models', async () => {
    bureau({
      hostProviders: [
        { name: 'anthropic', hasKey: true },
        { name: 'openai', hasKey: true },
        { name: 'gemini', hasKey: false },
      ],
    });
    const { findByRole, getByTestId } = mountEditor();
    const options = await openModelOptions(await findByRole('combobox', { name: 'Model' }));

    const gemini = options.find((option) => optionLabel(option) === copy.notConnected('Gemini'));
    expect(gemini).toBeDefined();
    expect(gemini).toHaveAttribute('aria-disabled', 'true');
    expect(optionDescription(gemini as HTMLElement)).toBe(copy.notConnectedDescription);
    expect(groupsOf().at(-1)).toEqual({ name: 'Gemini', options: [copy.notConnected('Gemini')] });

    // Pressing it chooses nothing.
    await fireEvent.mouseDown(gemini as HTMLElement);
    await closeModelList(await findByRole('combobox', { name: 'Model' }));
    expect(await findByRole('combobox', { name: 'Model' })).toHaveValue(
      'anthropic/claude-sonnet-5',
    );

    // The line under the field names the provider and links to the page that connects it.
    const hint = getByTestId('agent-model-unconnected');
    expect(hint.textContent).toContain('Gemini is not connected. Connect it in');
    const link = within(hint).getByRole('link', { name: copy.settingsLink });
    expect(link).toHaveAttribute('href', '/settings/models');
    await fireEvent.click(link);
    expect(router.pathname).toBe('/settings/models');
  });

  test('say nothing about providers when every provider has a key, or the host does not say', async () => {
    bureau({ hostProviders: [{ name: 'anthropic', hasKey: true }] });
    const first = mountEditor();
    await first.findByRole('combobox', { name: 'Model' });
    expect(first.queryByTestId('agent-model-unconnected')).toBeNull();
    first.unmount();
    stub?.restore();

    bureau();
    const second = mountEditor();
    await second.findByRole('combobox', { name: 'Model' });
    expect(second.queryByTestId('agent-model-unconnected')).toBeNull();
  });

  test('show the abilities of the chosen model, and of the next one once it is chosen', async () => {
    bureau();
    const { findByRole, getByTestId } = mountEditor();
    const field = await findByRole('combobox', { name: 'Model' });
    const abilities = getByTestId('agent-model-abilities');

    expect(within(abilities).getByText(copy.context('1M'))).not.toBeNull();
    expect(within(abilities).getByText(copy.maxOutput('64K'))).not.toBeNull();
    for (const ability of ['tools', 'images', 'structuredOutput', 'streaming'] as const) {
      expect(within(abilities).getByText(copy.abilities[ability])).not.toBeNull();
    }
    expect(abilities).toHaveAccessibleName(copy.abilitiesLabel);

    await chooseModel(field, 'openai/gpt-4.1');

    await waitFor(() => expect(within(abilities).getByText(copy.textOnly)).not.toBeNull());
    expect(within(abilities).getByText(copy.context('200K'))).not.toBeNull();
    expect(within(abilities).queryByText(copy.abilities.tools)).toBeNull();
    expect(within(abilities).queryByText(copy.abilities.images)).toBeNull();
  });

  test('describe each model they can offer by what it can do', async () => {
    bureau();
    const { findByRole } = mountEditor();
    const options = await openModelOptions(await findByRole('combobox', { name: 'Model' }));
    expect(optionDescription(options[0] as HTMLElement)).toBe(
      [
        copy.context('1M'),
        copy.abilities.tools,
        copy.abilities.images,
        copy.abilities.structuredOutput,
        copy.abilities.streaming,
      ].join(', '),
    );
  });
});

describe('a model the model policy forbids', () => {
  const policy = {
    deployment: { deniedProviders: ['openai'], deniedModels: ['claude-haiku-5'] },
    policyRevision: 2,
  };

  test('is listed with its reason, cannot be chosen, and is never the default', async () => {
    bureau({
      catalog: catalogFixture({
        models: [
          { provider: 'openai', model: 'gpt-4.1' },
          { provider: 'anthropic', model: 'claude-haiku-5' },
          { provider: 'anthropic', model: 'claude-sonnet-5' },
        ],
      }),
      modelPolicy: policy,
    });
    const { findByRole } = mountEditor();
    const field = await findByRole('combobox', { name: 'Model' });
    // The first model that is not forbidden.
    expect(field).toHaveValue('anthropic/claude-sonnet-5');

    const options = await openModelOptions(field);
    const byName = Object.fromEntries(options.map((option) => [optionLabel(option), option]));
    expect(byName['openai/gpt-4.1']).toHaveAttribute('aria-disabled', 'true');
    expect(optionDescription(byName['openai/gpt-4.1'] as HTMLElement)).toBe(
      copy.reasons['provider-denied'],
    );
    expect(optionDescription(byName['anthropic/claude-haiku-5'] as HTMLElement)).toBe(
      copy.reasons['model-denied'],
    );
    expect(byName['anthropic/claude-sonnet-5']).not.toHaveAttribute('aria-disabled');

    await fireEvent.mouseDown(byName['openai/gpt-4.1'] as HTMLElement);
    await closeModelList(field);
    expect(field).toHaveValue('anthropic/claude-sonnet-5');
  });

  test('leaves a new agent nothing to save when every model is forbidden', async () => {
    bureau({
      modelPolicy: { deployment: { deniedProviders: ['anthropic', 'openai'] }, policyRevision: 1 },
    });
    const { findByRole, findByText } = mountEditor();
    const field = await findByRole('combobox', { name: 'Model' });
    expect(field).toHaveValue('');
    // Save stays enabled (W35); a submit says the field needs a model and sends nothing.
    const save = await findByRole('button', { name: AGENT_EDITOR_COPY.createAction });
    expect(save).not.toBeDisabled();
    await fireEvent.click(save);
    expect(await findByText(AGENT_EDITOR_COPY.newAgent.modelRequired)).not.toBeNull();
    expect(field).toBeInvalid();
  });

  test('is not forbidden by the user’s own preferences, which bind no agent', async () => {
    bureau({
      modelPolicy: {
        users: { 'anonymous:local': { deniedProviders: ['anthropic'] } },
        policyRevision: 1,
      },
    });
    const { findByRole } = mountEditor();
    expect(await findByRole('combobox', { name: 'Model' })).toHaveValue(
      'anthropic/claude-sonnet-5',
    );
  });
});

describe('a model turned off or retired', () => {
  test('is listed with its reason and cannot be chosen', async () => {
    bureau({
      catalog: catalogFixture({
        models: [
          { provider: 'anthropic', model: 'old', lifecycle: 'retired' },
          { provider: 'anthropic', model: 'off', availability: 'unavailable' },
          { provider: 'anthropic', model: 'current' },
        ],
      }),
    });
    const { findByRole } = mountEditor();
    const field = await findByRole('combobox', { name: 'Model' });
    expect(field).toHaveValue('anthropic/current');
    const options = await openModelOptions(field);
    expect(
      options.map((option) => [optionLabel(option), optionDescription(option) === '' ? '' : 'x']),
    ).toEqual([
      ['anthropic/old', 'x'],
      ['anthropic/off', 'x'],
      ['anthropic/current', 'x'],
    ]);
    expect(optionDescription(options[0] as HTMLElement)).toBe(copy.reasons.retired);
    expect(optionDescription(options[1] as HTMLElement)).toBe(copy.reasons['turned-off']);
  });
});

describe('a saved agent whose model is no longer offered', () => {
  const notices = AGENT_EDITOR_COPY.edit.model;
  const written = (model: string): AgentDetail => {
    const agent = readyAgent();
    if (agent.definition === null) throw new Error('expected a definition');
    return { ...agent, definition: { ...agent.definition, model } };
  };

  test('shows a model the policy forbids as read-only text with a notice that a save is refused, and shows the Bureau’s refusal of a save that keeps it', async () => {
    const refusal =
      'The definition cannot be used: model: "openai/gpt-4.1" is forbidden by the deployment model policy (provider denied)';
    const calls = bureau({
      agent: written('openai/gpt-4.1'),
      modelPolicy: { deployment: { deniedProviders: ['openai'] }, policyRevision: 1 },
    });
    calls.on('bureau.agents.definitions.update', () => {
      throw faults.unprocessable(refusal);
    });
    const { findByTestId, findByText, getByTestId, getByRole, queryByRole } =
      mountEditor('researcher');

    // The model is text, not a field: the Settings tab is where it is changed.
    const awaited343 = await findByTestId('agent-saved-model-value');
    expect(awaited343.textContent).toContain('OpenAI');
    expect(queryByRole('combobox', { name: 'Model' })).toBeNull();
    const notice = getByTestId('agent-model-notice').textContent ?? '';
    expect(notice).toContain(
      notices.refusedNotice('openai/gpt-4.1', copy.reasons['provider-denied']),
    );
    expect(notice).not.toContain('Saving keeps it');

    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));
    const shown = await findByText(refusal);
    expect(shown.closest('[role="alert"]')?.textContent).toContain(AGENT_EDITOR_COPY.saveFailed);
    expect(router.pathname).not.toBe('/agents/researcher');
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params['definition']).toMatchObject({ model: 'openai/gpt-4.1' });
  });

  test('says a model the policy names is refused at a save whichever way it names it', async () => {
    bureau({
      agent: written('openai/gpt-4.1'),
      modelPolicy: { bureau: { deniedModels: ['gpt-4.1'] }, policyRevision: 1 },
    });
    const { findByTestId } = mountEditor('researcher');
    const awaited365 = await findByTestId('agent-model-notice');
    expect(awaited365.textContent).toContain(
      notices.refusedNotice('openai/gpt-4.1', copy.reasons['model-denied']),
    );
  });

  test('says a save needs another model when the agent’s own model is retired', async () => {
    bureau({
      agent: written('anthropic/old'),
      catalog: catalogFixture({
        models: [
          { provider: 'anthropic', model: 'old', lifecycle: 'retired' },
          { provider: 'anthropic', model: 'current' },
        ],
      }),
    });
    const { findByTestId } = mountEditor('researcher');

    const awaited382 = await findByTestId('agent-model-notice');
    const notice = awaited382.textContent ?? '';
    expect(notice).toContain(notices.replacementNotice('anthropic/old', copy.reasons.retired));
    expect(notice).not.toContain('Saving keeps it');
  });

  test('keeps the notice that a save keeps a model that is only turned off, and writes it back', async () => {
    const calls = bureau({
      agent: written('anthropic/off'),
      catalog: catalogFixture({
        models: [
          { provider: 'anthropic', model: 'off', availability: 'unavailable' },
          { provider: 'anthropic', model: 'current' },
        ],
      }),
    });
    const { findByTestId, getByTestId, getByRole } = mountEditor('researcher');

    const awaited399 = await findByTestId('agent-model-notice');
    expect(awaited399.textContent).toContain(
      notices.keptNotice('anthropic/off', copy.reasons['turned-off']),
    );
    expect(getByTestId('agent-saved-model-value').textContent).toContain('Anthropic');

    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params['definition']).toMatchObject({ model: 'anthropic/off' });
  });

  test('says the installation no longer offers a model the catalog lacks', async () => {
    bureau({
      agent: written('gemini/gemini-2.5-pro'),
      hostProviders: [
        { name: 'anthropic', hasKey: true },
        { name: 'gemini', hasKey: false },
      ],
    });
    const { findByTestId } = mountEditor('researcher');
    const awaited419 = await findByTestId('agent-model-notice');
    const notice = awaited419.textContent ?? '';
    expect(notice).toContain(
      notices.replacementNotice('gemini/gemini-2.5-pro', copy.reasons['not-in-catalog']),
    );
    expect(notice).not.toContain('Saving keeps it');
  });

  test('shows no notice for a model that is offered, and none on a new agent’s form', async () => {
    bureau();
    const edited = mountEditor('researcher');
    await edited.findByTestId('agent-saved-model-value');
    expect(edited.queryByTestId('agent-model-notice')).toBeNull();
    edited.unmount();

    const created = mountEditor();
    await created.findByRole('combobox', { name: 'Model' });
    expect(created.queryByTestId('agent-model-notice')).toBeNull();
    expect(created.queryByTestId('agent-saved-model')).toBeNull();
  });
});

describe('a reload from disk', () => {
  test('reads the providers and the model policy again, along with the file', async () => {
    const calls = bureau({ hostProviders: [{ name: 'anthropic', hasKey: true }] });
    const { findByTestId, getByRole, findByText, queryByTestId } = mountEditor('researcher');
    const awaited444 = await findByTestId('agent-saved-model-value');
    expect(awaited444.textContent).toContain('Anthropic');
    expect(queryByTestId('agent-model-notice')).toBeNull();

    // The file changed on disk, and the policy now forbids the agent's provider.
    calls.on('bureau.agents.definitions.update', () => {
      throw faults.stale('hash-on-disk', 'hash-1');
    });
    calls.on('bureau.settings.get', () => ({
      values: {
        modelPolicy: { deployment: { deniedProviders: ['anthropic'] }, policyRevision: 2 },
      },
      effective: {
        modelPolicy: { deployment: { deniedProviders: ['anthropic'] }, policyRevision: 2 },
      },
      running: {
        modelPolicy: { deployment: { deniedProviders: ['anthropic'] }, policyRevision: 2 },
      },
      revision: 2,
      persisted: true,
      keys: {},
    }));
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));
    await findByText(AGENT_EDITOR_COPY.stale.title);
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.stale.action }));

    const notice = await findByTestId('agent-model-notice');
    expect(notice.textContent).toContain(copy.reasons['provider-denied']);
  });
});
