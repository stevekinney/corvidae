/**
 * The Settings tab of an agent's page as a form (board PageAgent, rows 38u to 39b, 39s to 39u, and
 * sweep W60): the model and its provider with the reason a provider is missing, the models a chat
 * may change to, the effort and the step limit, one Save changes and Discard with the version a
 * save makes, the step limit refused at its field, the question before a tab switch leaves changes
 * unsaved, a version opened read-only, and the delete question that names what stops finding it.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_PAGE_COPY } from '../../app/copy.ts';
import type { AgentVersion } from '../../lib/agent-definitions.ts';
import {
  installBureauStub,
  readyAgent,
  type BureauHandler,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, CONTEXT, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentDetail from './agent-detail.svelte';
import {
  changedParts,
  dependentsLine,
  effortChoices,
  modelLineOf,
  restoredChanges,
  settingsDefinition,
  settingsFormOf,
  stepLimitError,
  versionChanges,
} from './agent-settings.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const copy = AGENT_PAGE_COPY.settings;

const mount = (client = createQueryClient()) =>
  render(QueryPage, { props: { page: AgentDetail, client } } as never);

const FILE_AGENT = {
  ...AGENT,
  name: 'researcher',
  displayName: 'Researcher',
  kind: 'file',
  description: 'Finds sources.',
};

const DETAIL = readyAgent({ id: 'researcher' });
const DEFINITION = (() => {
  if (DETAIL.definition === null) throw new Error('expected a definition');
  return DETAIL.definition;
})();

const version = (
  revision: number,
  changedKeys: string[],
  definition: Partial<typeof DEFINITION> = {},
): AgentVersion => ({
  revision,
  hash: `identity-${String(revision)}`,
  savedAt: '2026-10-19T09:00:00.000Z',
  savedBy: 'anonymous:local',
  definition: { ...DEFINITION, ...definition },
  changedKeys,
});

/** Four saved versions, newest first: Version 3 moved the model from Haiku to Sonnet. */
const VERSIONS = [
  version(4, ['instructions', 'tools'], { tools: ['lookup-order', 'issue-refund'] }),
  version(3, ['model'], { model: 'anthropic/sonnet' }),
  version(2, ['instructions'], { model: 'anthropic/haiku' }),
  version(1, ['name', 'model', 'instructions'], { model: 'anthropic/haiku' }),
];

/** The server for one test: the file agent with two chats, and whatever a test overrides. */
function serve(
  answers: Record<string, BureauHandler> = {},
  providers: readonly { readonly name: string; readonly hasKey: boolean }[] = [
    { name: 'anthropic', hasKey: true },
  ],
): BureauStub {
  stub = installBureauStub(
    {
      'bureau.agents.list': () => ({ agents: [FILE_AGENT] }),
      'bureau.agents.definitions.get': () => DETAIL,
      'bureau.contexts.list': () => ({
        contexts: [
          { ...CONTEXT, id: 'a', agentName: 'researcher' },
          { ...CONTEXT, id: 'b', agentName: 'researcher' },
        ],
        nextOffset: null,
      }),
      'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
      'bureau.hooks.list': () => ({ hooks: [] }),
      'bureau.agents.versions.list': () => ({ versions: VERSIONS }),
      'bureau.agents.definitions.revisions': () => ({
        revisions: [{ hash: 'identity-3', firstRunAt: 'x', lastRunAt: 'x' }],
      }),
      ...answers,
    },
    { hostProviders: providers },
  );
  return stub;
}

/** The definition the first update wrote. */
function updatedDefinition(installed: BureauStub): Record<string, unknown> {
  const [call] = installed.callsTo('bureau.agents.definitions.update');
  if (call === undefined) throw new Error('nothing was updated');
  const definition = call.params['definition'];
  if (typeof definition !== 'object' || definition === null) throw new Error('no definition');
  return definition as Record<string, unknown>;
}

