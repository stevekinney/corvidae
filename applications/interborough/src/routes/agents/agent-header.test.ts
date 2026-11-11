/**
 * The frame every tab of an agent's page shares (board PageAgent, rows 38a to 38d, 39c to 39g and
 * 46g): the header with the name and its identifier, the description, the status line and the
 * reason an agent cannot answer, its actions, the tab bar with each tab's count, what a tab's body
 * shows while it loads, fails or holds old data, and the page of an agent a disabled plugin ships.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_PAGE_COPY } from '../../app/copy.ts';
import {
  installBureauStub,
  readyAgent,
  StubFault,
  type BureauHandler,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { createQueryClient, queryKeys } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, CONTEXT, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentDetail from './agent-detail.svelte';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const mount = (client = createQueryClient()) =>
  render(QueryPage, { props: { page: AgentDetail, client } } as never);

const MEDIA = { modalities: {}, mimeFamilies: [], mediaLimits: [] };
const FILE_AGENT = {
  ...AGENT,
  name: 'researcher',
  displayName: 'Researcher',
  kind: 'file',
  description: 'Finds sources.',
  media: MEDIA,
};
const HOOK = {
  id: 'hook-1',
  owner: 'anonymous:local',
  name: null,
  action: { type: 'notify', title: null },
  events: ['review.requested'],
  scope: { kind: 'agent', id: 'researcher' },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  lastDelivery: null,
};
const chat = (id: string, activity: string, agentName = 'researcher') => ({
  ...CONTEXT,
  id,
  agentName,
  activity,
});

/** The server for one test: the file agent with two chats, one waiting, and whatever a test overrides. */
function serve(
  answers: Record<string, BureauHandler> = {},
  providers: readonly { readonly name: string; readonly hasKey: boolean }[] = [
    { name: 'anthropic', hasKey: true },
  ],
): BureauStub {
  stub = installBureauStub(
    {
      'bureau.agents.list': () => ({ agents: [FILE_AGENT] }),
      'bureau.agents.definitions.get': () => readyAgent({ id: 'researcher' }),
      'bureau.contexts.list': () => ({
        contexts: [chat('a', 'awaiting-input'), chat('b', 'idle')],
        nextOffset: null,
      }),
      'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
      'bureau.hooks.list': () => ({ hooks: [HOOK] }),
      'bureau.agents.versions.list': () => ({ versions: [] }),
      ...answers,
    },
    { hostProviders: providers },
  );
  return stub;
}

