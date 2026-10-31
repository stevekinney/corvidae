/**
 * The agent editor page against a stand-in for the Bureau's management plane: what the form offers
 * from the catalog, what a save sends, what deleting names, and the states a write can end in.
 * Every write names the `hash` the form was filled from, a save carries the A2A switch with the
 * rest of the definition, and `skillDescriptors` comes back as it was read.
 */
import { focusManager } from '@tanstack/svelte-query';
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import type { AgentCatalog, AgentDetail } from '../../lib/agent-definitions.ts';
import {
  catalogFixture,
  faults,
  installBureauStub,
  readyAgent,
  STUB_AGENT_DIRECTORY,
  STUB_CONFIGURATION_FILE,
  STUB_PROVIDERS,
  STUB_REMOTE_AGENT_DIRECTORY,
  STUB_REMOTE_CONFIGURATION_FILE,
  STUB_REMOTE_PROVIDERS,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { shortcuts } from '../../lib/shortcuts.ts';
import Harness from './agent-editor-test-harness.test-harness.svelte';

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

/** The Bureau for one test: an agent that exists (or none), a catalog, and no runs. */
function bureau(
  options: {
    readonly agent?: AgentDetail;
    /** The catalog, or a function that answers with the catalog as it is at each read. */
    readonly catalog?: AgentCatalog | (() => AgentCatalog);
    readonly hostPaths?: string | null;
    readonly hostMode?: 'local' | 'remote';
    /** The saved versions, newest first. */
    readonly versions?: readonly unknown[];
  } = {},
): BureauStub {
  const agent = options.agent ?? readyAgent();
  stub = installBureauStub(
    {
      'bureau.agents.catalog': () =>
        typeof options.catalog === 'function'
          ? options.catalog()
          : (options.catalog ?? catalogFixture()),
      'bureau.agents.definitions.get': () => agent,
      'bureau.agents.definitions.revisions': () => ({ revisions: [] }),
      'bureau.agents.versions.list': () => ({ versions: options.versions ?? [] }),
      'bureau.agents.definitions.create': (params) => ({
        id: String(params['id']),
        hash: 'created',
      }),
      'bureau.agents.definitions.update': () => ({ id: agent.id, hash: 'hash-2' }),
      'bureau.agents.definitions.delete': () => ({ id: agent.id, hash: 'deleted' }),
    },
    {
      ...(options.hostPaths === undefined ? {} : { hostPaths: options.hostPaths }),
      ...(options.hostMode === undefined ? {} : { hostMode: options.hostMode }),
    },
  );
  return stub;
}

function mountEditor(id?: string) {
  return render(Harness, { props: id === undefined ? {} : { id } } as never);
}

async function type(element: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(element, { target: { value } });
}

describe('a new agent', () => {
  test('says so when the installation offers no tools, in an empty state', async () => {
    bureau({ catalog: catalogFixture({ tools: [] }) });
    const { findByRole, container } = mountEditor();
    await findByRole('heading', { level: 3, name: AGENT_EDITOR_COPY.noTools });
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
  });

  test('offers exactly the models and tools the catalog lists', async () => {
    bureau({
      catalog: catalogFixture({
        models: [
          { provider: 'openai', model: 'gpt-4.1', aliases: [] },
          { provider: 'anthropic', model: 'claude-haiku-5', aliases: [] },
        ],
        tools: [
          { name: 'lookup-order', description: 'Look an order up.', shortDescription: null },
          { name: 'issue-refund', description: 'Refund an order.', shortDescription: null },
        ],
      }),
    });
    const { findByRole, getAllByRole, getByRole } = mountEditor();
    const select = await findByRole('combobox', { name: 'Model' });

    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['openai/gpt-4.1', 'anthropic/claude-haiku-5']);
    expect(getAllByRole('checkbox').map((box) => box.getAttribute('id'))).toEqual([
      'agent-tool-lookup-order',
      'agent-tool-issue-refund',
    ]);
    expect(getByRole('checkbox', { name: /lookup-order/ })).not.toBeNull();
    expect(
      getByRole('heading', { level: 1, name: AGENT_EDITOR_COPY.createHeading }),
    ).not.toBeNull();
  });

  test('shows where to add a provider, with this installation’s paths and no form, when the catalog holds no model', async () => {
    bureau({ catalog: catalogFixture({ models: [] }) });
    const { findByRole, getByTestId, getByRole, queryAllByRole, queryByRole, container } =
      mountEditor();

    expect(
      await findByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title }),
    ).not.toBeNull();
    expect(container.textContent).toContain(AGENT_EDITOR_COPY.noProvider.description);
    // The paths are the host's, not the page's: each one comes from `/host/paths`.
    expect(getByTestId('provider-configuration-file').textContent).toBe(STUB_CONFIGURATION_FILE);
    for (const provider of STUB_PROVIDERS) {
      const row = container.querySelector(`[data-provider="${provider.name}"]`);
      expect(row?.textContent).toContain(provider.secretFile);
    }
    expect(container.textContent).toContain('"plugins"');
    expect(container.textContent).toContain('"anthropic": {}');
    expect(container.textContent).toContain('chmod 600');
    expect(getByRole('button', { name: AGENT_EDITOR_COPY.noProvider.reload })).not.toBeNull();
    // Nothing to fill in: no field, no model choice, no save.
    expect(queryAllByRole('textbox')).toEqual([]);
    expect(queryByRole('combobox')).toBeNull();
    expect(queryByRole('form')).toBeNull();
    expect(queryByRole('button', { name: AGENT_EDITOR_COPY.createAction })).toBeNull();
  });

  test('builds the form when a provider has been added and the page is reloaded', async () => {
    let catalog = catalogFixture({ models: [] });
    bureau({ catalog: () => catalog });
    const { findByRole, getByRole, queryByRole } = mountEditor();

    await fireEvent.click(
      await findByRole('button', { name: AGENT_EDITOR_COPY.noProvider.reload }),
    );
    expect(queryByRole('form')).toBeNull();

    // The button is disabled while the catalog is being read, so a second click waits for the first.
    await waitFor(() =>
      expect(getByRole('button', { name: AGENT_EDITOR_COPY.noProvider.reload })).toBeEnabled(),
    );
    catalog = catalogFixture();
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.noProvider.reload }));
    const model = await findByRole('combobox', { name: 'Model' });
    expect(model).not.toBeNull();
    expect(queryByRole('button', { name: AGENT_EDITOR_COPY.noProvider.reload })).toBeNull();
  });

  test('reads the catalog again when the window is focused, while it offers no model', async () => {
    let catalog = catalogFixture({ models: [] });
    const calls = bureau({ catalog: () => catalog });
    const { findByRole, queryByRole } = mountEditor();
    await findByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title });
    const reads = () => calls.callsTo('bureau.agents.catalog').length;
    const before = reads();

    catalog = catalogFixture();
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    expect(await findByRole('combobox', { name: 'Model' })).not.toBeNull();
    expect(queryByRole('heading', { name: AGENT_EDITOR_COPY.noProvider.title })).toBeNull();
    const afterForm = reads();
    expect(afterForm).toBeGreaterThan(before);

    // With a form on screen, a focus must not read the catalog and change the form's choices.
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await findByRole('combobox', { name: 'Model' });
    expect(reads()).toBe(afterForm);
  });

  test('names no path when the host did not say where its files are', async () => {
    bureau({ catalog: catalogFixture({ models: [] }), hostPaths: null });
    const { findByRole, queryByTestId, container } = mountEditor();

    await findByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title });
    expect(queryByTestId('provider-configuration-file')).toBeNull();
    expect(container.textContent).not.toContain('/home/');
  });

  test('shows one line for each tool, and the full text only on request', async () => {
    const prompt =
      'Create a workflow: a JSON file of a trigger and steps that Bureau runs. `name` is what the workflow is called, and its identifier is derived from it (lowercase, with runs of other characters turned into one hyphen) unless you give `id`.';
    bureau({
      catalog: catalogFixture({
        tools: [
          {
            name: 'lookup-order',
            description: 'Look an order up by its identifier.',
            shortDescription: null,
          },
          {
            name: 'workflows-create',
            description: prompt,
            shortDescription: 'Create a workflow Bureau runs on a schedule or a signal.',
          },
          { name: 'draft-reply', description: `${prompt} ${prompt}`, shortDescription: null },
        ],
      }),
    });
    const { findByRole, getAllByTestId, getByText, queryAllByTestId } = mountEditor();
    await findByRole('checkbox', { name: /workflows-create/ });

    const lines = getAllByTestId('agent-tool-line').map((line) => line.textContent ?? '');
    expect(lines[0]).toBe('Look an order up by its identifier.');
    expect(lines[1]).toBe('Create a workflow Bureau runs on a schedule or a signal.');
    // A tool with no line of its own shows its description cut to 120 characters.
    expect(Array.from(lines[2] ?? '').length).toBeLessThanOrEqual(120);
    expect(lines[2]?.endsWith('…')).toBe(true);
    for (const line of lines) expect(Array.from(line).length).toBeLessThanOrEqual(120);
    // The prompt is not on the page until someone opens the disclosure beside the tool.
    expect(queryAllByTestId('agent-tool-full')).toEqual([]);
    const disclosures = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.weft-tool-row button[aria-expanded]'),
    );
    expect(disclosures).toHaveLength(2);
    expect(disclosures.map((button) => button.textContent?.trim())).toEqual([
      AGENT_EDITOR_COPY.toolDisclosure,
      AGENT_EDITOR_COPY.toolDisclosure,
    ]);
    await fireEvent.click(disclosures[0] as HTMLButtonElement);
    expect(getByText(prompt)).not.toBeNull();
  });

  test('fills the identifier from the name until it is edited, and creates the agent', async () => {
    const calls = bureau();
    const { findByRole, getByRole } = mountEditor();
    const name = await findByRole('textbox', { name: /^Name/ });
    const identifier = getByRole('textbox', { name: /^Identifier/ }) as HTMLInputElement;

    await type(name, 'Research Assistant');
    expect(identifier.value).toBe('research-assistant');
    await type(identifier, 'helper');
    await type(name, 'Something Else');
    expect(identifier.value).toBe('helper');

    await type(getByRole('textbox', { name: /^Instructions/ }), 'Be careful.');
    await fireEvent.click(getByRole('checkbox', { name: /lookup-order/ }));
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.createAction }));

    await waitFor(() => expect(router.pathname).toBe('/agents/helper'));
    expect(calls.callsTo('bureau.agents.definitions.create')).toEqual([
      {
        method: 'bureau.agents.definitions.create',
        params: {
          id: 'helper',
          definition: {
            name: 'Something Else',
            description: null,
            model: 'anthropic/claude-sonnet-5',
            tools: ['lookup-order'],
            skillDescriptors: [],
            a2a: false,
            guardrails: null,
            stepLimit: null,
            costBudget: null,
            toolBudget: null,
            instructions: 'Be careful.',
          },
        },
      },
    ]);
  });

  test('refuses a name that makes the identifier new, and says why', async () => {
    bureau();
    const { findByRole, getByRole, findByText } = mountEditor();
    await type(await findByRole('textbox', { name: /^Name/ }), 'New');

    expect(await findByText(AGENT_EDITOR_COPY.identifierReserved)).not.toBeNull();
    expect(getByRole('button', { name: AGENT_EDITOR_COPY.createAction })).toBeDisabled();
  });

  test('shows the file an identifier makes, and has no delete or history', async () => {
    bureau();
    const { findByRole, getByTestId, queryByRole, queryByText } = mountEditor();
    await type(await findByRole('textbox', { name: /^Name/ }), 'Research Assistant');

    expect(getByTestId('agent-file-path').textContent).toBe(
      `${STUB_AGENT_DIRECTORY}/research-assistant.md`,
    );
    expect(queryByText(AGENT_EDITOR_COPY.revisions.heading)).toBeNull();
    expect(queryByRole('button', { name: AGENT_EDITOR_COPY.deleteAction })).toBeNull();
  });

  for (const reason of ['agent-file-exists', 'shadows-code-agent'] as const) {
    test(`reports a taken identifier (${reason}) on the identifier field and writes nothing else`, async () => {
      const calls = bureau();
      calls.on('bureau.agents.definitions.create', () => {
        throw faults.taken(reason);
      });
      const { findByRole, findByText, getByRole } = mountEditor();
      await type(await findByRole('textbox', { name: /^Name/ }), 'Assistant');
      await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.createAction }));

      const message = AGENT_EDITOR_COPY.identifierTaken[reason];
      await findByText(message);
      expect(getByRole('textbox', { name: /^Identifier/ })).toBeInvalid();
      expect(getByRole('textbox', { name: /^Identifier/ })).toHaveAccessibleDescription(
        expect.stringContaining(message),
      );
      expect(calls.callsTo('bureau.agents.definitions.create')).toHaveLength(1);
      expect(calls.calls.filter((call) => call.method.includes('update'))).toEqual([]);
      expect(router.pathname).toBe('/');

      // Changing the identifier clears the answer, and the new one is sent.
      await type(getByRole('textbox', { name: /^Identifier/ }), 'assistant-2');
      expect(getByRole('textbox', { name: /^Identifier/ })).not.toBeInvalid();
    });
  }

  test('shows the Bureau’s reason when it will not write the definition', async () => {
    const calls = bureau();
    calls.on('bureau.agents.definitions.create', () => {
      throw faults.unprocessable('The model is not offered.');
    });
    const { findByRole, getByRole, findByText } = mountEditor();
    await type(await findByRole('textbox', { name: /^Name/ }), 'Researcher');
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.createAction }));

    expect(await findByText('The model is not offered.')).not.toBeNull();
    expect(getByRole('alert').textContent).toContain(AGENT_EDITOR_COPY.saveFailed);
    expect(router.pathname).toBe('/');
  });

  test('says so when the caller may not write agents', async () => {
    const calls = bureau();
    calls.on('bureau.agents.definitions.create', () => {
      throw new StubFault('Forbidden', 403, 'Creating an agent requires bureau.agents:write');
    });
    const { findByRole, getByRole, findByText } = mountEditor();
    await type(await findByRole('textbox', { name: /^Name/ }), 'Researcher');
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.createAction }));
    expect(await findByText('This installation does not let you change agents.')).not.toBeNull();
  });
});

