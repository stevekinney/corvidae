import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
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
  test('shows each agent’s kind and publish state, with New chat only for a published one', async () => {
    const served = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT, FILE_AGENT, INTERNAL] }),
    });
    restore = served.restore;
    landAt('/agents');

    const { container, findByText } = mount(AgentList);

    await findByText('Researcher');
    const rows = (name: string) => container.querySelector(`[data-agent="${name}"]`);
    expect(rows('assistant')?.textContent).toContain('Defined in code');
    expect(rows('researcher')?.textContent).toContain('Defined in a file');
    expect(rows('assistant')?.querySelector('a[href="/chat/new?agent=assistant"]')).not.toBeNull();
    expect(rows('internal')?.textContent).toContain('Not published');
    expect(rows('internal')?.textContent).not.toContain('New chat');
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
    });
    restore = served.restore;
    return served;
  }

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

  test('shows a file agent’s model, tools and skills from its definition, and its chats', async () => {
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
    expect(container.textContent).toContain('Revision');
    await findByText('Plan the week');
    expect(
      served.calls.find((call) => call.method === 'bureau.contexts.list')?.params,
    ).toMatchObject({ agentName: 'researcher' });
  });

  test('says none for a file agent that names no tools or skills', async () => {
    serve(FILE_AGENT, { model: 'anthropic/sonnet', tools: [], skills: [], instructions: '' });
    landAt('/agents/researcher');

    const { container, findByText } = mount(AgentDetail);

    await findByText('anthropic/sonnet');
    expect(container.textContent?.match(/None/g)).toHaveLength(2);
  });

  test('reads no definition for an agent defined in code, and offers New chat when it is published', async () => {
    const served = serve(AGENT);
    landAt('/agents/assistant');

    const { container, findByRole } = mount(AgentDetail);

    const action = await findByRole('link', { name: 'New chat' });
    // What the agent list carries is shown, and no model, tools or skills section is: an agent
    // defined in code has no file to read them from, and a blank section would say none.
    const shown = container.textContent ?? '';
    for (const present of ['Assistant', 'Answers every message.', 'Defined in code', 'Revision']) {
      expect(shown).toContain(present);
    }
    expect(shown).toContain('Published');
    for (const absent of ['Model', 'Tools', 'Skills', 'None']) expect(shown).not.toContain(absent);
    action.click();
    expect(router.current.search.get('agent')).toBe('assistant');
    expect(served.calls.some((call) => call.method === 'bureau.agents.definitions.get')).toBe(
      false,
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
