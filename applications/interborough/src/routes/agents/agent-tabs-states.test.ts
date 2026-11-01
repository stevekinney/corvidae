import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { faults, readyAgent, StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, CONTEXT, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentDetail from './agent-detail.svelte';
import { settingsOf } from './agent-settings.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: AgentDetail } } as never);

const FILE_AGENT = { ...AGENT, name: 'researcher', displayName: 'Researcher', kind: 'file' };

type Answers = Parameters<typeof bureau>[0];
type Detail = ReturnType<typeof readyAgent>;

function serve(
  extra: Answers = {},
  definition: () => Detail = () => readyAgent({ id: 'researcher' }),
) {
  const served = bureau({
    'bureau.agents.list': () => ({ agents: [FILE_AGENT] }),
    'bureau.agents.definitions.get': definition,
    'bureau.contexts.list': () => ({
      contexts: [{ ...CONTEXT, agentName: 'researcher' }],
      nextOffset: null,
    }),
    'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
    'bureau.agents.versions.list': () => ({ versions: [] }),
    ...extra,
  });
  restore = served.restore;
  return served;
}

/** Picks an option the way a person does: selects it, then the browser fires `change`. */
async function pick(select: HTMLElement, value: string): Promise<void> {
  const option = [...select.querySelectorAll('option')].find((entry) => entry.value === value);
  if (option === undefined) throw new Error(`expected an option ${value}`);
  option.selected = true;
  await fireEvent.change(select);
}

const lastListed = (served: ReturnType<typeof serve>) =>
  served.calls.filter((call) => call.method === 'bureau.contexts.list').at(-1)?.params;

describe('the controls over an agent’s chats', () => {
  test('asks for who started them and for the order, and clears a search', async () => {
    landAt('/agents/researcher');
    const served = serve();
    const { container, findByLabelText, findByRole } = mount();

    const startedBy = await findByLabelText('Started by');
    await pick(startedBy, 'goal');
    await waitFor(() => expect(lastListed(served)).toMatchObject({ origin: 'goal' }));
    const sort = await findByLabelText('Sort by');
    await pick(sort, 'oldest');
    await waitFor(() =>
      expect(lastListed(served)).toMatchObject({ sortBy: 'createdAt', sortOrder: 'asc' }),
    );

    const search = await findByRole('searchbox', { name: 'Search chats by title' });
    await fireEvent.input(search, { target: { value: 'refund' } });
    const form = container.querySelector('form[role="search"]');
    if (form === null) throw new Error('expected the search form');
    await fireEvent.submit(form);
    await waitFor(() => expect(lastListed(served)).toMatchObject({ titleContains: 'refund' }));
    await fireEvent.click(await findByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(lastListed(served)?.['titleContains']).toBeUndefined());
  });

  test('says the chats could not be loaded and tries again', async () => {
    landAt('/agents/researcher');
    let fail = true;
    serve({
      'bureau.contexts.list': () => {
        if (fail) throw faults.notFound('chats');
        return { contexts: [{ ...CONTEXT, title: 'Back again' }], nextOffset: null };
      },
    });
    const { findByRole, findByText } = mount();

    await findByText('These chats could not be loaded.');
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));

    await findByText('Back again');
  });

  test('opens a chat from its row', async () => {
    landAt('/agents/researcher');
    serve();
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('button', { name: /Plan the week/ }));

    expect(router.pathname).toBe(`/chats/${CONTEXT.id}`);
  });
});

