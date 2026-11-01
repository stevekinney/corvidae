/**
 * A plugin's agent (`plugin:name`) is read-only, so its row in the agents list offers Duplicate in
 * place of Edit (COR-1892): Edit would open an editor whose save the server refuses with
 * `agent-file-read-only`. Duplicate is the same call and the same words as the agent's own page.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentList from './agent-list.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const PLUGIN_AGENT = {
  ...AGENT,
  name: 'linear:triager',
  displayName: 'Triager',
  kind: 'file',
  description: 'Triages issues.',
};
const OWN_AGENT = { ...AGENT, name: 'mine', displayName: 'Mine', kind: 'file' };
const copy = AGENT_PAGE_COPY.plugin;

type Answers = Parameters<typeof bureau>[0];

function serve(extra: Answers = {}) {
  const served = bureau({
    'bureau.agents.list': () => ({ agents: [PLUGIN_AGENT, OWN_AGENT] }),
    'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    ...extra,
  });
  restore = served.restore;
  return served;
}

const mount = () => render(QueryPage, { props: { page: AgentList } } as never);

describe('the agents list, for a plugin’s agent', () => {
  test('shows Duplicate and no Edit on a plugin agent’s row, and Edit on the owner’s', async () => {
    landAt('/agents');
    serve();
    const { container } = mount();

    await waitFor(() => expect(container.querySelector('[data-agent="mine"]')).not.toBeNull());
    const plugin = container.querySelector('[data-agent="linear:triager"]') as HTMLElement;
    const own = container.querySelector('[data-agent="mine"]') as HTMLElement;
    expect(plugin.textContent).toContain(copy.duplicate);
    expect(plugin.textContent).not.toContain(AGENT_EDITOR_COPY.editAction);
    expect(own.textContent).toContain(AGENT_EDITOR_COPY.editAction);
    expect(own.textContent).not.toContain(copy.duplicate);
  });

  test('copies the agent and opens the copy', async () => {
    landAt('/agents');
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

  test('says the owner already has an agent of that name, and stays on the list', async () => {
    landAt('/agents');
    serve({
      'bureau.agents.definitions.duplicate': () => {
        throw new StubFault('Conflict', 409, 'exists', { reason: 'agent-file-exists' });
      },
    });
    const { findByRole, findByText } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.duplicate }));

    await findByText(copy.exists('triager'));
    expect(router.pathname).toBe('/agents');
  });
});