describe('the header every tab of an agent’s page shares', () => {
  test('names the agent once, with its identifier small beside the heading, and its description', async () => {
    landAt('/agents/researcher');
    serve();
    const { container, findByTestId } = mount();

    const header = await findByTestId('agent-header');
    expect(header.querySelector('h1')?.textContent?.trim()).toBe('Researcher');
    const identifier = await findByTestId('agent-identifier');
    expect(identifier.tagName).toBe('CODE');
    expect(identifier.textContent).toBe('researcher');
    // Beside the heading, not in it, so the heading reads as the agent's name.
    expect(header.querySelector('h1')?.contains(identifier)).toBe(false);
    expect(container.textContent).toContain('Finds sources.');
    // No avatar: the agent is its name, as on the list.
    expect(header.querySelector('.cinder-avatar, img')).toBeNull();
  });

  test('says what the chats are doing and how many there are, with the dot in its tone', async () => {
    landAt('/agents/researcher');
    serve();
    const { findByTestId } = mount();

    const status = await findByTestId('agent-status');
    await waitFor(() => expect(status.textContent).toContain('Waiting on you, 2 chats'));
    expect(status.querySelector('[data-cinder-status="warning"]')).not.toBeNull();
    // A comma separates the parts: never a middle dot.
    expect(status.textContent).not.toContain(String.fromCodePoint(0xb7));
  });

  test('says an agent on a model cannot answer while no provider is connected, with the way to connect one', async () => {
    landAt('/agents/researcher');
    serve({}, [{ name: 'anthropic', hasKey: false }]);
    const { findByTestId } = mount();

    const reason = await findByTestId('agent-provider-reason');
    expect(reason.textContent).toContain(AGENT_PAGE_COPY.header.needsProvider);
    const link = within(reason).getByRole('link', { name: AGENT_PAGE_COPY.header.connectProvider });
    expect(link.getAttribute('href')).toBe('/settings/models');
    await fireEvent.click(link);
    expect(router.pathname).toBe('/settings/models');
  });

  test('says nothing of providers while one holds a key', async () => {
    landAt('/agents/researcher');
    serve();
    const { findByTestId, queryByTestId } = mount();

    await findByTestId('agent-status');
    expect(queryByTestId('agent-provider-reason')).toBeNull();
  });

  test('holds a secondary Edit with its pencil and the primary New chat, and no Memory action', async () => {
    landAt('/agents/researcher');
    serve();
    const { findByRole, findByTestId } = mount();

    const header = await findByTestId('agent-header');
    const edit = await findByRole('link', { name: 'Edit' });
    expect(header.contains(edit)).toBe(true);
    expect(edit.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(edit.querySelector('svg')).not.toBeNull();
    const newChat = within(header).getByRole('link', { name: 'New chat' });
    expect(newChat.getAttribute('data-cinder-variant')).toBe('primary');
    expect(newChat.querySelector('svg')).not.toBeNull();
    // Memory is a tab, not an action, and an owner's agent is edited, not duplicated, from here.
    expect(within(header).queryByRole('link', { name: /Memory/ })).toBeNull();
    expect(within(header).queryByRole('link', { name: AGENT_PAGE_COPY.duplicate })).toBeNull();
  });
});

describe('the tab bar of an agent’s page', () => {
  test('carries each tab’s count once it is known, zero included, in the order the design gives', async () => {
    landAt('/agents/researcher');
    serve();
    const { findByRole, getAllByRole } = mount();

    await findByRole('tab', { name: 'Chats 2' });
    await findByRole('tab', { name: 'Access 1' });
    await findByRole('tab', { name: 'Hooks 1' });
    await findByRole('tab', { name: 'Memory 0' });
    expect(getAllByRole('tab').map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Chats 2',
      'Instructions',
      'Access 1',
      'Hooks 1',
      'Memory 0',
      'Settings',
    ]);
  });

  test('opens Chats for the agent’s own address', async () => {
    landAt('/agents/researcher');
    serve();
    const { findByRole } = mount();

    const awaited184 = await findByRole('tab', { name: /^Chats/ });
    expect(awaited184.getAttribute('aria-selected')).toBe('true');
  });
});

describe('a tab’s body while it loads, fails or holds old data', () => {
  test('shows the placeholder in the tab body alone, with the header and the tabs live', async () => {
    landAt('/agents/researcher/settings');
    serve({ 'bureau.agents.definitions.get': () => new Promise(() => {}) });
    const { findByRole, findByTestId } = mount();

    await findByTestId('agent-tab-loading');
    expect(await findByTestId('agent-header')).not.toBeNull();
    expect(await findByRole('link', { name: 'New chat' })).not.toBeNull();
    const awaited199 = await findByRole('tab', { name: 'Settings' });
    expect(awaited199.getAttribute('aria-selected')).toBe('true');
  });

  test('says the tab could not load in its body alone, with the server’s status and Try again', async () => {
    landAt('/agents/researcher/settings');
    let failing = true;
    serve({
      'bureau.agents.definitions.get': () => {
        if (failing) throw new StubFault('EngineFailure', 500, 'It broke.');
        return readyAgent({ id: 'researcher' });
      },
    });
    const { findByRole, findByTestId } = mount();

    const failed = await findByTestId('agent-tab-failed');
    expect(failed.textContent).toContain(AGENT_PAGE_COPY.tabState.failedTitle);
    expect(failed.textContent).toContain(AGENT_PAGE_COPY.tabState.failedDescription(500));
    expect(await findByTestId('agent-header')).not.toBeNull();
    expect(await findByRole('tablist')).not.toBeNull();

    failing = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    const model = await findByTestId('agent-settings-model');
    await waitFor(() => expect(model.textContent?.trim()).toBe('Sonnet, Anthropic'));
  });

  test('keeps the old data under a banner that says when it was read, holds Edit, and never shows the error too', async () => {
    landAt('/agents/researcher/instructions');
    let failing = false;
    serve({
      'bureau.agents.definitions.get': () => {
        if (failing) throw new StubFault('EngineFailure', 500, 'It broke.');
        return readyAgent({ id: 'researcher' });
      },
    });
    const client = createQueryClient();
    const { findByRole, findByTestId, queryByTestId } = mount(client);
    await findByTestId('agent-instructions-body');

    failing = true;
    await client
      .refetchQueries({ queryKey: queryKeys.agents.definition('researcher') })
      .catch(() => undefined);

    const banner = await findByTestId('agent-tab-stale');
    expect(banner.textContent).toContain(AGENT_PAGE_COPY.tabState.staleTitle);
    expect(banner.textContent).toContain('Showing this tab as of');
    // The old data stays, and the error state is not drawn beside it.
    expect(await findByTestId('agent-instructions-body')).not.toBeNull();
    expect(queryByTestId('agent-tab-failed')).toBeNull();
    // Edit would change the agent, so it is held while the tab is old; New chat stays live.
    await waitFor(async () => {
      const edit = await findByRole('link', { name: 'Edit' });
      expect(edit.getAttribute('aria-disabled')).toBe('true');
    });

    failing = false;
    await fireEvent.click(within(banner).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(queryByTestId('agent-tab-stale')?.outerHTML ?? null).toBeNull());
    await waitFor(async () => {
      const edit = await findByRole('link', { name: 'Edit' });
      expect(edit.getAttribute('aria-disabled')).not.toBe('true');
    });
  });
});