describe('the Settings form (rows 38u to 38w)', () => {
  test('names the model and its provider, and the version a save makes', async () => {
    landAt('/agents/researcher/settings');
    serve();
    const { findByTestId } = mount();

    const model = await findByTestId('agent-settings-model');
    await waitFor(() => expect(model.textContent?.trim()).toBe('Sonnet, Anthropic'));
    const note = await findByTestId('agent-settings-save-note');
    await waitFor(() => expect(note.textContent?.trim()).toBe('Saving makes Version 5.'));
  });

  test('says the provider is not connected, why the agent cannot answer, and where to connect one', async () => {
    landAt('/agents/researcher/settings');
    serve({}, [{ name: 'anthropic', hasKey: false }]);
    const { findByTestId } = mount();

    const reason = await findByTestId('agent-settings-no-provider');
    expect(reason.textContent).toContain(copy.noProvider.title('Anthropic'));
    expect(reason.textContent).toContain(copy.noProvider.description('Researcher'));
    expect(within(reason).getByRole('link', { name: copy.noProvider.action })).not.toBeNull();
  });

  test('saves the effort and the step limit as one write over the hash it read, keeping the rest of the file', async () => {
    landAt('/agents/researcher/settings');
    const installed = serve({
      'bureau.agents.definitions.update': () => ({ id: 'researcher', hash: 'hash-2' }),
    });
    const { findByRole, findByLabelText } = mount();

    await fireEvent.change(await findByLabelText('Effort'), { target: { value: 'high' } });
    await fireEvent.input(await findByLabelText('Step limit'), { target: { value: '20' } });
    await fireEvent.click(await findByRole('button', { name: copy.save }));

    await waitFor(() =>
      expect(installed.callsTo('bureau.agents.definitions.update')).toHaveLength(1),
    );
    const [call] = installed.callsTo('bureau.agents.definitions.update');
    expect(call?.params['expectedHash']).toBe('hash-1');
    const written = updatedDefinition(installed);
    expect(written['model']).toBe('anthropic/sonnet');
    expect(written['effort']).toBe('high');
    expect(written['limits']).toEqual({ steps: 20 });
    expect(written['tools']).toEqual(['lookup-order']);
    expect(written['instructions']).toBe(DEFINITION.instructions);
  });

  test('refuses a step limit of 0 at its field and focuses it, with Save still enabled and nothing written (row 39s)', async () => {
    landAt('/agents/researcher/settings');
    const installed = serve();
    const { findByRole, findByLabelText, findByText } = mount();

    const steps = await findByLabelText('Step limit');
    await fireEvent.input(steps, { target: { value: '0' } });
    const save = await findByRole('button', { name: copy.save });
    await fireEvent.click(save);

    await findByText(copy.stepLimitError(100));
    await waitFor(() => expect(document.activeElement === steps).toBe(true));
    expect(save.hasAttribute('disabled')).toBe(false);
    expect(installed.callsTo('bureau.agents.definitions.update')).toHaveLength(0);
  });

  test('Discard puts the form back as the file has it', async () => {
    landAt('/agents/researcher/settings');
    serve();
    const { findByRole, findByLabelText } = mount();

    const steps = (await findByLabelText('Step limit')) as HTMLInputElement;
    await fireEvent.input(steps, { target: { value: '40' } });
    await fireEvent.click(await findByRole('button', { name: copy.discard }));

    await waitFor(() => expect(steps.value).toBe(''));
  });
});

