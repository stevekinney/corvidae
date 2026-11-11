import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { flushSync } from 'svelte';

import { AGENT_PAGE_COPY } from '../../app/copy.ts';
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

/** Opens the select with this label's place in the filter row and chooses the option that reads `option`. */
async function choose(container: HTMLElement, place: number, option: string): Promise<void> {
  const trigger = container.querySelectorAll('.cinder-select[role="combobox"]')[place];
  if (trigger === undefined) throw new Error(`expected a select at ${String(place)}`);
  await fireEvent.click(trigger);
  flushSync();
  const found = [...document.querySelectorAll('[role="option"]')].find(
    (entry) => entry.textContent?.trim() === option,
  );
  if (found === undefined) throw new Error(`expected an option ${option}`);
  await fireEvent.click(found);
  flushSync();
}

const lastListed = (served: ReturnType<typeof serve>) =>
  served.calls
    .filter((call) => call.method === 'bureau.contexts.list' && 'agentName' in call.params)
    .at(-1)?.params;

describe('the controls over an agent’s chats', () => {
  test('asks for who started them and for the order, and clears a search', async () => {
    landAt('/agents/researcher');
    const served = serve();
    const { container, findByRole } = mount();

    await findByRole('searchbox', { name: 'Search chats by title' });
    // Started by is the first select of the filter row and Sort by the second.
    await choose(container, 0, 'A goal');
    await waitFor(() => expect(lastListed(served)).toMatchObject({ origin: 'goal' }));
    await choose(container, 1, 'Oldest first');
    await waitFor(() =>
      expect(lastListed(served)).toMatchObject({ sortBy: 'createdAt', sortOrder: 'asc' }),
    );
    // Choosing the clearing row asks for anyone again.
    await choose(container, 0, 'Anyone');
    await waitFor(() => expect(lastListed(served)?.['origin']).toBeUndefined());

    const search = await findByRole('searchbox', { name: 'Search chats by title' });
    await fireEvent.input(search, { target: { value: 'refund' } });
    await waitFor(() => expect(lastListed(served)).toMatchObject({ titleContains: 'refund' }));
    await fireEvent.input(search, { target: { value: '' } });
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

    // Nothing was read, so the list's place says the tab could not load, and the filters stay.
    await findByText(AGENT_PAGE_COPY.tabState.failedTitle);
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));

    await findByText('Back again');
  });

  test('opens a chat from its row', async () => {
    landAt('/agents/researcher');
    serve();
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('link', { name: /Plan the week/ }));

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
    // The empty state's New chat owns the page's one primary, so the header's is secondary (row 39p).
    await waitFor(() =>
      expect(links.map((link) => link.getAttribute('data-cinder-variant'))).toEqual([
        'secondary',
        'primary',
      ]),
    );
    await fireEvent.click(links[1] as HTMLElement);

    expect(router.pathname).toBe('/chats/new');
    expect(router.search.get('agent')).toBe('researcher');
  });
});