describe('the page of an agent a disabled plugin ships', () => {
  const RELEASE_HELPER = readyAgent({
    id: 'demo:release-helper',
    name: 'Release helper',
    description: 'Drafts release notes from the pull requests merged since the last tag.',
    source: 'code',
    state: 'unavailable',
    unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
    hash: null,
    definition: null,
  });

  function serveUnavailable(): BureauStub {
    return serve({
      // The list holds what can run, so it leaves the agent out.
      'bureau.agents.list': () => ({ agents: [FILE_AGENT] }),
      'bureau.agents.definitions.get': () => RELEASE_HELPER,
      'bureau.contexts.list': () => ({
        contexts: [chat('c', 'idle', 'demo:release-helper')],
        nextOffset: null,
      }),
      'bureau.hooks.list': () => ({ hooks: [] }),
    });
  }

  test('reads it from its definition: Unavailable in a neutral tone, Duplicate, and New chat held with its reason', async () => {
    landAt('/agents/demo%3Arelease-helper');
    serveUnavailable();
    const { findByRole, findByTestId, queryByRole } = mount();

    const header = await findByTestId('agent-header');
    expect(header.querySelector('h1')?.textContent?.trim()).toBe('Release helper');
    const awaited301 = await findByTestId('agent-identifier');
    expect(awaited301.textContent).toBe('demo:release-helper');
    const status = await findByTestId('agent-status');
    await waitFor(() => expect(status.textContent).toContain('Unavailable, 1 chat'));
    expect(status.querySelector('[data-cinder-status="neutral"]')).not.toBeNull();

    const duplicate = within(header).getByRole('button', {
      name: AGENT_PAGE_COPY.plugin.duplicate,
    });
    expect(duplicate.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(queryByRole('link', { name: 'Edit' })).toBeNull();
    // Held, not removed: it stays focusable and says why it is off.
    const newChat = within(header).getByRole('button', { name: 'New chat' });
    expect(newChat.getAttribute('aria-disabled')).toBe('true');
    expect(queryByRole('link', { name: 'New chat' })).toBeNull();
    await findByRole('tab', { name: 'Chats 1' });
  });

  for (const [tab, path] of [
    ['Chats', '/agents/demo%3Arelease-helper'],
    ['Settings', '/agents/demo%3Arelease-helper/settings'],
  ] as const) {
    test(`heads the ${tab} tab with the banner that says why, and asks before it enables the plugin and restarts`, async () => {
      landAt(path);
      serveUnavailable();
      const { findByRole, findByTestId } = mount();

      const banner = await findByTestId('agent-unavailable');
      expect(banner.textContent).toContain(AGENT_PAGE_COPY.unavailable.title('Release helper'));
      expect(banner.textContent).toContain(AGENT_PAGE_COPY.unavailable.description('Demo'));
      await fireEvent.click(
        within(banner).getByRole('button', { name: AGENT_PAGE_COPY.unavailable.enable }),
      );
      expect(
        await findByRole('dialog', { name: 'Enable the Demo plugin and restart?' }),
      ).not.toBeNull();
    });
  }
});