describe('leaving the Settings tab with changes (row 39b)', () => {
  test('asks before a tab switch, stays on Stay on Settings, and goes on Discard and leave', async () => {
    landAt('/agents/researcher/settings');
    serve();
    const { findByRole, findByLabelText } = mount();

    await fireEvent.change(await findByLabelText('Effort'), { target: { value: 'high' } });
    await fireEvent.input(await findByLabelText('Step limit'), { target: { value: '20' } });

    await fireEvent.click(await findByRole('tab', { name: /^Instructions/ }));
    let dialog = await findByRole('dialog', { name: copy.leave.title });
    expect(dialog.textContent).toContain(copy.leave.description(['Effort', 'Step limit']));
    expect(router.pathname).toBe('/agents/researcher/settings');

    await fireEvent.click(within(dialog).getByRole('button', { name: copy.leave.stay }));
    expect(router.pathname).toBe('/agents/researcher/settings');
    const kept = (await findByLabelText('Step limit')) as HTMLInputElement;
    expect(kept.value).toBe('20');

    await fireEvent.click(await findByRole('tab', { name: /^Instructions/ }));
    dialog = await findByRole('dialog', { name: copy.leave.title });
    await fireEvent.click(within(dialog).getByRole('button', { name: copy.leave.confirm }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher/instructions'));
  });

  test('switches tabs without asking while nothing has changed', async () => {
    landAt('/agents/researcher/settings');
    serve();
    const { findByRole, findByLabelText, queryByRole } = mount();

    await findByLabelText('Step limit');
    await fireEvent.click(await findByRole('tab', { name: /^Instructions/ }));

    await waitFor(() => expect(router.pathname).toBe('/agents/researcher/instructions'));
    expect(queryByRole('dialog', { name: copy.leave.title })).toBeNull();
  });
});

describe('the Versions list and a version opened read-only (rows 38x, 39t, 39u, W60)', () => {
  test('numbers each version, marks the current one and the one that ran, and shows each hash small', async () => {
    landAt('/agents/researcher/settings');
    serve();
    const { findByTestId } = mount();

    const list = await findByTestId('agent-versions');
    await waitFor(() => expect(list.querySelectorAll('[data-revision]').length).toBe(4));
    const current = list.querySelector('[data-revision="4"]');
    expect(current?.textContent).toContain('Current');
    await waitFor(() =>
      expect(list.querySelector('[data-revision="3"]')?.hasAttribute('data-ran')).toBe(true),
    );
    expect(list.querySelector('[data-revision="3"] .ib-agent-version__hash')?.textContent).toBe(
      'identity',
    );
    expect(list.querySelector('[data-revision="3"]')?.textContent).toContain(
      'Model: Haiku to Sonnet',
    );
    expect(list.querySelector('[data-revision="1"]')?.textContent).toContain('Created');
  });

  test('opens a version read-only with what it changed, and goes back to the list', async () => {
    landAt('/agents/researcher/settings');
    serve();
    const { findByRole, findByTestId, queryByTestId } = mount();

    await fireEvent.click(await findByRole('button', { name: 'View Version 3' }));

    const view = await findByTestId('agent-version-view');
    expect(within(view).getByRole('heading', { name: 'Version 3' })).not.toBeNull();
    expect(view.textContent).toContain('read-only');
    expect(view.textContent).toContain('Changed from Version 2: Model: Haiku to Sonnet');
    expect(view.textContent).toContain('Version 4 is the current version.');
    expect(view.textContent).toContain(DEFINITION.instructions);
    expect(within(view).getByRole('button', { name: 'Restore Version 3' })).not.toBeNull();
    // The form is not shown while a version is open.
    expect(queryByTestId('agent-settings-form')).toBeNull();

    await fireEvent.click(within(view).getByRole('button', { name: /Versions/ }));
    await findByTestId('agent-settings-form');
  });

  test('asks before a restore, naming the changes it removes and the version it makes', async () => {
    landAt('/agents/researcher/settings');
    serve();
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('button', { name: 'Restore Version 3' }));
    const dialog = await findByRole('dialog', { name: 'Restore Version 3?' });
    expect(dialog.textContent).toContain(
      'Restoring Version 3 removes Version 4’s changes: Instructions and Tools. This makes Version 5, and Version 4 stays in the list.',
    );
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).not.toBeNull();
  });
});

describe('the delete question (row 39a)', () => {
  test('names the chats that stay and what stops finding the agent', async () => {
    landAt('/agents/researcher/settings');
    serve({
      'bureau.agents.references': () => ({
        agentName: 'researcher',
        schedules: [],
        workflows: [{ id: 'order-refund', title: 'Order refund' }],
        hooks: [],
      }),
    });
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.deleteAction }));
    const dialog = await findByRole('dialog', { name: 'Delete Researcher?' });
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        'Its 2 chats stay, read-only. Its versions and memories are deleted, and this can’t be undone. 1 workflow (Order refund) will stop finding it.',
      ),
    );
    expect(within(dialog).getByLabelText('Type researcher to confirm')).not.toBeNull();
  });
});