describe('an agent that exists', () => {
  test('fills the form from its file, shows where the file is, and fixes the identifier', async () => {
    bureau();
    const { findByRole, getByRole, getByTestId } = mountEditor('researcher');

    expect(await findByRole('heading', { level: 1, name: 'Edit Researcher' })).not.toBeNull();
    expect(getByRole('textbox', { name: /^Name/ })).toHaveValue('Researcher');
    expect(getByRole('textbox', { name: /^Description/ })).toHaveValue('Finds and cites sources');
    expect(getByRole('textbox', { name: /^Instructions/ })).toHaveValue(
      'You are a careful researcher.',
    );
    expect(getByRole('combobox', { name: 'Model' })).toHaveValue('anthropic/claude-sonnet-5');
    expect(getByRole('checkbox', { name: /lookup-order/ })).toBeChecked();
    expect(getByRole('textbox', { name: /^Identifier/ })).toHaveAttribute('readonly');
    expect(getByTestId('agent-file-path').textContent).toBe(
      `${STUB_AGENT_DIRECTORY}/researcher.md`,
    );
  });

  test('shows the file relative to the state directory when the host does not say where it is', async () => {
    bureau({ hostPaths: null });
    const { findByTestId } = mountEditor('researcher');
    const path = await findByTestId('agent-file-path');
    expect(path.textContent).toBe('agents/researcher.md');
  });

  test('saves with the hash it read, keeps the skill descriptors, and sends the A2A opt-in', async () => {
    const calls = bureau({
      agent: readyAgent({ a2a: true, definition: { ...readyAgent().definition!, a2a: true } }),
    });
    const { findByRole, getByRole } = mountEditor('researcher');
    await type(await findByRole('textbox', { name: /^Instructions/ }), 'Changed.');
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));

    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params).toEqual({
      id: 'researcher',
      expectedHash: 'hash-1',
      definition: {
        name: 'Researcher',
        description: 'Finds and cites sources',
        // The file wrote an alias, and an unchanged model is written back as it was.
        model: 'anthropic/sonnet',
        tools: ['lookup-order'],
        skillDescriptors: [
          {
            id: 'cite',
            name: 'Cite',
            description: 'Cites the sources it used',
            tags: ['research'],
          },
        ],
        a2a: true,
        guardrails: null,
        stepLimit: null,
        costBudget: null,
        toolBudget: null,
        instructions: 'Changed.',
      },
    });
  });

  test('keeps an unknown key of a skill when the agent is saved', async () => {
    const detail = readyAgent();
    const skill = { id: 'cite', name: 'Cite', description: 'Cites', tags: ['x'], futureKey: 7 };
    const calls = bureau({
      agent: {
        ...detail,
        definition: detail.definition && { ...detail.definition, skillDescriptors: [skill] },
      },
    });
    const { findByRole, getByRole } = mountEditor('researcher');
    await findByRole('textbox', { name: /^Instructions/ });
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params['definition']).toMatchObject({ skillDescriptors: [skill] });
  });

  test('sends the model it was changed to, and only a model the catalog offers can be chosen', async () => {
    const calls = bureau();
    const { findByRole, getByRole } = mountEditor('researcher');
    const select = await findByRole('combobox', { name: 'Model' });
    expect(within(select).getAllByRole('option')).toHaveLength(2);
    await fireEvent.change(select, { target: { value: 'anthropic/claude-haiku-5' } });
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params['definition']).toMatchObject({ model: 'anthropic/claude-haiku-5' });
  });

  test('saves the A2A switch with the rest of the definition, for an agent that exists', async () => {
    const calls = bureau();
    const { findByRole, getByRole } = mountEditor('researcher');
    const a2a = await findByRole('switch', { name: AGENT_EDITOR_COPY.a2aLabel });
    expect(a2a).toHaveAttribute('aria-checked', 'false');

    await fireEvent.click(a2a);
    await waitFor(() => expect(a2a).toHaveAttribute('aria-checked', 'true'));
    // Turning the switch sends nothing: it is saved with the definition.
    expect(calls.callsTo('bureau.agents.definitions.update')).toEqual([]);
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));

    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params['expectedHash']).toBe('hash-1');
    expect(update?.params['definition']).toMatchObject({ a2a: true });
  });

  test('keeps unsaved edits when the A2A switch changes', async () => {
    const calls = bureau();
    const { findByRole, getByRole } = mountEditor('researcher');
    await type(await findByRole('textbox', { name: /^Instructions/ }), 'Unsaved.');
    const a2a = getByRole('switch', { name: AGENT_EDITOR_COPY.a2aLabel });
    await fireEvent.click(a2a);
    await waitFor(() => expect(a2a).toHaveAttribute('aria-checked', 'true'));

    expect(getByRole('textbox', { name: /^Instructions/ })).toHaveValue('Unsaved.');
    expect(calls.callsTo('bureau.agents.definitions.update')).toEqual([]);
  });
});

