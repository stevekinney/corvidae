/**
 * A new chat without `?agent=` starts with the first listed agent that can run, and says nothing
 * of an agent until the Bureau has answered: the pane stays on its loading status while there is
 * none, rather than naming an agent that is not there.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import Chats from './chats.svelte';
import { AGENT, bureau, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: Chats } } as never);

const BROKEN = { ...AGENT, name: 'broken', displayName: 'Broken' };

/** A plugin that contributes `agent` and is in `status`, as the host reports its plugins. */
function pluginWithAgent(agent: string, status: string) {
  return {
    descriptor: {
      name: `${agent}-plugin`,
      version: '1.0.0',
      description: '',
      required: false,
      enabledByDefault: false,
      secrets: [],
    },
    source: 'folder',
    location: `/plugins/${agent}-plugin`,
    status,
    problems: [],
    contributions: [
      { kind: 'code-agent', id: agent, references: { agents: 0, schedules: 0, waitingRuns: 0 } },
    ],
    enabled: true,
    configuration: {},
    secrets: [],
    restartRequired: false,
  };
}

/** Serves the Bureau's lists for a new chat, with `agents` listed and `plugins` reported. */
function serve(agents: readonly unknown[], plugins: readonly unknown[]): void {
  restore = bureau(
    {
      'bureau.agents.list': () => ({ agents }),
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
      'bureau.reviews.list': () => ({ reviews: [] }),
    },
    (url) => (url.endsWith('/host/plugins') ? Response.json({ plugins, unloaded: [] }) : undefined),
  ).restore;
}

describe('a new chat with no agent named', () => {
  test('starts with the first listed agent whose plugin is running, skipping one that needs setup', async () => {
    serve([BROKEN, AGENT], [pluginWithAgent('broken', 'needs-setup')]);
    landAt('/chats/new');

    const { findByRole } = mount();

    const agent = await findByRole('combobox', { name: 'Agent' });
    await waitFor(() => expect((agent as HTMLInputElement).value).toMatch(/assistant/i));
    expect((agent as HTMLInputElement).value).not.toMatch(/broken/i);
  });

  test('stays on the loading status, with no conversation, when no listed agent can run', async () => {
    serve([BROKEN], [pluginWithAgent('broken', 'needs-setup')]);
    landAt('/chats/new');

    const { container, findAllByRole } = mount();

    // The pane has no agent to start the conversation with, so it never offers the composer.
    const statuses = await findAllByRole('status');
    expect(
      statuses.some((status) => status.getAttribute('aria-label') === 'Loading the conversation'),
    ).toBe(true);
    // load-proof: the only thing that could start the conversation is a default agent, and the
    // answer is already in once the status shows; a wait cannot flip it.
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });
});
