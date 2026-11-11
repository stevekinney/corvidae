import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import {
  STUB_REMOTE_AGENT_DIRECTORY,
  StubFault,
  stubHostPaths,
  stubRemoteHostPaths,
} from '../../lib/bureau-stub.test-support.ts';
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
// A code agent whose listing names its tools; `INTERNAL` and `AGENT` name none, so they do not say.
const ASSISTANT = { ...AGENT, tools: ['search-web', 'send-mail'] };
const INTERNAL = {
  ...AGENT,
  name: 'internal',
  displayName: 'internal',
  description: null,
  a2a: true,
};

describe('the list of agents', () => {
  const chat = (id: string, agentName: string, updatedAt: string) => ({
    ...CONTEXT,
    id,
    agentName,
    updatedAt,
    origin: 'chat' as 'chat' | 'goal' | 'schedule',
  });
  // The clock of today, "Yesterday" or a day: the words a row says when an agent was last used.
  const WHEN = /^(\d{1,2}:\d{2} [AP]M|Yesterday|[A-Z][a-z]{2} \d{1,2})$/;

  test('shows each agent as a status-first row: its name, identifier and last use, its chats, what waits on the person, and a fixed slot of icon buttons', async () => {
    const recently = new Date(Date.now() - 3 * 60_000).toISOString();
    const served = bureau({
      'bureau.agents.list': () => ({ agents: [ASSISTANT, FILE_AGENT, INTERNAL] }),
      // The Bureau filters by origin before it pages, so a goal's or a schedule's session is in
      // the count only when the request asks for them.
      'bureau.contexts.list': (params) => ({
        contexts: [
          chat('session-1', 'assistant', '2026-10-19T09:00:00.000Z'),
          { ...chat('session-2', 'assistant', recently), activity: 'awaiting-input' as const },
          chat('session-3', 'researcher', '2026-10-18T09:00:00.000Z'),
          { ...chat('goal-session', 'assistant', recently), origin: 'goal' as const },
          { ...chat('fire-session', 'researcher', recently), origin: 'schedule' as const },
        ].filter(
          (context) => params['origin'] === undefined || context.origin === params['origin'],
        ),
        nextOffset: null,
      }),
    });
    restore = served.restore;
    landAt('/agents');

    const { container, findByRole } = mount(AgentList);

    await findByRole('link', { name: /^Assistant/ });
    const rows = (name: string) => container.querySelector(`[data-agent="${name}"]`);
    const part = (name: string, testId: string) =>
      rows(name)?.querySelector(`[data-testid="${testId}"]`);
    await waitFor(() => expect(part('assistant', 'agent-chat-count')?.textContent).toBe('2 chats'));

    // Where an agent is defined is not worded, no tool count is drawn, and no avatar leads a row.
    expect(container.textContent).not.toContain('Defined in');
    expect(rows('researcher')?.textContent).not.toContain('tools');
    expect(rows('researcher')?.textContent).not.toContain('anthropic/sonnet');
    expect(container.querySelector('[class*="avatar"]')).toBeNull();

    // Line one: the human name, the identifier once, and when the agent was last used.
    expect(rows('assistant')?.querySelector('.ib-agent-name')?.textContent).toBe('Assistant');
    expect(part('assistant', 'agent-identifier')?.textContent).toBe('assistant');
    expect(rows('internal')?.querySelector('.ib-agent-name')?.textContent).toBe('Internal');
    expect(part('internal', 'agent-identifier')?.textContent).toBe('internal');
    expect(part('assistant', 'agent-last-chat')?.textContent).toMatch(WHEN);
    expect(part('researcher', 'agent-last-chat')?.textContent).toMatch(WHEN);
    expect(part('internal', 'agent-last-chat')?.textContent).toBe('No activity yet');

    // Line two: the description, then the count, with "Built in" after it for the host's own agents.
    expect(part('assistant', 'agent-description')?.textContent).toBe('Answers every message.');
    expect(part('researcher', 'agent-chat-count')?.textContent).toBe('1 chat');
    expect(part('internal', 'agent-chat-count')?.textContent).toBe('No chats yet');
    expect(part('assistant', 'agent-built-in')?.textContent).toBe('Built in');
    expect(part('researcher', 'agent-built-in')).toBeNull();

    // An agent with a chat that waits on the person says so in the status column, in words.
    expect(part('assistant', 'agent-needs-you')?.textContent).toContain('Waiting on you');
    expect(part('researcher', 'agent-needs-you')).toBeNull();
    expect(part('internal', 'agent-needs-you')).toBeNull();

    // The row is one link to the agent's page, and a modified click is left to the browser.
    const link = rows('assistant')?.querySelector<HTMLAnchorElement>('a[href="/agents/assistant"]');
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/agents');
    link?.click();
    expect(router.pathname).toBe('/agents/assistant');

    // Only the chats a person started are counted, asked of the Bureau so it filters before paging.
    const listed = served.calls.filter((call) => call.method === 'bureau.contexts.list');
    expect(listed.length).toBeGreaterThan(0);
    for (const call of listed) expect(call.params).toMatchObject({ origin: 'chat' });

    // Every agent offers Memory and New chat, each named for the agent; Edit is for a file agent
    // only, and the slot keeps its place where there is none.
    for (const name of ['assistant', 'researcher', 'internal']) {
      expect(rows(name)?.querySelector(`a[href="/agents/${name}/memories"]`)).not.toBeNull();
      expect(rows(name)?.querySelector(`a[href="/chats/new?agent=${name}"]`)).not.toBeNull();
    }
    expect(rows('assistant')?.querySelector('[aria-label="Memory of Assistant"]')).not.toBeNull();
    expect(
      rows('assistant')?.querySelector('[aria-label="New chat with Assistant"]'),
    ).not.toBeNull();
    expect(rows('researcher')?.querySelector('a[href="/agents/researcher/edit"]')).not.toBeNull();
    expect(rows('researcher')?.querySelector('[aria-label="Edit Researcher"]')).not.toBeNull();
    expect(rows('assistant')?.querySelector('a[href="/agents/assistant/edit"]')).toBeNull();
    expect(rows('assistant')?.querySelector('.ib-agent-row__no-edit')).not.toBeNull();
  });

  test('says nothing of chat counts or times when the Bureau cannot list the chats, rather than that there are none', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.contexts.list': () => {
        throw new StubFault('Unavailable', 503, 'The Bureau is down.');
      },
    }).restore;
    landAt('/agents');

    const client = createQueryClient();
    const { container, findByRole } = render(QueryPage, {
      props: { page: AgentList, client },
    } as never);

    await findByRole('link', { name: /^Assistant/ });
    // The read has failed before anything is asserted about what it left out.
    await waitFor(() =>
      expect(client.getQueryState(queryKeys.contexts.usage())?.status).toBe('error'),
    );
    expect(container.querySelectorAll('[data-testid="agent-chat-count"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="agent-last-chat"]')).toHaveLength(0);
    expect(container.textContent).not.toContain('No chats yet');
    expect(container.textContent).not.toContain('No activity yet');
  });

  test('lists the agents that can run in one card, most recently used first and never used last, under the words that say so', async () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    restore = bureau({
      'bureau.agents.list': () => ({ agents: [INTERNAL, ASSISTANT, FILE_AGENT] }),
      'bureau.contexts.list': () => ({
        contexts: [
          chat('session-1', 'assistant', minutesAgo(60)),
          chat('session-2', 'researcher', minutesAgo(1)),
        ],
        nextOffset: null,
      }),
    }).restore;
    landAt('/agents');
    const { container, findByRole, findByText } = mount(AgentList);

    await findByRole('heading', { level: 2, name: 'Available 3' });
    await findByText('Sorted by last activity');
    const card = container.querySelector('[data-testid="agents-available"]');
    await waitFor(() =>
      expect(
        [...(card?.querySelectorAll('[data-agent]') ?? [])].map((row) =>
          row.getAttribute('data-agent'),
        ),
      ).toEqual(['researcher', 'assistant', 'internal']),
    );
    // Nothing is held back, so there is no second card.
    expect(container.querySelector('[data-testid="agents-unavailable"]')).toBeNull();
  });

  test('puts the identifier once beside the name, and an agent with no other name reads its identifier in words', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT, INTERNAL] }),
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    }).restore;
    landAt('/agents');

    const { container, findByRole } = mount(AgentList);

    await findByRole('link', { name: /^Assistant/ });
    for (const name of ['assistant', 'internal']) {
      const row = container.querySelector(`[data-agent="${name}"]`);
      expect(row?.querySelectorAll('.ib-agent-id')).toHaveLength(1);
      expect(row?.querySelector('.ib-agent-id')?.textContent).toBe(name);
    }
  });

  test('counts the agents in segments, narrows them by a search, and offers Clear filters when none matches', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT, INTERNAL] }),
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    }).restore;
    landAt('/agents');
    const { container, findByRole, findByLabelText } = mount(AgentList);

    await findByRole('link', { name: /^Assistant/ });
    await findByRole('radio', { name: /^All\s*,\s*2$/ });
    await findByRole('radio', { name: /^Available\s*,\s*2$/ });

    const search = await findByLabelText('Search agents');
    await fireEvent.input(search, { target: { value: 'intern' } });
    await waitFor(() =>
      expect(container.querySelector('[data-agent="assistant"]') === null).toBe(true),
    );
    expect(container.querySelector('[data-agent="internal"]')).not.toBeNull();
    await findByRole('radio', { name: /^All\s*,\s*1$/ });

    // Emptying the search takes it out again.
    await fireEvent.input(search, { target: { value: '' } });
    await waitFor(() => expect(container.querySelector('[data-agent="assistant"]')).not.toBeNull());
    await fireEvent.input(search, { target: { value: 'intern' } });
    await waitFor(() =>
      expect(container.querySelector('[data-agent="assistant"]') === null).toBe(true),
    );

    await fireEvent.input(search, { target: { value: 'nothing like this' } });
    await findByRole('heading', { level: 2, name: 'No agent matches this search' });
    expect(container.querySelector('[data-cinder-kind="filtered"]')).not.toBeNull();
    // The header keeps its "+", and Clear filters is the state's only action.
    expect(container.querySelector('a[href="/agents/new"]')).not.toBeNull();
    const clear = container.querySelector<HTMLButtonElement>(
      '[data-cinder-kind="filtered"] button',
    );
    if (clear === null) throw new Error('The empty state did not offer Clear filters.');
    await fireEvent.click(clear);
    await waitFor(() => expect(container.querySelector('[data-agent="assistant"]')).not.toBeNull());
  });

  test('says there are no agents, with New agent as the one primary button and Add a plugin beside it, when the Bureau lists none', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({ agents: [] }),
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    }).restore;
    landAt('/agents');
    const { container, findByRole } = mount(AgentList);

    await findByRole('heading', { level: 2, name: 'No agents yet' });
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
    const action = container.querySelector<HTMLAnchorElement>(
      '[data-cinder-kind="first-use"] a[href="/agents/new"]',
    );
    expect(action).not.toBeNull();
    expect(
      container.querySelector('[data-cinder-kind="first-use"] a[href="/settings/plugins"]')
        ?.textContent,
    ).toContain('Add a plugin');
    // The header keeps its subtitle and its secondary "+".
    expect(container.textContent).toContain('Agents run your chats, goals and schedules.');
    expect(container.querySelector('a[aria-label="New agent"]')).not.toBeNull();
  });

  test('offers a compact line for the first agent of your own when only the host’s agents exist', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT, INTERNAL] }),
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    }).restore;
    landAt('/agents');
    const { container, findByText } = mount(AgentList);

    await findByText('No agents of your own yet');
    const compact = container.querySelector('[data-testid="agents-none-of-yours"]');
    expect(compact?.textContent).toContain(
      'Built-in agents are ready; add your own for work they don’t cover.',
    );
    expect(compact?.querySelector('a[href="/agents/new"]')).not.toBeNull();
  });

  test('says nothing of your own agents once one exists', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT, FILE_AGENT] }),
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    }).restore;
    landAt('/agents');
    const { container, findByRole } = mount(AgentList);

    await findByRole('link', { name: /^Researcher/ });
    expect(container.querySelector('[data-testid="agents-none-of-yours"]')).toBeNull();
  });

  test('opens an agent’s page and a new chat with it, and leaves a modified click to the browser', async () => {
    const served = bureau({ 'bureau.agents.list': () => ({ agents: [AGENT] }) });
    restore = served.restore;
    landAt('/agents');
    const { findByRole } = mount(AgentList);

    const name = await findByRole('link', { name: /^Assistant/ });
    name.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/agents');
    name.click();
    expect(router.pathname).toBe('/agents/assistant');

    landAt('/agents');
    const action = await findByRole('link', { name: 'New chat with Assistant' });
    action.click();
    expect(router.current.search.get('agent')).toBe('assistant');
    expect(router.pathname).toBe('/chats/new');
  });

  test('opens an agent file’s editor, its memory, and the new agent form', async () => {
    const file = { ...AGENT, name: 'researcher', displayName: 'Researcher', kind: 'file' } as const;
    restore = bureau({ 'bureau.agents.list': () => ({ agents: [file] }) }).restore;
    landAt('/agents');
    const { findByRole } = mount(AgentList);

    const editLink = await findByRole('link', { name: 'Edit Researcher' });
    editLink.click();
    expect(router.pathname).toBe('/agents/researcher/edit');

    landAt('/agents');
    const memoryLink = await findByRole('link', { name: 'Memory of Researcher' });
    memoryLink.click();
    expect(router.pathname).toBe('/agents/researcher/memories');

    landAt('/agents');
    const newLink = await findByRole('link', { name: 'New agent' });
    newLink.click();
    expect(router.pathname).toBe('/agents/new');
  });
});