describe('a file that changed outside Interborough', () => {
  test('is not overwritten by a save, and says so once, with a reload that discards unsaved edits', async () => {
    const calls = bureau();
    const { findByRole, getByRole, container, findByText } = mountEditor('researcher');
    await type(await findByRole('textbox', { name: /^Instructions/ }), 'My edit.');
    calls.on('bureau.agents.definitions.update', () => {
      throw faults.stale('hash-on-disk', 'hash-1');
    });
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));

    expect(await findByText(AGENT_EDITOR_COPY.stale.title)).not.toBeNull();
    expect(container.querySelector('[data-editor]')?.getAttribute('data-editor')).toBe('stale');
    expect(container.textContent).toContain('discards your unsaved edits');
    expect(router.pathname).toBe('/');
    expect(calls.callsTo('bureau.agents.definitions.update')).toHaveLength(1);
    // The form still holds the edit until the reload.
    expect(getByRole('textbox', { name: /^Instructions/ })).toHaveValue('My edit.');

    // The file on disk now says something else, and so does its hash.
    calls.on('bureau.agents.definitions.get', () =>
      readyAgent({
        hash: 'hash-on-disk',
        definition: {
          ...readyAgent().definition!,
          instructions: 'Edited on disk.',
        },
      }),
    );
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.stale.action }));

    await waitFor(() =>
      expect(container.querySelector('[data-editor]')?.getAttribute('data-editor')).toBe('ready'),
    );
    expect(getByRole('textbox', { name: /^Instructions/ })).toHaveValue('Edited on disk.');

    // A save after the reload names the hash that is on disk.
    calls.on('bureau.agents.definitions.update', () => ({ id: 'researcher', hash: 'hash-3' }));
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    expect(calls.callsTo('bureau.agents.definitions.update')[1]?.params['expectedHash']).toBe(
      'hash-on-disk',
    );
  });
});