describe('the empty Chats tab', () => {
  test('opens a new chat with the agent from its action', async () => {
    landAt('/agents/researcher');
    serve({ 'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }) });
    const { findAllByRole } = mount();

    // The header holds one New chat, and the empty state another.
    await waitFor(async () =>
      expect(await findAllByRole('link', { name: 'New chat' })).toHaveLength(2),
    );
    const links = await findAllByRole('link', { name: 'New chat' });
    await fireEvent.click(links[1] as HTMLElement);

    expect(router.pathname).toBe('/chats/new');
    expect(router.search.get('agent')).toBe('researcher');
  });
});

describe('the tabs of an agent’s page', () => {
  test('write the address when a tab is picked, and an unknown tab is Chats', async () => {
    landAt('/agents/researcher');
    serve();
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('tab', { name: 'Instructions' }));
    await waitFor(() => expect(router.search.get('tab')).toBe('instructions'));
    await fireEvent.click(await findByRole('tab', { name: 'Chats' }));
    await waitFor(() => expect(router.search.get('tab')).toBeNull());

    router.navigate('/agents/researcher?tab=nonsense');
    await waitFor(() => expect(router.search.get('tab')).toBeNull());
  });

  test('send Edit in the Instructions tab to the editor in the app', async () => {
    landAt('/agents/researcher?tab=instructions');
    serve();
    const { findAllByRole } = mount();

    // The header holds one Edit, and the tab another.
    await waitFor(async () =>
      expect(await findAllByRole('link', { name: 'Edit' })).toHaveLength(2),
    );
    const edits = await findAllByRole('link', { name: 'Edit' });
    await fireEvent.click(edits[1] as HTMLElement);

    expect(router.pathname).toBe('/agents/researcher/edit');
  });
});

describe('Edit in the Instructions tab', () => {
  test('is left to the browser when a modifier key is held', async () => {
    landAt('/agents/researcher?tab=instructions');
    serve();
    const { findAllByRole } = mount();

    await waitFor(async () =>
      expect(await findAllByRole('link', { name: 'Edit' })).toHaveLength(2),
    );
    const edits = await findAllByRole('link', { name: 'Edit' });
    await fireEvent.click(edits[1] as HTMLElement, { ctrlKey: true });

    expect(router.pathname).toBe('/agents/researcher');
  });
});

describe('the Instructions tab, when there is nothing to show', () => {
  test('offers to add instructions to a file that has none', async () => {
    landAt('/agents/researcher?tab=instructions');
    serve({}, () => {
      const detail = readyAgent({ id: 'researcher' });
      return detail.definition === null
        ? detail
        : { ...detail, definition: { ...detail.definition, instructions: '  ' } };
    });
    const { container, findByRole } = mount();

    const add = await findByRole('link', { name: 'Add instructions' });
    expect(add.closest('[data-cinder-kind="first-use"]')).not.toBeNull();
    await fireEvent.click(add);
    expect(router.pathname).toBe('/agents/researcher/edit');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('offers nothing to an agent in code that states no instructions', async () => {
    landAt('/agents/assistant?tab=instructions');
    const served = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.definitions.get': () => ({
        ...readyAgent({ id: 'assistant' }),
        source: 'code',
        hash: null,
        definition: null,
        codeDefinition: null,
      }),
      'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
    });
    restore = served.restore;
    const { findByText, queryByRole } = mount();

    await findByText('No instructions');

    expect(queryByRole('link', { name: 'Add instructions' })).toBeNull();
  });

  test('says the agent could not be loaded and tries again', async () => {
    landAt('/agents/researcher?tab=instructions');
    let fail = true;
    serve({
      'bureau.agents.definitions.get': () => {
        if (fail) throw faults.notFound('researcher');
        return readyAgent({ id: 'researcher' });
      },
    });
    const { findByRole, findByText } = mount();

    await findByText('The instructions could not be loaded.');
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));

    await findByText('You are a careful researcher.');
  });
});

describe('the Settings tab, when something goes wrong', () => {
  test('says the settings could not be loaded and tries again', async () => {
    landAt('/agents/researcher?tab=settings');
    let fail = true;
    serve({
      'bureau.agents.definitions.get': () => {
        if (fail) throw faults.notFound('researcher');
        return readyAgent({ id: 'researcher' });
      },
    });
    const { findByRole, findByText, findAllByText } = mount();

    await findByText('The settings could not be loaded.');
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));

    const models = await findAllByText('anthropic/sonnet');
    expect(models.length).toBeGreaterThan(0);
  });

  test('shows a file with no step limit as running the default of 25 steps', async () => {
    landAt('/agents/researcher?tab=settings');
    serve();
    const { findByTestId } = mount();

    const settings = await findByTestId('agent-settings');

    await waitFor(() => expect(settings.textContent).toContain('anthropic/sonnet'));
    expect(settings.textContent).toContain('Default (25 steps)');
    // Guardrails and the spend and tool limits are on the Access tab.
    expect(settings.textContent).not.toContain('Spend limit');
  });

  test('shows an agent in code without limits, Delete or versions', async () => {
    landAt('/agents/assistant?tab=settings');
    const served = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.definitions.get': () => ({
        ...readyAgent({ id: 'assistant' }),
        source: 'code',
        hash: null,
        definition: null,
        codeDefinition: {
          name: 'assistant',
          description: null,
          model: 'anthropic/sonnet',
          models: ['anthropic/haiku'],
          tools: [],
          skills: [],
          skillDescriptors: [],
          instructions: null,
        },
      }),
      'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
    });
    restore = served.restore;
    const { findByTestId, queryByRole } = mount();

    const settings = await findByTestId('agent-settings');

    await waitFor(() => expect(settings.textContent).toContain('anthropic/haiku'));
    expect(queryByRole('button', { name: 'Delete agent' })).toBeNull();
    expect(settings.querySelector('[data-testid="agent-versions"]')).toBeNull();
    expect(served.calls.some((call) => call.method === 'bureau.agents.versions.list')).toBe(false);
  });

  for (const [name, fault, message] of [
    ['a file that changed', faults.stale('hash-2'), 'This agent changed after the page loaded'],
    [
      'a refused delete',
      faults.unprocessable('Nothing may delete this.'),
      'Nothing may delete this.',
    ],
    ['an agent that is gone', faults.notFound('researcher'), 'The agent could not be deleted.'],
  ] as const) {
    test(`says why a delete failed: ${name}`, async () => {
      landAt('/agents/researcher?tab=settings');
      serve({
        'bureau.agents.definitions.delete': () => {
          throw fault;
        },
      });
      const { findByRole, findByText } = mount();

      await fireEvent.click(await findByRole('button', { name: 'Delete agent' }));
      await fireEvent.click(await findByRole('button', { name: 'Delete' }));

      await findByText(new RegExp(message));
      expect(router.pathname).toBe('/agents/researcher');
    });
  }

  test('says a caller who may not delete may not', async () => {
    landAt('/agents/researcher?tab=settings');
    serve({
      'bureau.agents.definitions.delete': () => {
        throw new StubFault('Forbidden', 403, 'No.');
      },
    });
    const { findByRole, findByText } = mount();

    await fireEvent.click(await findByRole('button', { name: 'Delete agent' }));
    await fireEvent.click(await findByRole('button', { name: 'Delete' }));

    await findByText('You may not change this agent.');
    await fireEvent.click(await findByRole('button', { name: /dismiss/i }));
  });
});

