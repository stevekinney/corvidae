import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { createQueryClient, queryKeys } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, CONTEXT, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentDetail from './agent-detail.svelte';
import AgentList from './agent-list.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = (page: unknown) => render(QueryPage, { props: { page } } as never);

const FILE_AGENT = {
  ...AGENT,
  name: 'researcher',
  displayName: 'Researcher',
  kind: 'file',
  description: 'Finds sources.',
};
const INTERNAL = {
  ...AGENT,
  name: 'internal',
  displayName: 'internal',
  description: null,
  publishState: 'unpublished',
};

describe('the list of agents', () => {
  const chat = (id: string, agentName: string, updatedAt: string) => ({
    ...CONTEXT,
    id,
    agentName,
    updatedAt,
  });

  test('shows each agent’s model, tools and use, badges only one that is not published, and offers New chat only for a published one', async () => {
    const recently = new Date(Date.now() - 3 * 60_000).toISOString();
    const served = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT, FILE_AGENT, INTERNAL] }),
      'bureau.agents.definitions.get': (params) => ({
        id: params['id'],
        source: 'file',
        state: 'ready',
        name: 'Researcher',
        description: null,
        published: true,
        hash: 'hash-1',
        problem: null,
        definition: {
          name: 'Researcher',
          description: null,
          published: true,
          model: 'anthropic/sonnet',
          tools: ['lookup-order', 'issue-refund'],
          skills: [],
          instructions: '',
        },
      }),
      'bureau.contexts.list': () => ({
        contexts: [
          chat('session-1', 'assistant', '2026-10-19T09:00:00.000Z'),
          chat('session-2', 'assistant', recently),
          chat('session-3', 'researcher', '2026-10-18T09:00:00.000Z'),
        ],
        nextOffset: null,
      }),
    });
    restore = served.restore;
    landAt('/agents');

    const { container, findByText } = mount(AgentList);

    await findByText('anthropic/sonnet');
    const rows = (name: string) => container.querySelector(`[data-agent="${name}"]`);
    const text = (name: string) => rows(name)?.textContent ?? '';
    // Neither where an agent is defined nor that it is published is worded.
    expect(container.textContent).not.toContain('Defined in');
    expect(container.textContent).not.toContain('Published');
    expect(text('assistant')).toContain('Scripted');
    expect(text('researcher')).toContain('2 tools');
    await waitFor(() =>
      expect(
        rows('assistant')?.querySelector('[data-testid="agent-chat-count"]')?.textContent,
      ).toBe('2 chats'),
    );
    expect(rows('assistant')?.querySelector('[data-testid="agent-last-chat"]')?.textContent).toBe(
      'Last chat 3m ago',
    );
    expect(text('researcher')).toContain('1 chat');
    expect(rows('internal')?.querySelector('[data-testid="agent-chat-count"]')?.textContent).toBe(
      'No chats yet',
    );
    expect(rows('internal')?.querySelector('[data-testid="agent-last-chat"]')).toBeNull();
    // The one badge, and no chat action, on the agent that is not published.
    expect(rows('internal')?.querySelector('[data-testid="agent-not-published"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="agent-not-published"]')).toHaveLength(1);
    expect(rows('internal')?.textContent).not.toContain('New chat');
    expect(rows('assistant')?.querySelector('a[href="/chat/new?agent=assistant"]')).not.toBeNull();
    // Edit for a file agent only, Memory for every agent.
    expect(rows('researcher')?.querySelector('a[href="/agents/researcher/edit"]')).not.toBeNull();
    expect(rows('assistant')?.querySelector('a[href="/agents/assistant/edit"]')).toBeNull();
    for (const name of ['assistant', 'researcher', 'internal']) {
      expect(rows(name)?.querySelector(`a[href="/agents/${name}/memory"]`)).not.toBeNull();
    }
    // A code agent's tools are not told by the Bureau, so none is claimed for it.
    expect(text('assistant')).not.toContain('tools');
  });

  test('says nothing of chat counts when the Bureau cannot list the chats, rather than that there are none', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.contexts.list': () => {
        throw new StubFault('Unavailable', 503, 'The Bureau is down.');
      },
    }).restore;
    landAt('/agents');

    const client = createQueryClient();
    const { container, findByText } = render(QueryPage, {
      props: { page: AgentList, client },
    } as never);

    await findByText('Scripted');
    // The read has failed before anything is asserted about what it left out.
    await waitFor(() =>
      expect(client.getQueryState(queryKeys.contexts.usage())?.status).toBe('error'),
    );
    expect(container.querySelectorAll('[data-testid="agent-chat-count"]')).toHaveLength(0);
    expect(container.textContent).not.toContain('No chats yet');
  });

  test('puts the identifier beside a name that differs from it, and shows an identifier once', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT, INTERNAL] }),
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    }).restore;
    landAt('/agents');

    const { container, findByText } = mount(AgentList);

    await findByText('Assistant');
    const assistant = container.querySelector('[data-agent="assistant"]');
    expect(assistant?.querySelector('.ib-agent-id')?.textContent).toBe('assistant');
    const internal = container.querySelector('[data-agent="internal"]');
    expect(internal?.querySelector('.ib-agent-id')).toBeNull();
    expect(internal?.querySelector('.ib-agent-name')?.hasAttribute('data-identifier')).toBe(true);
  });

  test('opens an agent’s page and a new chat with it, and leaves a modified click to the browser', async () => {
    const served = bureau({ 'bureau.agents.list': () => ({ agents: [AGENT] }) });
    restore = served.restore;
    landAt('/agents');
    const { findByRole } = mount(AgentList);

    const name = await findByRole('link', { name: 'Assistant' });
    name.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/agents');
    name.click();
    expect(router.pathname).toBe('/agents/assistant');

    landAt('/agents');
    const action = await findByRole('link', { name: 'New chat' });
    action.click();
    expect(router.current.search.get('agent')).toBe('assistant');
    expect(router.pathname).toBe('/chat/new');
  });
});