describe('deleting an agent', () => {
  test('asks first, sends nothing until it is confirmed, and then names the hash and lands on the list', async () => {
    const calls = bureau();
    const { findByRole, getByRole } = mountEditor('researcher');
    await fireEvent.click(await findByRole('button', { name: AGENT_EDITOR_COPY.deleteAction }));

    const dialog = await findByRole('dialog', { name: AGENT_EDITOR_COPY.deleteDialog.title });
    expect(dialog.textContent).toContain(AGENT_EDITOR_COPY.deleteDialog.description('Researcher'));
    expect(calls.callsTo('bureau.agents.definitions.delete')).toEqual([]);

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.callsTo('bureau.agents.definitions.delete')).toEqual([]);
    expect(router.pathname).toBe('/');

    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.deleteAction }));
    const again = await findByRole('dialog', { name: AGENT_EDITOR_COPY.deleteDialog.title });
    await fireEvent.click(
      within(again).getByRole('button', { name: AGENT_EDITOR_COPY.deleteDialog.confirm }),
    );

    await waitFor(() => expect(router.pathname).toBe('/agents'));
    expect(calls.callsTo('bureau.agents.definitions.delete')).toEqual([
      {
        method: 'bureau.agents.definitions.delete',
        params: { id: 'researcher', expectedHash: 'hash-1' },
      },
    ]);
  });

  test('shows the changed-outside state, and deletes nothing, when the file changed first', async () => {
    const calls = bureau();
    calls.on('bureau.agents.definitions.delete', () => {
      throw faults.stale('hash-on-disk');
    });
    const { findByRole, findByText } = mountEditor('researcher');
    await fireEvent.click(await findByRole('button', { name: AGENT_EDITOR_COPY.deleteAction }));
    const dialog = await findByRole('dialog', { name: AGENT_EDITOR_COPY.deleteDialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: AGENT_EDITOR_COPY.deleteDialog.confirm }),
    );

    expect(await findByText(AGENT_EDITOR_COPY.stale.title)).not.toBeNull();
    expect(router.pathname).toBe('/');
  });

  test('reports a failure it cannot sort, in the Bureau’s words', async () => {
    const calls = bureau();
    calls.on('bureau.agents.definitions.delete', () => {
      throw new StubFault('EngineFailure', 500, 'The disk is full.');
    });
    const { findByRole, findByText, getByRole } = mountEditor('researcher');
    await fireEvent.click(await findByRole('button', { name: AGENT_EDITOR_COPY.deleteAction }));
    const dialog = await findByRole('dialog', { name: AGENT_EDITOR_COPY.deleteDialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: AGENT_EDITOR_COPY.deleteDialog.confirm }),
    );

    expect(await findByText('The disk is full.')).not.toBeNull();
    expect(getByRole('alert').textContent).toContain(AGENT_EDITOR_COPY.deleteFailed);
    expect(router.pathname).toBe('/');
  });
});