describe('the Settings tab of an agent in code that names no model', () => {
  test('says the model is not set', async () => {
    landAt('/agents/assistant?tab=settings');
    const served = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.definitions.get': () => ({
        ...readyAgent({ id: 'assistant' }),
        source: 'code',
        hash: null,
        definition: null,
        codeDefinition: null,
      }),
      'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
    });
    restore = served.restore;
    const { findByTestId } = mount();

    const settings = await findByTestId('agent-settings');

    await waitFor(() => expect(settings.textContent).toContain('Not set'));
  });
});

describe('the versions of an agent', () => {
  test('says there are none, and that they could not be loaded, with a retry', async () => {
    landAt('/agents/researcher?tab=settings');
    let fail = true;
    serve({
      'bureau.agents.versions.list': () => {
        if (fail) throw faults.notFound('researcher');
        return { versions: [] };
      },
    });
    const { container, findByRole, findByText } = mount();

    await findByText('The versions could not be loaded.');
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));

    await findByText('No saved versions');
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
  });

  for (const [name, fault] of [
    ['a file that changed', faults.stale('hash-2')],
    ['a definition that no longer loads', faults.unprocessable('The model is gone.')],
  ] as const) {
    test(`says why a restore failed: ${name}`, async () => {
      landAt('/agents/researcher?tab=settings');
      const version = (revision: number) => ({
        revision,
        hash: `identity-${String(revision)}`,
        savedAt: '2026-10-19T09:00:00.000Z',
        savedBy: 'anonymous:local',
        owner: 'anonymous:local',
        definition: readyAgent({ id: 'researcher' }).definition,
        referenceDigests: null,
        changedKeys: ['model'],
      });
      serve({
        'bureau.agents.versions.list': () => ({ versions: [version(2), version(1)] }),
        'bureau.agents.versions.restore': () => {
          throw fault;
        },
      });
      const { findByRole, container } = mount();

      await fireEvent.click(await findByRole('button', { name: 'Restore version 1' }));

      await waitFor(() => expect(container.querySelector('[role="alert"]') !== null).toBe(true));
      await fireEvent.click(await findByRole('button', { name: /dismiss/i }));
      await waitFor(() =>
        expect(container.querySelector('[role="alert"]')?.outerHTML ?? null).toBeNull(),
      );
    });
  }
});

describe('what the Settings tab shows of a definition', () => {
  test('words the step limit when it is set and leaves it when it is not', () => {
    const detail = readyAgent({ id: 'researcher' });
    if (detail.definition === null) throw new Error('expected a definition');
    expect(settingsOf({ ...detail, definition: { ...detail.definition, stepLimit: 12 } })).toEqual({
      model: 'anthropic/sonnet',
      models: [],
      stepLimit: '12',
    });
    expect(settingsOf(detail).stepLimit).toBeNull();
    expect(settingsOf({ ...detail, source: 'code', definition: null })).toMatchObject({
      model: null,
      models: [],
    });
  });
});
