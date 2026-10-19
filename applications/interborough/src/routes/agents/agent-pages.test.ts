import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

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

describe('one agent’s page', () => {
  function serve(agent: Record<string, unknown>, definition: Record<string, unknown> | null = null) {
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
      'bureau.contexts.list': () => ({
        contexts: [{ ...CONTEXT, agentName: agent['name'] }],
        nextOffset: null,
      }),
    });
    restore = served.restore;
    return served;
  }

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