describe('the delete in the page header', () => {
  const deleteButton = { name: AGENT_EDITOR_COPY.deleteAction };

  test('is not shown while the catalog is still being read, and the footer holds it once the form is built', async () => {
    const calls = bureau();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    calls.on('bureau.agents.catalog', async () => {
      await held;
      return catalogFixture();
    });
    const { findByRole, queryAllByRole, container } = mountEditor('researcher');

    try {
      // The agent has arrived and the catalog has not: the page does not know yet which state it is in.
      await waitFor(() => expect(calls.callsTo('bureau.agents.definitions.get')).toHaveLength(1));
      await waitFor(() => expect(container.querySelector('[role="status"]')).not.toBeNull());
      expect(queryAllByRole('button', deleteButton).length).toBe(0);
    } finally {
      // A failed assertion must not leave the catalog held, or the test never ends.
      release();
    }
    await findByRole('form', { name: AGENT_EDITOR_COPY.formLabel });
    // One delete, in the form's footer, not a second one in the header.
    expect(queryAllByRole('button', deleteButton).length).toBe(1);
    expect(container.querySelector('.weft-agent-form__footer')?.textContent).toContain(
      AGENT_EDITOR_COPY.deleteAction,
    );
  });

  test('is not shown when the catalog cannot be read', async () => {
    const calls = bureau();
    calls.on('bureau.agents.catalog', () => {
      throw new StubFault('EngineFailure', 500, 'The Bureau is down.');
    });
    const { findByText, queryAllByRole } = mountEditor('researcher');
    expect(await findByText(AGENT_EDITOR_COPY.loadFailed.title)).not.toBeNull();
    expect(queryAllByRole('button', deleteButton).length).toBe(0);
  });

  test('is shown for an existing agent when no provider means the form cannot be', async () => {
    bureau({ catalog: catalogFixture({ models: [] }) });
    const { findByRole, queryAllByRole } = mountEditor('researcher');
    await findByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title });
    expect(queryAllByRole('button', deleteButton).length).toBe(1);
  });
});