const INVALID_LISTING = {
  id: 'broken',
  source: 'file',
  state: 'invalid',
  name: 'broken',
  description: null,
  a2a: false,
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
    ? Response.json(
        stubHostPaths('/home/tester/.interborough/agents', '/home/tester/.interborough/workflows'),
      )
    : undefined;

describe('the list of agents, and the agent editor', () => {
  test('offers New agent, which opens the form for a new agent', async () => {
    restore = bureau({ 'bureau.agents.list': () => ({ agents: [FILE_AGENT] }) }).restore;
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
    const { container, findByText, getByRole, getByLabelText } = mount(AgentList);

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
    expect(container.querySelector('[data-agent="researcher"]')?.getAttribute('data-state')).toBe(
      'available',
    );
    // The search narrows the files with a problem as it narrows the agents.
    const search = getByLabelText('Search agents');
    await fireEvent.input(search, { target: { value: 'brok' } });
    await waitFor(() =>
      expect(container.querySelector('[data-agent="researcher"]') === null).toBe(true),
    );
    expect(container.querySelector('[data-agent="broken"]')).not.toBeNull();
    await fireEvent.input(search, { target: { value: '' } });
    await waitFor(() =>
      expect(container.querySelector('[data-agent="researcher"]')).not.toBeNull(),
    );
    getByRole('link', { name: 'broken' }).click();
    expect(router.pathname).toBe('/agents/broken/edit');
  });

  test('shows an invalid agent’s location as a remote host gave it, with no introduction', async () => {
    const served = bureau(
      {
        'bureau.agents.list': () => ({ agents: [AGENT, FILE_AGENT] }),
        'bureau.agents.definitions.list': () => ({
          agents: [{ ...READY_LISTING }, INVALID_LISTING],
          nextOffset: null,
        }),
      },
      (url) => (url.endsWith('/host/paths') ? Response.json(stubRemoteHostPaths()) : undefined),
    );
    restore = served.restore;
    landAt('/agents');
    const { container, findByText } = mount(AgentList);

    await findByText(AGENT_EDITOR_COPY.invalidBadge);
    const path = container.querySelector('[data-agent="broken"] [data-testid="agent-file-path"]');
    expect(path?.textContent).toBe(`${STUB_REMOTE_AGENT_DIRECTORY}broken.md`);
    expect(path?.textContent).toMatch(/^s3:\/\//);
    expect(container.textContent).not.toContain(AGENT_EDITOR_COPY.remote.fileLabel);
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
        a2a: true,
        hash: definition === null ? null : 'hash-1',
        problem: null,
        definition:
          definition === null
            ? null
            : { name: agent['displayName'], description: null, a2a: true, ...definition },
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
      card: [{ id: 'cite', name: 'Cite', description: 'Cites sources', tags: [] }],
      instructions: 'Be careful.',
    });
    landAt('/agents/researcher');

    const { container, findByText } = mount(AgentDetail);

    await findByText('anthropic/sonnet');
    expect(container.textContent).toContain('lookup-order');
    expect(container.textContent).toContain('Cite');
    // The version of the file, by its short hash, with the history that lives in its Settings tab.
    const version = container.querySelector('[data-testid="agent-file-version"]');
    expect(version?.textContent).toContain('File version');
    expect(version?.querySelector('code')?.textContent).toBe('hash-1');
    expect(version?.querySelector('a')?.getAttribute('href')).toBe(
      '/agents/researcher?tab=settings',
    );
    // Opening the history is a navigation in the app, not a page load.
    const history = version?.querySelector('a');
    if (history === null || history === undefined) throw new Error('expected a history link');
    history.click();
    expect(router.pathname).toBe('/agents/researcher');
    expect(router.search.get('tab')).toBe('settings');
    expect(container.textContent).not.toContain('Revision');
    expect(container.querySelector('h1')?.textContent?.trim()).toBe('Researcher');
    await findByText('Plan the week');
    expect(
      served.calls.find((call) => call.method === 'bureau.contexts.list')?.params,
    ).toMatchObject({ agentName: 'researcher', sortBy: 'updatedAt', sortOrder: 'desc' });
  });

  test('shows two skills that share a name, which only their identifiers tell apart', async () => {
    const twin = (id: string) => ({ id, name: 'Cite', description: 'Cites sources', tags: [] });
    serve(FILE_AGENT, {
      model: 'anthropic/sonnet',
      tools: [],
      card: [twin('cite-a'), twin('cite-b')],
      instructions: '',
    });
    landAt('/agents/researcher');

    const { container, findByText } = mount(AgentDetail);

    await findByText('anthropic/sonnet');
    expect(container.textContent).not.toContain('Something went wrong');
    expect(container.querySelectorAll('ul[aria-label="Skills"] li')).toHaveLength(2);
  });

  test('shows a tool its listing names twice once for each time, rather than failing on a repeated key', async () => {
    serve({ ...AGENT, tools: ['search-web', 'search-web'] });
    landAt('/agents/assistant');

    const { container, findByText } = mount(AgentDetail);

    await findByText('Answers every message.');
    expect(container.textContent).not.toContain('Something went wrong');
    expect(container.querySelectorAll('ul[aria-label="Tools"] li')).toHaveLength(2);
  });

  test('shows a file agent’s tool its definition names twice, beside two skills of one name', async () => {
    const twin = (id: string) => ({ id, name: 'Cite', description: 'Cites sources', tags: [] });
    serve(FILE_AGENT, {
      model: 'anthropic/sonnet',
      tools: ['lookup-order', 'lookup-order'],
      card: [twin('cite-a'), twin('cite-b')],
      instructions: '',
    });
    landAt('/agents/researcher');

    const { container, findByText } = mount(AgentDetail);

    await findByText('anthropic/sonnet');
    expect(container.textContent).not.toContain('Something went wrong');
    expect(container.querySelectorAll('ul[aria-label="Tools"] li')).toHaveLength(2);
    expect(container.querySelectorAll('ul[aria-label="Skills"] li')).toHaveLength(2);
  });

  test('says a code agent whose listing names an empty list has no tools', async () => {
    serve({ ...AGENT, tools: [] });
    landAt('/agents/assistant');

    const { container, findByText } = mount(AgentDetail);

    await findByText('No tools');
    expect(container.querySelector('[data-testid="agent-facts"]')?.textContent).toContain(
      'No tools',
    );
  });

  test('claims nothing about the tools of an agent whose listing is silent', async () => {
    serve(AGENT);
    landAt('/agents/assistant');

    const { container, findByText } = mount(AgentDetail);

    await findByText('Answers every message.');
    expect(container.textContent).not.toContain('tools');
    expect(container.textContent).not.toContain('Tools');
  });

  test('says a file agent that names no tools has none, and has no skills section', async () => {
    serve(FILE_AGENT, {
      model: 'anthropic/sonnet',
      tools: [],
      card: [],
      instructions: '',
    });
    landAt('/agents/researcher');

    const { container, findByText } = mount(AgentDetail);

    await findByText('anthropic/sonnet');
    expect(container.querySelector('[data-testid="agent-facts"]')?.textContent).toContain(
      'No tools',
    );
    expect(container.textContent).not.toContain('Skills');
  });

  test('reads no definition for an agent defined in code, shows no model for it, with no version, and offers New chat', async () => {
    const served = serve(ASSISTANT);
    landAt('/agents/assistant');

    const { container, findByRole } = mount(AgentDetail);

    const action = await findByRole('link', { name: 'New chat' });
    const shown = container.textContent ?? '';
    // Its tools come from its listing, named as a file agent's are.
    for (const present of ['Assistant', 'Answers every message.', 'search-web', 'send-mail']) {
      expect(shown).toContain(present);
    }
    // Where it is defined is not worded, and it has no file version.
    for (const absent of [
      'Defined in',
      'Revision',
      'File version',
      'Skills',
      'Model',
      'Scripted',
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

  test('puts the memory count on a Memory tab, and choosing the tab opens the memory page', async () => {
    serve(AGENT);
    landAt('/agents/assistant');
    const { findByRole, getByRole } = mount(AgentDetail);

    const tab = await findByRole('tab', { name: 'Memory 1' });
    // Memory is a tab among the page's others, not an action in its header.
    expect(getByRole('tablist').contains(tab)).toBe(true);
    expect(getByRole('tab', { name: 'Chats' }).getAttribute('aria-selected')).toBe('true');
    await fireEvent.click(tab);
    expect(router.pathname).toBe('/agents/assistant/memories');
  });

  test('counts a memory once when a list that shifted gave it on two pages', async () => {
    const memory = (id: string) => ({ ...MEMORY, id });
    memoryList = (params) =>
      params['offset'] === 0
        ? { memories: [memory('a'), memory('b')], nextOffset: 2 }
        : { memories: [memory('b'), memory('c')], nextOffset: null };
    serve(AGENT);
    landAt('/agents/assistant');
    // The memory page has read both pages, and the agent page reads the same cache.
    const client = createQueryClient();
    client.setQueryData(queryKeys.memory.list('assistant'), {
      pages: [
        { memories: [memory('a'), memory('b')], nextOffset: 2 },
        { memories: [memory('b'), memory('c')], nextOffset: null },
      ],
      pageParams: [0, 2],
    });

    const { findByRole } = render(QueryPage, { props: { page: AgentDetail, client } } as never);

    await findByRole('tab', { name: 'Memory 3' });
  });

  test('marks a memory count that has more pages unread, and says just Memory for an agent that remembers nothing', async () => {
    memoryList = () => ({ memories: [MEMORY], nextOffset: 1 });
    serve(AGENT);
    landAt('/agents/assistant');
    const more = mount(AgentDetail);
    await more.findByRole('tab', { name: 'Memory 1+' });
    more.unmount();
    restore?.();

    memoryList = () => ({ memories: [], nextOffset: null });
    serve(AGENT);
    landAt('/agents/assistant');
    const none = mount(AgentDetail);
    await none.findByRole('link', { name: 'New chat' });
    expect(none.getByRole('tab', { name: 'Memory' })).toBeTruthy();
  });

  test('keeps the Memory tab and drops the count when the Bureau cannot read the memory', async () => {
    memoryList = () => {
      throw new StubFault('Forbidden', 403, 'Memory is locked.');
    };
    serve(AGENT);
    landAt('/agents/assistant');
    const client = createQueryClient();
    const { findByRole, getByRole } = render(QueryPage, {
      props: { page: AgentDetail, client },
    } as never);

    await findByRole('link', { name: 'New chat' });
    // The read has failed before anything is asserted about what it left out.
    await waitFor(() =>
      expect(client.getQueryState(queryKeys.memory.list('assistant'))?.status).toBe('error'),
    );
    await fireEvent.click(getByRole('tab', { name: 'Memory' }));
    expect(router.pathname).toBe('/agents/assistant/memories');
  });

  test('moving focus along the tabs does not open the memory page; choosing the Memory tab does', async () => {
    serve(AGENT);
    landAt('/agents/assistant');
    const { findByRole, getByRole } = mount(AgentDetail);

    const hooks = await findByRole('tab', { name: 'Hooks' });
    hooks.focus();
    await fireEvent.keyDown(hooks, { key: 'ArrowRight' });
    // Focus reached Memory, and the page stayed: Settings is still one more arrow away.
    expect(document.activeElement).toBe(getByRole('tab', { name: /^Memory/ }));
    expect(router.pathname).toBe('/agents/assistant');
    await fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(getByRole('tab', { name: 'Settings' }));
    expect(router.pathname).toBe('/agents/assistant');

    getByRole('tab', { name: /^Memory/ }).focus();
    await fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    expect(router.pathname).toBe('/agents/assistant/memories');
  });

  test('offers Edit for an agent that is a file, and not for one defined in code', async () => {
    serve(FILE_AGENT, {
      model: 'anthropic/sonnet',
      tools: [],
      card: [],
      instructions: '',
    });
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

  test('offers New chat for an agent that opts into A2A, with no badge', async () => {
    serve(INTERNAL);
    landAt('/agents/internal');

    const { container, findByRole } = mount(AgentDetail);

    await findByRole('link', { name: 'New chat' });
    expect(container.textContent).not.toContain('Model');
    expect(container.textContent).not.toContain('A2A');
  });

  test('opens a session from its list', async () => {
    serve(AGENT);
    landAt('/agents/assistant');
    const { findByRole } = mount(AgentDetail);

    const row = await findByRole('button', { name: /Plan the week/ });
    row.click();

    await waitFor(() => expect(router.pathname).toBe('/chats/session-1'));
  });
});