describe('the tabs of an agent’s page', () => {
  test('write each tab’s own address when it is picked, Chats being the agent’s', async () => {
    landAt('/agents/researcher');
    serve();
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('tab', { name: 'Instructions' }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher/instructions'));
    expect(router.search.get('tab')).toBeNull();
    await fireEvent.click(await findByRole('tab', { name: /^Chats/ }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
  });

  test('replace an address from before the tabs had paths with the tab’s path, and one naming no tab with Chats', async () => {
    landAt('/agents/researcher?tab=access&from=old');
    serve();
    const { findByRole } = mount();

    await waitFor(() => expect(router.pathname).toBe('/agents/researcher/access'));
    expect(router.search.get('tab')).toBeNull();
    // The rest of the query stays.
    expect(router.search.get('from')).toBe('old');
    expect((await findByRole('tab', { name: /^Access/ })).getAttribute('aria-selected')).toBe(
      'true',
    );

    router.navigate('/agents/researcher?tab=nonsense');
    await waitFor(() => expect(router.search.get('tab')).toBeNull());
    expect(router.pathname).toBe('/agents/researcher');
  });

  test('show each tab of the address on a reload', async () => {
    for (const tab of ['instructions', 'access', 'hooks', 'memory', 'settings'] as const) {
      landAt(`/agents/researcher/${tab}`);
      serve();
      const { findByRole, unmount } = mount();
      const name = new RegExp(`^${AGENT_PAGE_COPY.tabs[tab]}`);
      expect((await findByRole('tab', { name })).getAttribute('aria-selected')).toBe('true');
      unmount();
      restore?.();
      restore = undefined;
    }
  });
});

describe('Edit, which the header holds once for every tab', () => {
  test('is in the header alone, not repeated in the Instructions tab, and opens the editor in the app', async () => {
    landAt('/agents/researcher/instructions');
    serve();
    const { findAllByRole, findByTestId } = mount();

    await findByTestId('agent-instructions-body');
    const edits = await findAllByRole('link', { name: 'Edit' });
    expect(edits).toHaveLength(1);
    expect((await findByTestId('agent-header')).contains(edits[0] as HTMLElement)).toBe(true);
    await fireEvent.click(edits[0] as HTMLElement);

    expect(router.pathname).toBe('/agents/researcher/edit');
  });

  test('is left to the browser when a modifier key is held', async () => {
    landAt('/agents/researcher/instructions');
    serve();
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('link', { name: 'Edit' }), { ctrlKey: true });

    expect(router.pathname).toBe('/agents/researcher/instructions');
  });
});

describe('the Instructions tab, when there is nothing to show', () => {
  test('offers to add instructions to a file that has none', async () => {
    landAt('/agents/researcher/instructions');
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
    landAt('/agents/assistant/instructions');
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
    landAt('/agents/researcher/instructions');
    let fail = true;
    serve({
      'bureau.agents.definitions.get': () => {
        if (fail) throw faults.notFound('researcher');
        return readyAgent({ id: 'researcher' });
      },
    });
    const { findByRole, findByText } = mount();

    await findByText(AGENT_PAGE_COPY.tabState.failedTitle);
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));

    await findByText('You are a careful researcher.');
  });
});

describe('the Settings tab, when something goes wrong', () => {
  test('says the settings could not be loaded and tries again', async () => {
    landAt('/agents/researcher/settings');
    let fail = true;
    serve({
      'bureau.agents.definitions.get': () => {
        if (fail) throw faults.notFound('researcher');
        return readyAgent({ id: 'researcher' });
      },
    });
    const { findByRole, findByText, findAllByText } = mount();

    await findByText(AGENT_PAGE_COPY.tabState.failedTitle);
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));

    const models = await findAllByText('anthropic/sonnet');
    expect(models.length).toBeGreaterThan(0);
  });

  test('shows a file with no step limit as running the default of 25 steps', async () => {
    landAt('/agents/researcher/settings');
    serve();
    const { findByTestId } = mount();

    const settings = await findByTestId('agent-settings');

    await waitFor(() => expect(settings.textContent).toContain('anthropic/sonnet'));
    expect(settings.textContent).toContain('Default (25 steps)');
    // Guardrails and the spend and tool limits are on the Access tab.
    expect(settings.textContent).not.toContain('Spend limit');
  });

  test('shows an agent in code without limits, Delete or versions', async () => {
    landAt('/agents/assistant/settings');
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
          card: [],
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
      landAt('/agents/researcher/settings');
      serve({
        'bureau.agents.definitions.delete': () => {
          throw fault;
        },
      });
      const { findByRole, findByText } = mount();

      await fireEvent.click(await findByRole('button', { name: 'Delete agent' }));
      await fireEvent.click(await findByRole('button', { name: 'Delete' }));

      await findByText(new RegExp(message));
      expect(router.pathname).toBe('/agents/researcher/settings');
    });
  }

  test('says a caller who may not delete may not', async () => {
    landAt('/agents/researcher/settings');
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
    landAt('/agents/assistant/settings');
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
    landAt('/agents/researcher/settings');
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
      landAt('/agents/researcher/settings');
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
    const limits = { steps: 12, cost: null, tools: null };
    expect(settingsOf({ ...detail, definition: { ...detail.definition, limits } })).toEqual({
      model: 'anthropic/sonnet',
      models: [],
      stepLimit: '12',
      effort: null,
    });
    expect(settingsOf(detail).stepLimit).toBeNull();
  });

  test('words the default effort the way the editor does, and leaves it when the file sets none', () => {
    const detail = readyAgent({ id: 'researcher' });
    if (detail.definition === null) throw new Error('expected a definition');
    expect(settingsOf(detail).effort).toBeNull();
    expect(
      settingsOf({ ...detail, definition: { ...detail.definition, effort: 'xhigh' } }).effort,
    ).toBe('Extra high');
    expect(settingsOf({ ...detail, source: 'code', definition: null }).effort).toBeNull();
    expect(settingsOf({ ...detail, source: 'code', definition: null })).toMatchObject({
      model: null,
      models: [],
    });
  });
});