describe('a file the Bureau cannot use', () => {
  const invalid = readyAgent({
    state: 'invalid',
    hash: 'hash-bad',
    definition: null,
    problem: {
      code: 'unknown-model',
      message: 'The model "gpt-9" is not in the catalog.',
      issues: [{ path: 'model', message: 'not offered' }],
    },
  });

  test('opens in an error state with the problem and the file’s path, and no form', async () => {
    bureau({ agent: invalid });
    const { findByTestId, container, queryByRole, getByRole, getByTestId } =
      mountEditor('researcher');

    const problem = await findByTestId('agent-problem');
    expect(problem.textContent).toContain('unknown-model');
    expect(container.textContent).toContain('The model "gpt-9" is not in the catalog.');
    expect(container.textContent).toContain('not offered');
    expect(container.querySelector('[data-editor]')?.getAttribute('data-editor')).toBe('invalid');
    expect(getByTestId('agent-file-path').textContent).toBe(
      `${STUB_AGENT_DIRECTORY}/researcher.md`,
    );
    expect(queryByRole('textbox', { name: /^Instructions/ })).toBeNull();
    expect(getByRole('button', { name: AGENT_EDITOR_COPY.invalid.action })).not.toBeNull();
  });

  test('can still be deleted, with the hash it has, and a reload that finds it fixed shows the form', async () => {
    const calls = bureau({ agent: invalid });
    const { findByRole, getByRole } = mountEditor('researcher');
    await fireEvent.click(await findByRole('button', { name: AGENT_EDITOR_COPY.deleteAction }));
    const dialog = await findByRole('dialog', { name: AGENT_EDITOR_COPY.deleteDialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: AGENT_EDITOR_COPY.deleteDialog.confirm }),
    );
    await waitFor(() => expect(router.pathname).toBe('/agents'));
    expect(calls.callsTo('bureau.agents.definitions.delete')[0]?.params['expectedHash']).toBe(
      'hash-bad',
    );
    expect(getByRole('heading', { level: 1 })).not.toBeNull();
  });

  test('turns into the form when it is fixed on disk and reloaded', async () => {
    const calls = bureau({ agent: invalid });
    const { findByRole, getByRole } = mountEditor('researcher');
    await findByRole('button', { name: AGENT_EDITOR_COPY.invalid.action });
    calls.on('bureau.agents.definitions.get', () => readyAgent({ hash: 'hash-fixed' }));
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.invalid.action }));
    expect(await findByRole('textbox', { name: /^Instructions/ })).toHaveValue(
      'You are a careful researcher.',
    );
  });

  test('is the invalid state again when a reload finds it still broken', async () => {
    const calls = bureau({ agent: invalid });
    const { findByRole, getByRole, findByTestId } = mountEditor('researcher');
    await findByRole('button', { name: AGENT_EDITOR_COPY.invalid.action });
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.invalid.action }));
    await waitFor(() => expect(calls.callsTo('bureau.agents.definitions.get')).toHaveLength(2));
    expect(await findByTestId('agent-problem')).not.toBeNull();
  });
});

