/**
 * The agent editor page against a stand-in for the Bureau's management plane: what the form offers
 * from the catalog, what a save sends, what deleting names, and the states a write can end in.
 * Every write names the `hash` the form was filled from, a save carries the A2A switch with the
 * rest of the definition, and `card` comes back as it was read.
 */
import { focusManager } from '@tanstack/svelte-query';
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
  STUB_AGENT_DIRECTORY,
  STUB_CONFIGURATION_FILE,
  STUB_PROVIDERS,
  STUB_REMOTE_AGENT_DIRECTORY,
  STUB_REMOTE_CONFIGURATION_FILE,
  STUB_REMOTE_PROVIDERS,
  StubFault,
  unkeyedModelFixtures,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { shortcuts } from '../../lib/shortcuts.ts';
import {
  chooseModel,
  openModelOptions,
  optionLabel,
} from './agent-editor-model-support.test-support.ts';
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
    /** The providers `/host/providers` reports. Left out, the host does not answer. */
    readonly hostProviders?: readonly {
      readonly name: string;
      readonly hasKey: boolean;
      readonly connected?: boolean;
    }[];
    /** The `modelPolicy` setting. Left out, the settings are not readable. */
    readonly modelPolicy?: unknown;
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
      ...(options.modelPolicy === undefined
        ? {}
        : {
            'bureau.settings.get': () => ({
              values: { modelPolicy: options.modelPolicy },
              effective: { modelPolicy: options.modelPolicy },
              running: { modelPolicy: options.modelPolicy },
              revision: 1,
              persisted: true,
              keys: {},
            }),
          }),
    },
    {
      ...(options.hostProviders === undefined ? {} : { hostProviders: options.hostProviders }),
      ...(options.hostPaths === undefined ? {} : { hostPaths: options.hostPaths }),
      ...(options.hostMode === undefined ? {} : { hostMode: options.hostMode }),
    },
  );
  return stub;
}

function mountEditor(id?: string) {
  return render(Harness, { props: id === undefined ? {} : { id } } as never);
}

type EditorQueries = ReturnType<typeof mountEditor>;

/** Opens the Add tools picker. */
async function openPicker(view: Pick<EditorQueries, 'getByRole'>): Promise<void> {
  await fireEvent.click(view.getByRole('button', { name: AGENT_EDITOR_COPY.addToolsAction }));
}

