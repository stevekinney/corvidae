/**
 * The agent editor page against a stand-in for the Bureau's management plane: what the form offers
 * from the catalog, what a save sends, what publishing and deleting name, and the states a write
 * can end in. Every write names the `hash` the form was filled from, `published` never rides a
 * save, and `skills` comes back as it was read.
 */
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
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
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
    readonly catalog?: AgentCatalog;
    readonly hostPaths?: string | null;
  } = {},
): BureauStub {
  const agent = options.agent ?? readyAgent();
  stub = installBureauStub(
    {
      'bureau.agents.catalog': () => options.catalog ?? catalogFixture(),
      'bureau.agents.definitions.get': () => agent,
      'bureau.agents.definitions.revisions': () => ({ revisions: [] }),
      'bureau.agents.definitions.create': (params) => ({
        id: String(params['id']),
        hash: 'created',
      }),
      'bureau.agents.definitions.update': () => ({ id: agent.id, hash: 'hash-2' }),
      'bureau.agents.definitions.publish': () => ({ id: agent.id, hash: 'hash-published' }),
      'bureau.agents.definitions.withdraw': () => ({ id: agent.id, hash: 'hash-withdrawn' }),
      'bureau.agents.definitions.delete': () => ({ id: agent.id, hash: 'deleted' }),
    },
    options.hostPaths === undefined ? {} : { hostPaths: options.hostPaths },
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
  test('offers exactly the models and tools the catalog lists', async () => {
    bureau({
      catalog: catalogFixture({
        models: [
          { provider: 'openai', model: 'gpt-4.1', aliases: [] },
          { provider: 'anthropic', model: 'claude-haiku-5', aliases: [] },
        ],
        tools: [
          { name: 'lookup-order', description: 'Look an order up.' },
          { name: 'issue-refund', description: 'Refund an order.' },
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

  test('is not saveable, and says why, when the catalog holds no model', async () => {
    bureau({ catalog: catalogFixture({ models: [] }) });
    const { findByText, getByRole, container } = mountEditor();

    expect(await findByText(AGENT_EDITOR_COPY.noModels.title)).not.toBeNull();
    expect(container.textContent).toContain(AGENT_EDITOR_COPY.noModels.description);
    await type(getByRole('textbox', { name: /^Name/ }), 'Researcher');
    expect(getByRole('button', { name: AGENT_EDITOR_COPY.createAction })).toBeDisabled();
    expect(getByRole('combobox', { name: 'Model' })).toBeDisabled();
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
            skills: [],
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

  test('shows the file an identifier makes, and has no publish control, delete, or history', async () => {
    bureau();
    const { findByRole, getByTestId, queryByRole, queryByText } = mountEditor();
    await type(await findByRole('textbox', { name: /^Name/ }), 'Research Assistant');

    expect(getByTestId('agent-file-path').textContent).toBe(
      `${STUB_AGENT_DIRECTORY}/research-assistant.md`,
    );
    expect(queryByRole('switch')).toBeNull();
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

  test('saves with the hash it read, keeps the skills, and never sends published', async () => {
    const calls = bureau({ agent: readyAgent({ published: true }) });
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
        skills: [
          {
            id: 'cite',
            name: 'Cite',
            description: 'Cites the sources it used',
            tags: ['research'],
          },
        ],
        instructions: 'Changed.',
      },
    });
    const definition = (update?.params['definition'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(definition)).not.toContain('published');
  });

  test('keeps an unknown key of a skill when the agent is saved', async () => {
    const detail = readyAgent();
    const skill = { id: 'cite', name: 'Cite', description: 'Cites', tags: ['x'], futureKey: 7 };
    const calls = bureau({
      agent: {
        ...detail,
        definition: detail.definition && { ...detail.definition, skills: [skill] },
      },
    });
    const { findByRole, getByRole } = mountEditor('researcher');
    await findByRole('textbox', { name: /^Instructions/ });
    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    const [update] = calls.callsTo('bureau.agents.definitions.update');
    expect(update?.params['definition']).toMatchObject({ skills: [skill] });
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

  test('publishes and withdraws with the current hash, and a save after that names the new one', async () => {
    const calls = bureau();
    const { findByRole, getByRole } = mountEditor('researcher');
    const published = await findByRole('switch', { name: AGENT_EDITOR_COPY.publishedLabel });
    expect(published).toHaveAttribute('aria-checked', 'false');

    await fireEvent.click(published);
    await waitFor(() => expect(published).toHaveAttribute('aria-checked', 'true'));
    await fireEvent.click(published);
    await waitFor(() => expect(published).toHaveAttribute('aria-checked', 'false'));

    expect(calls.callsTo('bureau.agents.definitions.publish')[0]?.params).toEqual({
      id: 'researcher',
      expectedHash: 'hash-1',
    });
    expect(calls.callsTo('bureau.agents.definitions.withdraw')[0]?.params).toEqual({
      id: 'researcher',
      expectedHash: 'hash-published',
    });

    await fireEvent.click(getByRole('button', { name: AGENT_EDITOR_COPY.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    expect(calls.callsTo('bureau.agents.definitions.update')[0]?.params['expectedHash']).toBe(
      'hash-withdrawn',
    );
    // Publication moved through publish and withdraw only.
    for (const call of calls.callsTo('bureau.agents.definitions.update')) {
      expect(Object.keys(call.params['definition'] as object)).not.toContain('published');
    }
  });

  test('keeps unsaved edits when publication changes, and does not save them', async () => {
    const calls = bureau();
    const { findByRole, getByRole } = mountEditor('researcher');
    await type(await findByRole('textbox', { name: /^Instructions/ }), 'Unsaved.');
    const published = getByRole('switch', { name: AGENT_EDITOR_COPY.publishedLabel });
    await fireEvent.click(published);
    await waitFor(() => expect(published).toHaveAttribute('aria-checked', 'true'));

    expect(getByRole('textbox', { name: /^Instructions/ })).toHaveValue('Unsaved.');
    expect(calls.callsTo('bureau.agents.definitions.update')).toEqual([]);
  });

  test('leaves the switch where it was, and says why, when publishing is refused', async () => {
    const calls = bureau();
    calls.on('bureau.agents.definitions.publish', () => {
      throw faults.unprocessable('The model is not offered.');
    });
    const { findByRole, findByText } = mountEditor('researcher');
    const published = await findByRole('switch', { name: AGENT_EDITOR_COPY.publishedLabel });
    await fireEvent.click(published);

    expect(await findByText('The model is not offered.')).not.toBeNull();
    expect(published).toHaveAttribute('aria-checked', 'false');
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

  test('is the same state when a publication change meets it', async () => {
    const calls = bureau();
    calls.on('bureau.agents.definitions.publish', () => {
      throw faults.stale('hash-on-disk');
    });
    const { findByRole, findByText } = mountEditor('researcher');
    await fireEvent.click(await findByRole('switch', { name: AGENT_EDITOR_COPY.publishedLabel }));
    expect(await findByText(AGENT_EDITOR_COPY.stale.title)).not.toBeNull();
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