describe('a Bureau that does not answer', () => {
  test('says the agent could not be loaded, and asks again when told to', async () => {
    const calls = bureau();
    calls.on('bureau.agents.catalog', () => {
      throw new StubFault('EngineFailure', 500, 'The Bureau is down.');
    });
    const { findByText, getByRole } = mountEditor('researcher');
    expect(await findByText(AGENT_EDITOR_COPY.loadFailed.title)).not.toBeNull();

    calls.on('bureau.agents.catalog', () => catalogFixture());
    await fireEvent.click(getByRole('button', { name: 'Try again' }));
    expect(await findByText(AGENT_EDITOR_COPY.saveAction)).not.toBeNull();
  });
});

/**
 * COR-1764: a host that keeps its state in Postgres and a bucket says `mode: 'remote'` in
 * `/host/paths`, and the words that name a place to look change with it. Everything else does not.
 */
describe.each(['local', 'remote'] as const)('the agent editor on a %s host', (mode) => {
  const other = mode === 'local' ? 'remote' : 'local';
  const words = {
    local: {
      label: AGENT_EDITOR_COPY.fileLabel,
      configurationStep: AGENT_EDITOR_COPY.noProvider.configurationStep,
      secretStep: AGENT_EDITOR_COPY.noProvider.secretStep,
    },
    remote: {
      label: AGENT_EDITOR_COPY.remote.fileLabel,
      configurationStep: AGENT_EDITOR_COPY.remote.noProvider.configurationStep,
      secretStep: AGENT_EDITOR_COPY.remote.noProvider.secretStep,
    },
  } as const;

  test('labels an agent’s location with the words of its mode, and shows the host’s location verbatim', async () => {
    bureau({ hostMode: mode });
    const { findByTestId, container } = mountEditor('researcher');
    const path = await findByTestId('agent-file-path');

    const label = container.querySelector('.weft-agent-editor__path span')?.textContent;
    expect(label).toBe(words[mode].label);
    expect(label).not.toBe(words[other].label);
    expect(path.textContent).toBe(
      mode === 'remote'
        ? `${STUB_REMOTE_AGENT_DIRECTORY}researcher.md`
        : `${STUB_AGENT_DIRECTORY}/researcher.md`,
    );
  });

  test('says where to configure a provider, and where its key goes, in the words of its mode', async () => {
    bureau({ catalog: catalogFixture({ models: [] }), hostMode: mode });
    const { findByRole, getByTestId, container } = mountEditor();
    await findByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title });

    const text = container.textContent ?? '';
    expect(text).toContain(words[mode].configurationStep);
    expect(text).toContain(words[mode].secretStep);
    expect(text).not.toContain(words[other].configurationStep);
    expect(text).not.toContain(words[other].secretStep);
    // The chmod sentence is the local secret step's; it never appears in remote mode.
    expect(text.includes('chmod 600')).toBe(mode === 'local');
    expect(getByTestId('provider-configuration-file').textContent).toBe(
      mode === 'remote' ? STUB_REMOTE_CONFIGURATION_FILE : STUB_CONFIGURATION_FILE,
    );
    for (const provider of mode === 'remote' ? STUB_REMOTE_PROVIDERS : STUB_PROVIDERS) {
      expect(container.querySelector(`[data-provider="${provider.name}"]`)?.textContent).toContain(
        provider.secretFile,
      );
    }
  });
});

