/**
 * Duplicate on an agent's page. A built-in agent and a file agent offer it as a link to the form
 * for a new agent filled from them (`/agents/new?from=`), which writes nothing; a plugin's agent
 * keeps its own Duplicate, which writes the copy (`plugin-agent-page.test.ts`).
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY } from '../../app/copy.ts';
import { readyAgent } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, CONTEXT, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentDetail from './agent-detail.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: AgentDetail } } as never);

function serve(summary: typeof AGENT) {
  const served = bureau({
    'bureau.agents.list': () => ({ agents: [summary] }),
    'bureau.agents.definitions.get': () => readyAgent({ id: summary.name }),
    'bureau.contexts.list': () => ({
      contexts: [{ ...CONTEXT, agentName: summary.name }],
      nextOffset: null,
    }),
    'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
  });
  restore = served.restore;
  return served;
}

describe('Duplicate on an agent’s page', () => {
  test('is offered on a built-in agent, which has no Edit, and opens the form to copy it', async () => {
    landAt('/agents/assistant');
    const served = serve(AGENT);
    const { findByRole, queryByRole } = mount();

    const duplicate = await findByRole('link', { name: AGENT_PAGE_COPY.duplicate });
    expect(duplicate.getAttribute('href')).toBe('/agents/new?from=assistant');
    expect(queryByRole('link', { name: AGENT_EDITOR_COPY.editAction })).toBeNull();

    await fireEvent.click(duplicate);
    await waitFor(() => expect(router.pathname).toBe('/agents/new'));
    expect(router.search.get('from')).toBe('assistant');
    // Following it writes nothing: the copy is created from the form.
    expect(served.calls.some((call) => call.method.includes('duplicate'))).toBe(false);
    expect(served.calls.some((call) => call.method.includes('create'))).toBe(false);
  });

  test('is offered beside Edit on a file agent', async () => {
    landAt('/agents/researcher');
    serve({ ...AGENT, name: 'researcher', displayName: 'Researcher', kind: 'file' });
    const { findByRole } = mount();

    await findByRole('link', { name: AGENT_EDITOR_COPY.editAction });
    const duplicate = await findByRole('link', { name: AGENT_PAGE_COPY.duplicate });
    expect(duplicate.getAttribute('href')).toBe('/agents/new?from=researcher');
  });
});