const INVALID_LISTING = {
  id: 'broken',
  source: 'file',
  state: 'invalid',
  name: 'broken',
  description: null,
  published: false,
  hash: 'hash-bad',
  problem: { code: 'unknown-model', message: 'The model is not in the catalog.', issues: null },
};

const READY_LISTING = {
  ...INVALID_LISTING,
  id: 'researcher',
  name: 'Researcher',
  state: 'ready',
  problem: null,
};

const hostPaths = (url: string) =>
  url.endsWith('/host/paths')
    ? Response.json({
        agentDirectory: '/home/tester/.interborough/agents',
        workflowDirectory: '/home/tester/.interborough/workflows',
      })
    : undefined;

describe('the list of agents, and the agent editor', () => {
  test('offers New agent, which opens the form for a new agent', async () => {
    restore = bureau({ 'bureau.agents.list': () => ({ agents: [AGENT] }) }).restore;
    landAt('/agents');
    const { findByRole } = mount(AgentList);

    const action = await findByRole('link', { name: AGENT_EDITOR_COPY.newAction });
    expect(action.getAttribute('href')).toBe('/agents/new');
    action.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(router.pathname).toBe('/agents');
    action.click();
    expect(router.pathname).toBe('/agents/new');
  });

  test('shows an invalid agent file with its error and its path, and a way to its editor', async () => {
    const served = bureau(
      {
        'bureau.agents.list': () => ({ agents: [AGENT, FILE_AGENT] }),
        'bureau.agents.definitions.list': () => ({
          agents: [{ ...READY_LISTING }, INVALID_LISTING],
          nextOffset: null,
        }),
      },
      hostPaths,
    );
    restore = served.restore;
    landAt('/agents');
    const { container, findByText, getByRole } = mount(AgentList);

    await findByText(AGENT_EDITOR_COPY.invalidBadge);
    const row = container.querySelector('[data-agent="broken"]');
    expect(row?.getAttribute('data-state')).toBe('invalid');
    expect(row?.textContent).toContain('unknown-model');
    expect(row?.textContent).toContain('The model is not in the catalog.');
    expect(row?.querySelector('[data-testid="agent-file-path"]')?.textContent).toBe(
      '/home/tester/.interborough/agents/broken.md',
    );
    // A file that loaded is listed once, by `bureau.agents.list`, and never as invalid.
    expect(container.querySelectorAll('[data-agent="researcher"]')).toHaveLength(1);
    expect(
      container.querySelector('[data-agent="researcher"]')?.getAttribute('data-state'),
    ).toBeNull();
    getByRole('link', { name: 'broken' }).click();
    expect(router.pathname).toBe('/agents/broken/edit');
  });

  test('follows the definitions list to its last page, and shows the path relative to the state directory when the host does not say', async () => {
    const pages: Record<string, unknown> = {
      0: { agents: [INVALID_LISTING], nextOffset: 1 },
      1: {
        agents: [{ ...INVALID_LISTING, id: 'broken-two', name: 'broken-two' }],
        nextOffset: null,
      },
    };
    const served = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.definitions.list': (params) => pages[String(params['offset'])],
    });
    restore = served.restore;
    landAt('/agents');
    const { container, findByText } = mount(AgentList);

    await findByText('broken-two');
    expect(
      container.querySelector('[data-agent="broken-two"] [data-testid="agent-file-path"]')
        ?.textContent,
    ).toBe('agents/broken-two.md');
    expect(
      served.calls
        .filter((call) => call.method === 'bureau.agents.definitions.list')
        .map((call) => call.params['offset']),
    ).toEqual([0, 1]);
  });
});