describe('the header Save', () => {
  /** Reads ⌘Enter against the shortcut registry as the shell does (`shell.svelte`). */
  function pressCommandEnter(routePattern: string): boolean {
    return shortcuts.handleKey(
      { key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, editable: true },
      { routePattern, regions: [] },
      Date.now(),
    );
  }

  test('is the only Save, sits in the header, and submits the form', async () => {
    const calls = bureau();
    const { findByRole, getByRole, getAllByRole } = mountEditor('researcher');
    await type(await findByRole('textbox', { name: /^Instructions/ }), 'Changed.');
    const save = getByRole('button', { name: AGENT_EDITOR_COPY.saveAction });
    const form = getByRole('form', { name: AGENT_EDITOR_COPY.formLabel });

    expect(getAllByRole('button', { name: AGENT_EDITOR_COPY.saveAction })).toHaveLength(1);
    expect(form.contains(save)).toBe(false);
    expect(save.getAttribute('form')).toBe(form.id);
    expect(save.hasAttribute('data-changes')).toBe(true);
    await fireEvent.click(save);
    await waitFor(() => expect(calls.callsTo('bureau.agents.definitions.update')).toHaveLength(1));
  });

  test('says when the agent was last saved and links to its versions on the Settings tab', async () => {
    bureau({
      versions: [
        {
          revision: 4,
          hash: 'hash-1',
          savedAt: new Date(Date.now() - 120_000).toISOString(),
          savedBy: null,
          definition: readyAgent().definition,
          changedKeys: [],
        },
      ],
    });
    const { findByTestId } = mountEditor('researcher');
    const saved = await findByTestId('agent-saved');
    expect(saved.textContent).toContain(AGENT_EDITOR_COPY.saved);
    expect(saved.textContent).toContain('2 minutes ago');
    const link = saved.querySelector('a');
    expect(link?.textContent).toBe(AGENT_EDITOR_COPY.version(4));
    expect(link?.getAttribute('href')).toContain('/agents/researcher?tab=settings');
  });

  test('opens the versions in the app, unless the click asks for a new tab', async () => {
    bureau({
      versions: [
        {
          revision: 2,
          hash: 'hash-1',
          savedAt: new Date().toISOString(),
          savedBy: null,
          definition: readyAgent().definition,
          changedKeys: [],
        },
      ],
    });
    const { findByRole } = mountEditor('researcher');
    const link = await findByRole('link', { name: AGENT_EDITOR_COPY.version(2) });

    await fireEvent.click(link, { metaKey: true });
    expect(router.pathname).not.toBe('/agents/researcher');
    await fireEvent.click(link);
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    expect(router.search.get('tab')).toBe('settings');
  });

  test('registers ⌘Enter, which saves from a field, and removes it when the page goes', async () => {
    const calls = bureau();
    const { findByRole, unmount } = mountEditor('researcher');
    await findByRole('textbox', { name: /^Instructions/ });
    expect(
      shortcuts
        .entries()
        .some(
          (entry) =>
            typeof entry.scope === 'object' &&
            'route' in entry.scope &&
            entry.scope.route === '/agents/:agent/edit',
        ),
    ).toBe(true);

    expect(pressCommandEnter('/agents/:agent/edit')).toBe(true);
    await waitFor(() => expect(calls.callsTo('bureau.agents.definitions.update')).toHaveLength(1));

    unmount();
    expect(pressCommandEnter('/agents/:agent/edit')).toBe(false);
  });

  test('does not save with ⌘Enter while a limit is wrong', async () => {
    const calls = bureau();
    const { findByRole, getByRole, findByText } = mountEditor('researcher');
    await type(await findByRole('textbox', { name: /^Steps per run/ }), '5000');
    await findByText(AGENT_EDITOR_COPY.limits.errors.stepLimit(1000));

    expect(pressCommandEnter('/agents/:agent/edit')).toBe(true);
    expect(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction })).toBeDisabled();
    expect(calls.callsTo('bureau.agents.definitions.update')).toEqual([]);
  });

  test('sends the limits it was given', async () => {
    const calls = bureau();
    const { findByRole, getByRole } = mountEditor('researcher');
    await type(await findByRole('textbox', { name: /^Steps per run/ }), '12');
    await type(getByRole('textbox', { name: /^Spend per run/ }), '1.5');
    await type(getByRole('textbox', { name: /^Tool calls per run/ }), '30');
    await type(getByRole('textbox', { name: /^Guardrails/ }), 'acme:tripwire');
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));

    await waitFor(() => expect(calls.callsTo('bureau.agents.definitions.update')).toHaveLength(1));
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params).toMatchObject({
      definition: {
        guardrails: ['acme:tripwire'],
        stepLimit: 12,
        costBudget: { perRunUsd: 1.5 },
        toolBudget: { maxCalls: 30 },
      },
    });
  });
});