/** Closes the Add tools picker with Done. */
async function closePicker(view: Pick<EditorQueries, 'getByRole'>): Promise<void> {
  await fireEvent.click(view.getByRole('button', { name: AGENT_EDITOR_COPY.toolPicker.done }));
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
    const view = mountEditor();
    const { findByRole, getAllByRole, getByRole, getByTestId, queryAllByRole } = view;
    const select = await findByRole('combobox', { name: 'Model' });

    const listed = await openModelOptions(select);
    expect(listed.map(optionLabel)).toEqual(['openai/gpt-4.1', 'anthropic/claude-haiku-5']);
    // A new agent has no tool yet, and the picker offers every tool the catalog lists. The count
    // sits beside the Tools title (row 41k).
    expect(getByRole('group', { name: /^Tools/ }).textContent).toContain(
      AGENT_EDITOR_COPY.newAgent.toolCount(0, 2),
    );
    expect(getByTestId('agent-tools-none')).not.toBeNull();
    expect(queryAllByRole('checkbox')).toEqual([]);
    await openPicker(view);
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
    bureau({ catalog: catalogFixture({ models: unkeyedModelFixtures() }) });
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
    expect(container.textContent).toContain('"enabled": true');
    expect(container.textContent).toContain('chmod 600');
    expect(getByRole('button', { name: AGENT_EDITOR_COPY.noProvider.reload })).not.toBeNull();
    // The card says nothing else works until a provider is connected (row 42b).
    expect(getByTestId('agent-no-provider-blocked').textContent?.trim()).toBe(
      AGENT_EDITOR_COPY.noProvider.blocked,
    );
    // Nothing to fill in: no field, no model choice, no save; Cancel stays (row 42a).
    expect(queryAllByRole('textbox')).toEqual([]);
    expect(queryByRole('combobox')).toBeNull();
    expect(queryByRole('form')).toBeNull();
    expect(queryByRole('button', { name: AGENT_EDITOR_COPY.createAction })).toBeNull();
    expect(getByRole('button', { name: AGENT_EDITOR_COPY.cancelAction })).not.toBeNull();
  });

  test('shows the same state, with its connect link, for a catalog with no row at all', async () => {
    bureau({ catalog: catalogFixture({ models: [] }) });
    const { findByRole } = mountEditor();

    await findByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title });
    expect(await findByRole('link', { name: AGENT_EDITOR_COPY.noProvider.connectAction })).not.toBe(
      null,
    );
  });

  test('shows the no-provider state, not an empty form, for a catalog whose every row is unavailable', async () => {
    // A home with the bundled providers and no key keeps all of their rows, marked unavailable.
    bureau({ catalog: catalogFixture({ models: unkeyedModelFixtures() }) });
    const { findByRole, queryByRole } = mountEditor();

    await findByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title });
    expect(await findByRole('link', { name: AGENT_EDITOR_COPY.noProvider.connectAction })).not.toBe(
      null,
    );
    expect(queryByRole('form')).toBeNull();
    expect(queryByRole('combobox', { name: 'Model' })).toBeNull();
  });

  test('builds the form once one provider has a key, though the others keep unavailable rows', async () => {
    bureau({
      catalog: catalogFixture({
        models: [...unkeyedModelFixtures(), { provider: 'anthropic', model: 'claude-opus-5' }],
      }),
    });
    const { findByRole } = mountEditor();

    expect(await findByRole('combobox', { name: 'Model' })).not.toBeNull();
  });

  test('leaves the no-provider state for the list with its Cancel', async () => {
    router.navigate('/agents/new', { replace: true });
    bureau({ catalog: catalogFixture({ models: unkeyedModelFixtures() }) });
    const { findByRole } = mountEditor();

    await findByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title });
    await fireEvent.click(await findByRole('button', { name: AGENT_EDITOR_COPY.cancelAction }));
    expect(router.pathname).toBe('/agents');
  });

  test('offers Connect a provider, which opens Settings › Models with a way back to this form', async () => {
    router.navigate('/agents/new', { replace: true });
    bureau({ catalog: catalogFixture({ models: unkeyedModelFixtures() }) });
    const { findByRole } = mountEditor();

    const connect = await findByRole('link', { name: AGENT_EDITOR_COPY.noProvider.connectAction });

    expect(connect.getAttribute('href')).toBe('/settings/models?return=%2Fagents%2Fnew');
    await fireEvent.click(connect);
    expect(router.pathname).toBe('/settings/models');
    expect(router.search.get('return')).toBe('/agents/new');
  });

  test('offers no Connect a provider where the host keeps its keys in its deployment, and leaves the steps', async () => {
    bureau({ catalog: catalogFixture({ models: unkeyedModelFixtures() }), hostMode: 'remote' });
    const { findByRole, queryByRole, container } = mountEditor();

    await findByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title });

    expect(queryByRole('link', { name: AGENT_EDITOR_COPY.noProvider.connectAction })).toBeNull();
    expect(container.textContent).toContain(AGENT_EDITOR_COPY.remote.noProvider.secretStep);
  });

  test('puts only the Connect button in the action, and the lines and the steps under it in reading order (COR-2415)', async () => {
    bureau({ catalog: catalogFixture({ models: unkeyedModelFixtures() }) });
    const { findByRole, getByTestId, container } = mountEditor();

    await findByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title });

    const action = container.querySelector('.cinder-empty-state-action');
    expect(action?.querySelector('[data-testid="agent-connect-provider"]')).not.toBeNull();
    // The action is a row of buttons: no list and no column wrapper inside it.
    expect(action?.querySelector('ol, ul, p, .weft-no-provider__connect')).toBeNull();
    expect(action?.children).toHaveLength(1);
    const details = container.querySelector('.cinder-empty-state-details');
    expect(details?.querySelector('ol.weft-no-provider__steps')).not.toBeNull();
    // Description, Connect a provider, the line under it, "Or set it up by hand:", then the steps.
    const description = container.querySelector('.cinder-empty-state-description')!;
    const connect = getByTestId('agent-connect-provider');
    const blocked = getByTestId('agent-no-provider-blocked');
    const byHand = [...container.querySelectorAll('p')].find(
      (line) => line.textContent?.trim() === AGENT_EDITOR_COPY.noProvider.byHand,
    )!;
    const steps = container.querySelector('ol.weft-no-provider__steps')!;
    const inOrder = [description, connect, blocked, byHand, steps];
    for (const [index, node] of inOrder.entries()) {
      const next = inOrder[index + 1];
      if (next === undefined) continue;
      expect(node.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  test('draws no action at all where the host keeps its keys in its deployment, and the steps still follow the description (COR-2415)', async () => {
    bureau({ catalog: catalogFixture({ models: unkeyedModelFixtures() }), hostMode: 'remote' });
    const { findByRole, container } = mountEditor();

    await findByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title });

    expect(container.querySelector('.cinder-empty-state-action')).toBeNull();
    expect(
      container.querySelector('.cinder-empty-state-details ol.weft-no-provider__steps'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-no-provider-blocked"]')).toBeNull();
  });

  test('builds the form when a provider has been added and the page is reloaded', async () => {
    let catalog = catalogFixture({ models: unkeyedModelFixtures() });
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
    let catalog = catalogFixture({ models: unkeyedModelFixtures() });
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
    bureau({ catalog: catalogFixture({ models: unkeyedModelFixtures() }), hostPaths: null });
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
            name: 'bureau:workflows-create',
            description: prompt,
            shortDescription: 'Create a workflow Bureau runs on a schedule or a signal.',
          },
          { name: 'draft-reply', description: `${prompt} ${prompt}`, shortDescription: null },
        ],
      }),
    });
    const view = mountEditor();
    const { findByRole, getAllByTestId, getByText, queryAllByTestId } = view;
    await findByRole('button', { name: AGENT_EDITOR_COPY.addToolsAction });
    await openPicker(view);
    await findByRole('checkbox', { name: /bureau:workflows-create/ });

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
    const view = mountEditor();
    const { findByRole, getByRole, getByTestId, queryByRole } = view;
    const name = await findByRole('textbox', { name: /^Name/ });

    // The identifier follows the name, shown once, with Change beside it (row 41e).
    await type(name, 'Research Assistant');
    expect(getByTestId('agent-identifier').textContent).toContain(
      `research-assistant${AGENT_EDITOR_COPY.newAgent.setFromName}`,
    );
    expect(queryByRole('textbox', { name: /^Identifier/ })).toBeNull();
    await fireEvent.click(
      getByRole('button', { name: AGENT_EDITOR_COPY.newAgent.changeIdentifierLabel }),
    );
    const identifier = getByRole('textbox', { name: /^Identifier/ }) as HTMLInputElement;
    expect(identifier.value).toBe('research-assistant');
    await type(identifier, 'helper');
    await type(name, 'Something Else');
    expect(identifier.value).toBe('helper');

    await type(getByRole('textbox', { name: /^Instructions/ }), 'Be careful.');
    await openPicker(view);
    await fireEvent.click(getByRole('checkbox', { name: /lookup-order/ }));
    await closePicker(view);
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
            card: [],
            a2a: false,
            guardrails: null,
            limits: { steps: null, cost: null, tools: null },
            instructions: 'Be careful.',
          },
        },
      },
    ]);
  });

  test('refuses a name that makes the identifier new, and says why at the name on submit', async () => {
    const calls = bureau();
    const { findByRole, getByRole, findByText, queryByText } = mountEditor();
    const name = await findByRole('textbox', { name: /^Name/ });
    await type(name, 'New');
    expect(queryByText(AGENT_EDITOR_COPY.identifierReserved)).toBeNull();

    const save = getByRole('button', { name: AGENT_EDITOR_COPY.createAction });
    expect(save).not.toBeDisabled();
    await fireEvent.click(save);
    expect(await findByText(AGENT_EDITOR_COPY.identifierReserved)).not.toBeNull();
    expect(name).toBeInvalid();
    await waitFor(() => expect(document.activeElement === name).toBe(true));
    expect(calls.callsTo('bureau.agents.definitions.create')).toEqual([]);
  });

  test('marks the name and the model after a submit with neither, and sends nothing (row 42m)', async () => {
    const calls = bureau({
      modelPolicy: { deployment: { deniedProviders: ['anthropic'] }, policyRevision: 1 },
    });
    const { findByRole, getByRole, findByText } = mountEditor();
    const name = await findByRole('textbox', { name: /^Name/ });
    const model = getByRole('combobox', { name: 'Model' });
    expect(name).toBeRequired();
    expect(model).toHaveValue('');

    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.createAction }));
    expect(await findByText(AGENT_EDITOR_COPY.newAgent.nameRequired)).not.toBeNull();
    expect(await findByText(AGENT_EDITOR_COPY.newAgent.modelRequired)).not.toBeNull();
    expect(name).toBeInvalid();
    expect(model).toBeInvalid();
    // The first problem in the form's order is the one that gets focus (row 14u).
    await waitFor(() => expect(document.activeElement === name).toBe(true));
    expect(calls.callsTo('bureau.agents.definitions.create')).toEqual([]);
  });

  test('changes the identifier only after Change, says what a bad one needs on submit, and resets to the name’s (rows 42x, 42y)', async () => {
    const calls = bureau();
    const { findByRole, getByRole, findByText, getByTestId, queryByRole } = mountEditor();
    await type(await findByRole('textbox', { name: /^Name/ }), 'Order Helper');
    expect(getByTestId('agent-identifier').textContent).toContain('order-helper');

    await fireEvent.click(
      getByRole('button', { name: AGENT_EDITOR_COPY.newAgent.changeIdentifierLabel }),
    );
    const identifier = getByRole('textbox', { name: /^Identifier/ });
    expect(identifier).toHaveAccessibleDescription(
      expect.stringContaining(AGENT_EDITOR_COPY.newAgent.identifierHint),
    );
    await type(identifier, 'Order Helper!');
    // Nothing is said until a submit.
    expect(identifier).not.toBeInvalid();

    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.createAction }));
    expect(await findByText(AGENT_EDITOR_COPY.identifierInvalid)).not.toBeNull();
    expect(identifier).toBeInvalid();
    await waitFor(() => expect(document.activeElement === identifier).toBe(true));
    expect(calls.callsTo('bureau.agents.definitions.create')).toEqual([]);

    await fireEvent.click(
      getByRole('button', { name: AGENT_EDITOR_COPY.newAgent.resetIdentifier('order-helper') }),
    );
    expect(queryByRole('textbox', { name: /^Identifier/ })).toBeNull();
    expect(getByTestId('agent-identifier').textContent).toContain('order-helper');
  });

  test('shows the file an identifier makes, and has no delete or history', async () => {
    bureau();
    const { findByRole, getByTestId, queryByRole, queryByText } = mountEditor();
    await type(await findByRole('textbox', { name: /^Name/ }), 'Research Assistant');

    expect(getByTestId('agent-file-path').textContent).toBe('agents/research-assistant.md');
    expect(queryByText(AGENT_EDITOR_COPY.revisions.heading)).toBeNull();
    expect(queryByRole('button', { name: AGENT_EDITOR_COPY.deleteAction })).toBeNull();
  });

  for (const reason of ['agent-file-exists', 'shadows-code-agent'] as const) {
    test(`reports a taken identifier (${reason}) at the name that set it, and writes nothing else`, async () => {
      const calls = bureau();
      calls.on('bureau.agents.definitions.create', () => {
        throw faults.taken(reason);
      });
      const { findByRole, findByText, getByRole } = mountEditor();
      const name = await findByRole('textbox', { name: /^Name/ });
      await type(name, 'Tool runner');
      const save = getByRole('button', { name: AGENT_EDITOR_COPY.createAction });
      await fireEvent.click(save);

      // The failed save shows at the field, and Save stays enabled beside Cancel (rows 42n, 14u).
      const message = AGENT_EDITOR_COPY.newAgent.nameTaken('Tool runner');
      await findByText(message);
      expect(name).toBeInvalid();
      expect(name).toHaveAccessibleDescription(expect.stringContaining(message));
      expect(save).not.toBeDisabled();
      expect(calls.callsTo('bureau.agents.definitions.create')).toHaveLength(1);
      expect(calls.calls.filter((call) => call.method.includes('update'))).toEqual([]);
      expect(router.pathname).toBe('/');

      // Another name sets another identifier, and the answer goes.
      await type(name, 'Tool runner 2');
      expect(name).not.toBeInvalid();
    });

    test(`reports a taken identifier (${reason}) that was typed at the identifier field`, async () => {
      const calls = bureau();
      calls.on('bureau.agents.definitions.create', () => {
        throw faults.taken(reason);
      });
      const { findByRole, findByText, getByRole } = mountEditor();
      await type(await findByRole('textbox', { name: /^Name/ }), 'Runner');
      await fireEvent.click(
        getByRole('button', { name: AGENT_EDITOR_COPY.newAgent.changeIdentifierLabel }),
      );
      const identifier = getByRole('textbox', { name: /^Identifier/ });
      await type(identifier, 'tool-runner');
      await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.createAction }));

      const message = AGENT_EDITOR_COPY.identifierTaken('tool-runner');
      await findByText(message);
      expect(identifier).toBeInvalid();
      expect(getByRole('textbox', { name: /^Name/ })).not.toBeInvalid();

      // Changing the identifier clears the answer.
      await type(identifier, 'tool-runner-2');
      expect(identifier).not.toBeInvalid();
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
  test('fills the form from its file, shows where the file is, and shows the identifier as a line', async () => {
    bureau();
    const { findByRole, getByRole, getByTestId, queryByRole } = mountEditor('researcher');

    expect(await findByRole('heading', { level: 1, name: 'Edit Researcher' })).not.toBeNull();
    expect(getByTestId('agent-tools-summary').textContent).toContain(
      AGENT_EDITOR_COPY.edit.tools.count(1),
    );
    expect(getByRole('textbox', { name: /^Name/ })).toHaveValue('Researcher');
    expect(getByRole('textbox', { name: /^Description/ })).toHaveValue('Finds and cites sources');
    expect(getByRole('textbox', { name: /^Instructions/ })).toHaveValue(
      'You are a careful researcher.',
    );
    // The model is read-only text on a saved agent, and the identifier is a line, not a field.
    expect(queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(getByTestId('agent-saved-model-value').textContent).toContain('Claude Sonnet 5');
    expect(queryByRole('textbox', { name: /^Identifier/ })).toBeNull();
    expect(getByTestId('agent-identifier').textContent).toContain('researcher');
    expect(getByTestId('agent-file-path').textContent).toBe('agents/researcher.md');
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
        card: [
          {
            id: 'cite',
            name: 'Cite',
            description: 'Cites the sources it used',
            tags: ['research'],
          },
        ],
        a2a: true,
        guardrails: null,
        limits: { steps: null, cost: null, tools: null },
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
        definition: detail.definition && { ...detail.definition, card: [skill] },
      },
    });
    const { findByRole, getByRole } = mountEditor('researcher');
    await findByRole('textbox', { name: /^Instructions/ });
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params['definition']).toMatchObject({ card: [skill] });
  });

  test('writes the model back as the file wrote it, since the form shows no control to change it', async () => {
    const calls = bureau();
    const { findByRole, getByRole, queryByRole } = mountEditor('researcher');
    await type(await findByRole('textbox', { name: /^Instructions/ }), 'Changed.');
    expect(queryByRole('combobox', { name: 'Model' })).toBeNull();
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params['definition']).toMatchObject({ model: 'anthropic/sonnet' });
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

describe('the default effort', () => {
  const catalog = () =>
    catalogFixture({
      models: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          aliases: [{ alias: 'sonnet', resolvesTo: 'claude-sonnet-5' }],
          effort: { portable: ['low', 'medium', 'high'] },
        },
        { provider: 'anthropic', model: 'claude-haiku-5', effort: { portable: ['low'] } },
        { provider: 'openai', model: 'gpt-4.1', effort: { portable: [] } },
      ],
    });
  const agentWith = (effort: 'low' | 'high' | null): AgentDetail => {
    const detail = readyAgent();
    return { ...detail, definition: { ...detail.definition!, effort } };
  };
  const optionsOf = (select: HTMLElement) =>
    [...select.querySelectorAll('option')].map((option) => option.textContent);

  // The field is on a new agent's form. A saved agent's form shows no control for it: the Settings
  // tab owns the model and what goes with it, and a save writes the file's effort back.
  test('offers None and the tiers the model supports on a new agent, and sends the one chosen with the save', async () => {
    const calls = bureau({ catalog: catalog() });
    const { findByLabelText, findByRole, getByRole } = mountEditor();
    await type(await findByRole('textbox', { name: /^Name/ }), 'Researcher');
    const select = await findByLabelText(AGENT_EDITOR_COPY.effort.label);
    expect(optionsOf(select)).toEqual(['None', 'Low', 'Medium', 'High']);
    expect((select as HTMLSelectElement).value).toBe('');

    await fireEvent.change(select, { target: { value: 'medium' } });
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.createAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    const [create] = calls.callsTo('bureau.agents.definitions.create');
    expect(create?.params['definition']).toMatchObject({ effort: 'medium' });
  });

  test('is not on a saved agent’s form, and its effort is written back unchanged', async () => {
    const calls = bureau({ catalog: catalog(), agent: agentWith('high') });
    const { findByRole, getByRole, queryByLabelText } = mountEditor('researcher');
    await type(await findByRole('textbox', { name: /^Instructions/ }), 'Changed.');
    expect(queryByLabelText(AGENT_EDITOR_COPY.effort.label)).toBeNull();
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params['definition']).toMatchObject({ effort: 'high' });
  });

  test('is disabled, and says why, for a new agent’s model with no effort control', async () => {
    bureau({ catalog: catalog() });
    const { findByRole, findByLabelText, getByText } = mountEditor();
    const select = (await findByLabelText(AGENT_EDITOR_COPY.effort.label)) as HTMLSelectElement;
    await chooseModel(await findByRole('combobox', { name: 'Model' }), 'openai/gpt-4.1');
    expect(optionsOf(select)).toEqual(['None']);
    expect(select.disabled).toBe(true);
    expect(getByText(AGENT_EDITOR_COPY.effort.notSupportedByModel)).not.toBeNull();
  });

  test('is sent as the file holds it, even one its model does not list, and the Bureau’s reason shows', async () => {
    const calls = bureau({
      catalog: catalog(),
      agent: {
        ...agentWith(null),
        definition: {
          ...agentWith(null).definition!,
          model: 'anthropic/claude-haiku-5',
          effort: 'high',
        },
      },
    });
    calls.on('bureau.agents.definitions.update', () => {
      throw faults.unprocessable('claude-haiku-5 does not support high effort.');
    });
    const { findByRole, findByText, getByRole } = mountEditor('researcher');
    await findByRole('textbox', { name: /^Instructions/ });
    // Save stays enabled (W35). The form cannot change the effort, so the save goes to the Bureau.
    const save = getByRole('button', { name: AGENT_EDITOR_COPY.saveAction });
    expect(save).not.toBeDisabled();
    await fireEvent.click(save);
    expect(await findByText('claude-haiku-5 does not support high effort.')).not.toBeNull();
    expect(calls.callsTo('bureau.agents.definitions.update')).toHaveLength(1);
    expect(router.pathname).toBe('/');
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

  test('is not shown while the catalog is still being read, and the delete block holds it once the form is built', async () => {
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
    // One delete, in the form's delete block (row 41x), not a second one in the header and not in
    // the sticky bar.
    expect(queryAllByRole('button', deleteButton).length).toBe(1);
    expect(container.querySelector('.weft-agent-form__danger')?.textContent).toContain(
      AGENT_EDITOR_COPY.deleteAction,
    );
    expect(container.querySelector('.weft-agent-form__footer')?.textContent).not.toContain(
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
    bureau({ catalog: catalogFixture({ models: unkeyedModelFixtures() }) });
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
    expect(getByTestId('agent-file-path').textContent).toBe('agents/researcher.md');
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

  test('labels an agent’s location with the words of its mode, and shows the host’s location verbatim on hover', async () => {
    bureau({ hostMode: mode });
    const { findByTestId, findByRole, container } = mountEditor('researcher');
    const path = await findByTestId('agent-file-path');

    const label = container.querySelector('.weft-agent-editor__path span')?.textContent;
    expect(label).toBe(words[mode].label);
    expect(label).not.toBe(words[other].label);
    // The line reads the same on every host; the host's own location is what the tooltip says.
    expect(path.textContent).toBe('agents/researcher.md');
    await fireEvent.focusIn(path);
    const tooltip = await findByRole('tooltip');
    expect(tooltip.textContent).toContain(
      mode === 'remote'
        ? `${STUB_REMOTE_AGENT_DIRECTORY}researcher.md`
        : `${STUB_AGENT_DIRECTORY}/researcher.md`,
    );
  });

  test('says where to configure a provider, and where its key goes, in the words of its mode', async () => {
    bureau({ catalog: catalogFixture({ models: unkeyedModelFixtures() }), hostMode: mode });
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

describe('the Save in the sticky bar', () => {
  /** Reads ⌘Enter against the shortcut registry as the shell does (`shell.svelte`). */
  function pressCommandEnter(routePattern: string): boolean {
    return shortcuts.handleKey(
      { key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, editable: true },
      { routePattern, regions: [] },
      Date.now(),
    );
  }

  test('is the only Save, sits in the form’s sticky bar after Cancel, and submits the form', async () => {
    const calls = bureau();
    const { findByRole, getByRole, getAllByRole } = mountEditor('researcher');
    await type(await findByRole('textbox', { name: /^Instructions/ }), 'Changed.');
    const save = getByRole('button', { name: AGENT_EDITOR_COPY.saveAction });
    const form = getByRole('form', { name: AGENT_EDITOR_COPY.formLabel });

    expect(getAllByRole('button', { name: AGENT_EDITOR_COPY.saveAction })).toHaveLength(1);
    expect(form.contains(save)).toBe(true);
    expect(save.getAttribute('type')).toBe('submit');
    // Cancel, then Save, at the end of the bar (row 42n).
    const labels = within(form)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim());
    expect(labels.slice(-2)).toEqual([
      AGENT_EDITOR_COPY.cancelAction,
      AGENT_EDITOR_COPY.saveAction,
    ]);
    expect(save.hasAttribute('data-changes')).toBe(true);
    await fireEvent.click(save);
    await waitFor(() => expect(calls.callsTo('bureau.agents.definitions.update')).toHaveLength(1));
  });

  test('says which version the agent is at, in the sticky bar', async () => {
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
    const { getByTestId } = mountEditor('researcher');
    // The loading bar has its own status line, which the form's replaces, so read it each time.
    await waitFor(() =>
      expect(getByTestId('agent-save-status').textContent?.trim()).toBe(
        AGENT_EDITOR_COPY.edit.saved(4),
      ),
    );
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

  test('does not save with ⌘Enter while the name is emptied', async () => {
    const calls = bureau();
    const { findByRole, getByRole, findByText } = mountEditor('researcher');
    const name = await findByRole('textbox', { name: /^Name/ });
    await type(name, '');

    expect(pressCommandEnter('/agents/:agent/edit')).toBe(true);
    // Save stays enabled (W35), and the submit says what stops it at the field and focuses it.
    expect(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction })).not.toBeDisabled();
    expect(await findByText(AGENT_EDITOR_COPY.edit.nameRequired)).not.toBeNull();
    await waitFor(() => expect(document.activeElement === name).toBe(true));
    expect(calls.callsTo('bureau.agents.definitions.update')).toEqual([]);
  });

  test('sends the guardrails and limits the file holds, since the form shows no field for them', async () => {
    const detail = readyAgent();
    const calls = bureau({
      agent: {
        ...detail,
        definition: {
          ...detail.definition!,
          guardrails: ['acme:tripwire'],
          limits: { steps: 12, cost: { run: 1.5 }, tools: { calls: 30 } },
        },
      },
    });
    const { findByRole, getByRole, queryByRole } = mountEditor('researcher');
    await type(await findByRole('textbox', { name: /^Instructions/ }), 'Changed.');
    expect(queryByRole('textbox', { name: /^Steps per run/ })).toBeNull();
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));

    await waitFor(() => expect(calls.callsTo('bureau.agents.definitions.update')).toHaveLength(1));
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params).toMatchObject({
      definition: {
        guardrails: ['acme:tripwire'],
        limits: { steps: 12, cost: { run: 1.5 }, tools: { calls: 30 } },
      },
    });
  });
});
