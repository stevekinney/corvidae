/**
 * A plugin's agent (`plugin:name`, COR-1873) is read-only: the Bureau lists it as a file, so the
 * page must not offer the file actions. Its page shows Duplicate, which writes an editable copy into
 * the owner's agents, and no Edit, Delete or saved versions.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY } from '../../app/copy.ts';
import { readyAgent, StubFault } from '../../lib/bureau-stub.test-support.ts';
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

const PLUGIN_AGENT = {
  ...AGENT,
  name: 'linear:triager',
  displayName: 'Triager',
  kind: 'file',
  description: 'Triages issues.',
};
const copy = AGENT_PAGE_COPY.plugin;

type Answers = Parameters<typeof bureau>[0];

function serve(extra: Answers = {}) {
  const served = bureau({
    'bureau.agents.list': () => ({ agents: [PLUGIN_AGENT] }),
    'bureau.agents.definitions.get': () =>
      readyAgent({ id: 'linear:triager', name: 'Triager', hash: 'hash-1' }),
    'bureau.contexts.list': () => ({
      contexts: [{ ...CONTEXT, agentName: 'linear:triager' }],
      nextOffset: null,
    }),
    'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
    'bureau.agents.versions.list': () => ({ versions: [] }),
    'bureau.agents.catalog': () => ({ models: [], tools: [] }),
    ...extra,
  });
  restore = served.restore;
  return served;
}

describe('the page of a plugin’s agent', () => {
  test('shows Duplicate and no Edit', async () => {
    landAt('/agents/linear%3Atriager');
    serve();
    const { findByRole, queryByRole } = mount();

    await findByRole('button', { name: copy.duplicate });
    expect(queryByRole('link', { name: AGENT_EDITOR_COPY.editAction })).toBeNull();
    expect(queryByRole('link', { name: 'New chat' })).not.toBeNull();
  });

  test('copies the agent into the owner’s agents and opens the copy', async () => {
    landAt('/agents/linear%3Atriager');
    const served = serve({
      'bureau.agents.definitions.duplicate': () => ({ id: 'triager', hash: 'hash-2' }),
    });
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));

    await waitFor(() => expect(router.pathname).toBe('/agents/triager'));
    expect(
      served.calls.find((call) => call.method === 'bureau.agents.definitions.duplicate')?.params,
    ).toEqual({ id: 'linear:triager' });
  });

  test('says the owner already has an agent of that name, and stays on the page', async () => {
    landAt('/agents/linear%3Atriager');
    serve({
      'bureau.agents.definitions.duplicate': () => {
        throw new StubFault('Conflict', 409, 'exists', { reason: 'agent-file-exists' });
      },
    });
    const { findByRole, findByText } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));

    await findByText(copy.exists('triager'));
    expect(router.pathname).toBe('/agents/linear%3Atriager');
  });

  test('offers no Edit on the Instructions tab, and says the plugin ships the agent', async () => {
    landAt('/agents/linear%3Atriager?tab=instructions');
    serve();
    const { findByTestId, queryByRole } = mount();

    const body = await findByTestId('agent-instructions-body');
    expect(body.textContent).toContain('careful researcher');
    expect(queryByRole('link', { name: AGENT_EDITOR_COPY.editAction })).toBeNull();
    const note = await findByTestId('agent-plugin-note');
    expect(note.textContent).toBe(copy.note('linear'));
  });

  test('offers no Delete and no saved versions on the Settings tab', async () => {
    landAt('/agents/linear%3Atriager?tab=settings');
    serve();
    const { container, findByTestId, queryByRole } = mount();

    await findByTestId('agent-settings');
    await findByTestId('agent-plugin-note');
    expect(queryByRole('button', { name: AGENT_PAGE_COPY.settings.deleteAction })).toBeNull();
    expect(container.querySelector('[data-testid="agent-versions"]')).toBeNull();
  });

  test('offers no access editor on the Access tab', async () => {
    landAt('/agents/linear%3Atriager?tab=access');
    serve();
    const { findByTestId, queryByRole } = mount();

    await findByTestId('agent-plugin-note');
    expect(queryByRole('button', { name: AGENT_PAGE_COPY.access.saveAction })).toBeNull();
  });
});
