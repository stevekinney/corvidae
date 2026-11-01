/**
 * A new chat without `?agent=` starts with the first listed agent that can run, and says nothing
 * of an agent until the Bureau has answered: the pane stays on its loading status until then,
 * rather than naming an agent that is not there. With no agent able to run the route probe shows
 * the view's empty state (`app/view-frame.test.ts`) and this pane is never mounted.
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

  test('shows the loading status, with no conversation, until the default is known, then starts the chat', async () => {
    // The route probe has already asked in the app, and with no agent able to run it shows the
    // view's empty state instead of mounting this pane, so the pane waits only while the answer
    // is not in. The agent list is held here, its headers sent and its body not, until released.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'bureau.agents.list',
      result: { agents: [AGENT] },
    });
    restore = bureau(
      {
        'bureau.agents.list': () => ({ agents: [AGENT] }),
        'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
        'bureau.reviews.list': () => ({ reviews: [] }),
      },
      (_url, init) => {
        const request = typeof init?.body === 'string' ? init.body : '';
        if (held || !request.includes('bureau.agents.list')) return undefined;
        held = true;
        return new Response(
          new ReadableStream({
            async start(controller) {
              await released;
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    ).restore;
    landAt('/chats/new');

    const { container, findAllByRole, findByRole } = mount();

    const statuses = await findAllByRole('status');
    expect(
      statuses.some((status) => status.getAttribute('aria-label') === 'Loading the conversation'),
    ).toBe(true);
    expect(container.querySelector('textarea')).toBeNull();

    release();
    const agent = await findByRole('combobox', { name: 'Agent' });
    await waitFor(() => expect((agent as HTMLInputElement).value).toMatch(/assistant/i));
    expect(container.querySelector('textarea')).not.toBeNull();
  });
});