describe('one agent’s page', () => {
  function serve(
    agent: Record<string, unknown>,
    definition: Record<string, unknown> | null = null,
    contexts: (params: Record<string, unknown>) => unknown = () => ({
      contexts: [{ ...CONTEXT, agentName: agent['name'] }],
      nextOffset: null,
    }),
  ) {
    const served = bureau({
      'bureau.agents.list': () => ({ agents: [agent] }),
      // The shape the Bureau answers, which the agent editor's client parses in full.
      'bureau.agents.definitions.get': () => ({
        id: agent['name'],
        source: agent['kind'],
        state: 'ready',
        name: agent['displayName'],
        description: null,
        published: true,
        hash: definition === null ? null : 'hash-1',
        problem: null,
        definition:
          definition === null
            ? null
            : { name: agent['displayName'], description: null, published: true, ...definition },
      }),
      'bureau.contexts.list': contexts,
      'bureau.memory.list': memoryList,
    });
    restore = served.restore;
    return served;
  }

  const MEMORY = {
    id: 'memory-1',
    content: 'Likes aisle seats.',
    memoryClass: 'episodic',
    source: 'chat',
    trust: 'observed',
    createdAt: '2026-10-19T08:00:00.000Z',
    sessionId: null,
  };
  let memoryList: (params: Record<string, unknown>) => unknown = () => ({
    memories: [MEMORY],
    nextOffset: null,
  });
  beforeEach(() => {
    memoryList = () => ({ memories: [MEMORY], nextOffset: null });
  });

  test('does not repeat a chat that the next page gives again, and stays', async () => {
    const chat = (index: number) => ({
      ...CONTEXT,
      id: `session-${index}`,
      title: `Chat ${index}`,
      agentName: 'researcher',
    });
    // A chat began after the first page was read, so offset 1 starts with the row page 0 ended on.
    serve(FILE_AGENT, null, (params) =>
      params['offset'] === 0
        ? { contexts: [chat(0), chat(1)], nextOffset: 2 }
        : { contexts: [chat(1), chat(2)], nextOffset: null },
    );
    landAt('/agents/researcher');
    const { container, findByRole, findByText } = mount(AgentDetail);
    await findByText('Chat 1');

    const more = await findByRole('button', { name: 'Load more' });
    more.click();

    await findByText('Chat 2');
    expect(container.textContent).not.toContain('Something went wrong');
    expect(container.textContent?.match(/Chat 1/g)).toHaveLength(1);
  });

  test('shows a file agent’s model, tools and skills, its file version, and its chats, with the name once', async () => {
    const served = serve(FILE_AGENT, {
      model: 'anthropic/sonnet',
      tools: ['lookup-order'],
      skills: [{ id: 'cite', name: 'Cite', description: 'Cites sources', tags: [] }],
      instructions: 'Be careful.',
    });
    landAt('/agents/researcher');

    const { container, findByText } = mount(AgentDetail);

    await findByText('anthropic/sonnet');
    expect(container.textContent).toContain('lookup-order');
    expect(container.textContent).toContain('Cite');
    // The version of the file, by its short hash, with the history that lives in the editor.
    const version = container.querySelector('[data-testid="agent-file-version"]');
    expect(version?.textContent).toContain('File version');
    expect(version?.querySelector('code')?.textContent).toBe('hash-1');
    expect(version?.querySelector('a')?.getAttribute('href')).toBe('/agents/researcher/edit');
    expect(container.textContent).not.toContain('Revision');
    expect(container.querySelector('h1')?.textContent?.trim()).toBe('Researcher');
    await findByText('Plan the week');
    expect(
      served.calls.find((call) => call.method === 'bureau.contexts.list')?.params,
    ).toMatchObject({ agentName: 'researcher' });
  });

  test('says a file agent that names no tools has none, and has no skills section', async () => {
    serve(FILE_AGENT, { model: 'anthropic/sonnet', tools: [], skills: [], instructions: '' });
    landAt('/agents/researcher');

    const { container, findByText } = mount(AgentDetail);

    await findByText('anthropic/sonnet');
    expect(container.querySelector('[data-testid="agent-facts"]')?.textContent).toContain(
      'No tools',
    );
    expect(container.textContent).not.toContain('Skills');
  });

  test('reads no definition for an agent defined in code, shows it as Scripted with no version, and offers New chat when it is published', async () => {
    const served = serve(AGENT);
    landAt('/agents/assistant');

    const { container, findByRole } = mount(AgentDetail);

    const action = await findByRole('link', { name: 'New chat' });
    const shown = container.textContent ?? '';
    for (const present of ['Assistant', 'Answers every message.', 'Scripted']) {
      expect(shown).toContain(present);
    }
    // Where it is defined and that it is published are not worded, it has no file version, and
    // the Bureau tells nothing of its tools, so none is claimed, not even "No tools".
    for (const absent of [
      'Defined in',
      'Published',
      'Revision',
      'File version',
      'tools',
      'Skills',
    ]) {
      expect(shown).not.toContain(absent);
    }
    action.click();
    expect(router.current.search.get('agent')).toBe('assistant');
    expect(served.calls.some((call) => call.method === 'bureau.agents.definitions.get')).toBe(
      false,
    );
  });

  test('names the model of a code-defined agent that has one, from the models it allows', async () => {
    const withModel = { ...AGENT, media: { modalities: {}, mimeFamilies: [], mediaLimits: [] } };
    const served = bureau({
      'bureau.agents.list': () => ({ agents: [withModel] }),
      'bureau.agents.models': () => ({
        selectable: false,
        models: [{ provider: 'anthropic', model: 'claude-haiku', displayName: 'claude-haiku' }],
        default: { provider: 'anthropic', model: 'claude-haiku' },
      }),
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
      'bureau.memory.list': memoryList,
    });
    restore = served.restore;
    landAt('/agents/assistant');

    const { container, findByText } = mount(AgentDetail);

    await findByText('claude-haiku');
    expect(container.textContent).not.toContain('Scripted');
    expect(served.calls.some((call) => call.method === 'bureau.agents.models')).toBe(true);
  });

  test('links the memory count to the memory page', async () => {
    serve(AGENT);
    landAt('/agents/assistant');
    const { findByRole } = mount(AgentDetail);

    const link = await findByRole('link', { name: 'Memory (1)' });
    expect(link.getAttribute('href')).toBe('/agents/assistant/memory');
    link.click();
    expect(router.pathname).toBe('/agents/assistant/memory');
  });

  test('marks a memory count that has more pages unread, and says just Memory for an agent that remembers nothing', async () => {
    memoryList = () => ({ memories: [MEMORY], nextOffset: 1 });
    serve(AGENT);
    landAt('/agents/assistant');
    const more = mount(AgentDetail);
    await more.findByRole('link', { name: 'Memory (1+)' });
    more.unmount();
    restore?.();

    memoryList = () => ({ memories: [], nextOffset: null });
    serve(AGENT);
    landAt('/agents/assistant');
    const none = mount(AgentDetail);
    await none.findByRole('link', { name: 'New chat' });
    expect(none.getByRole('link', { name: 'Memory' }).getAttribute('href')).toBe(
      '/agents/assistant/memory',
    );
  });

  test('keeps the Memory action and drops the count when the Bureau cannot read the memory', async () => {
    memoryList = () => {
      throw new StubFault('Forbidden', 403, 'Memory is locked.');
    };
    serve(AGENT);
    landAt('/agents/assistant');
    const { findByRole, getByRole } = mount(AgentDetail);

    await findByRole('link', { name: 'New chat' });
    expect(getByRole('link', { name: 'Memory' }).getAttribute('href')).toBe(
      '/agents/assistant/memory',
    );
  });

  test('offers Edit for an agent that is a file, whether or not it is published, and not for one defined in code', async () => {
    serve(FILE_AGENT, { model: 'anthropic/sonnet', tools: [], skills: [], instructions: '' });
    landAt('/agents/researcher');
    const file = mount(AgentDetail);

    const edit = await file.findByRole('link', { name: AGENT_EDITOR_COPY.editAction });
    expect(edit.getAttribute('href')).toBe('/agents/researcher/edit');
    edit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/agents/researcher');
    edit.click();
    expect(router.pathname).toBe('/agents/researcher/edit');
    file.unmount();
    restore?.();

    serve(AGENT);
    landAt('/agents/assistant');
    const code = mount(AgentDetail);
    await code.findByRole('link', { name: 'New chat' });
    expect(code.queryByRole('link', { name: AGENT_EDITOR_COPY.editAction })).toBeNull();
  });

  test('offers no New chat for an agent that is not published, and says so', async () => {
    serve(INTERNAL);
    landAt('/agents/internal');

    const { container, findByText, queryByRole } = mount(AgentDetail);

    await findByText('Not published');
    expect(queryByRole('link', { name: 'New chat' })).toBeNull();
    expect(container.textContent).not.toContain('Model');
  });

  test('opens a session from its list', async () => {
    serve(AGENT);
    landAt('/agents/assistant');
    const { findByRole } = mount(AgentDetail);

    const row = await findByRole('button', { name: /Plan the week/ });
    row.click();

    await waitFor(() => expect(router.pathname).toBe('/chat/session-1'));
  });
});