describe('what the Settings tab words and writes', () => {
  test('refuses a step limit that is not a whole number from 1 to 100, and takes an empty one as the default', () => {
    for (const text of ['0', '101', '2.5', 'twenty', '-3']) {
      expect(stepLimitError(text)).toBe(copy.stepLimitError(100));
    }
    for (const text of ['', '1', '20', '100']) expect(stepLimitError(text)).toBe('');
  });

  test('names the changed parts in the form’s order', () => {
    const baseline = settingsFormOf(DEFINITION);
    expect(changedParts(baseline, baseline)).toEqual([]);
    expect(changedParts(baseline, { ...baseline, stepLimit: '20', effort: 'high' })).toEqual([
      'Effort',
      'Step limit',
    ]);
    expect(changedParts(baseline, { ...baseline, models: ['anthropic/haiku'] })).toEqual([
      'Can switch to',
    ]);
  });

  test('writes the file’s definition with the settings, an empty list as null and no effort left out', () => {
    const form = { ...settingsFormOf(DEFINITION), stepLimit: '' };
    expect(settingsDefinition(DEFINITION, form)).toEqual({
      name: DEFINITION.name,
      description: DEFINITION.description,
      model: 'anthropic/sonnet',
      models: null,
      tools: DEFINITION.tools,
      card: DEFINITION.card,
      a2a: DEFINITION.a2a,
      limits: { steps: null },
      instructions: DEFINITION.instructions,
    });
  });

  test('carries back what the tab does not edit, and keeps a step limit past 100 the file already has', () => {
    const file = {
      ...DEFINITION,
      effort: 'low' as const,
      skills: ['summarize'],
      children: ['helper'],
      guardrails: ['acme:tripwire'],
      approvals: { 'lookup-order': 'always' as const },
      limits: { steps: 200, cost: null, tools: null },
    };
    const form = settingsFormOf(file);
    expect(stepLimitError(form.stepLimit, form.stepLimit)).toBe('');
    expect(stepLimitError('300', form.stepLimit)).toBe(copy.stepLimitError(100));
    const written = settingsDefinition(file, form);
    expect(written).toMatchObject({
      effort: 'low',
      skills: ['summarize'],
      children: ['helper'],
      guardrails: ['acme:tripwire'],
      approvals: { 'lookup-order': 'always' },
      limits: { steps: 200 },
    });
    expect(settingsDefinition({ ...file }, { ...form, effort: '' }).effort).toBeNull();
  });

  test('offers Low, Medium and High when the model’s efforts are not known, and always the one held', () => {
    expect(effortChoices(undefined, '')).toEqual(['low', 'medium', 'high']);
    expect(effortChoices(['low', 'high'], 'max')).toEqual(['low', 'high', 'max']);
  });

  test('names a model and its provider without a middle dot', () => {
    expect(modelLineOf('anthropic/claude-sonnet-5-5')).toBe('Claude Sonnet 5.5, Anthropic');
  });

  test('words what each version changed, and what a restore removes', () => {
    expect(versionChanges(VERSIONS[1] as AgentVersion, VERSIONS[2])).toBe('Model: Haiku to Sonnet');
    expect(versionChanges(VERSIONS[0] as AgentVersion, VERSIONS[1])).toBe(
      'Instructions: changed; Tools: added Issue refund',
    );
    expect(versionChanges(VERSIONS[3] as AgentVersion, undefined)).toBe('Created');
    expect(restoredChanges(VERSIONS, 2)).toBe('Instructions, Tools and Model');
  });

  test('names what finds an agent, by name or by identifier', () => {
    expect(dependentsLine(undefined)).toBe('');
    expect(
      dependentsLine({
        schedules: [{ id: 'weekly', name: 'Weekly refund audit' }],
        workflows: [{ id: 'order-refund', title: 'Order refund' }],
        hooks: [{ id: 'hook-1', name: null }],
      }),
    ).toBe('1 schedule (Weekly refund audit), 1 workflow (Order refund) and 1 hook (hook-1)');
  });
});
