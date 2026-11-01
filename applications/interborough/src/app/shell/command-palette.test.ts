/** Choosing a result in the ⌘K palette opens that record, not the collection it belongs to. */
import { HttpClient } from '@lostgradient/weft';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { ShortcutRegistry } from '../../lib/shortcuts.ts';
import { PALETTE_COPY } from '../copy.ts';
import type { NotificationEntry } from '../notification-items.ts';
import { memoryStore } from '../notification-store.test-support.ts';
import { schedulePath, toolPath, workerPath } from './command-palette-search.ts';
import CommandPaletteLauncher from './command-palette.svelte';
import { registerShellShortcuts } from './destinations.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

function stubEngine(): void {
  restore = installFetchImplementation(async (input, init) => {
    const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(text, 'http://localhost');
    if (typeof init?.body === 'string') {
      const call = JSON.parse(init.body) as { id?: unknown; method?: string };
      if (call.method === 'bureau.contexts.list') {
        return Response.json({
          jsonrpc: '2.0',
          id: call.id,
          result: {
            nextOffset: null,
            contexts: [
              {
                id: 'echo-chat',
                owner: null,
                agentName: 'echo',
                title: 'Hello echo, say this back',
                lastMessagePreview: 'Hello echo, say this back',
                parentContextId: null,
                forkedFromMessageId: null,
                messageCount: 2,
                createdAt: '2026-10-23T14:00:00.000Z',
                updatedAt: '2026-10-23T14:00:00.000Z',
                activity: 'idle',
              },
            ],
          },
        });
      }
      if (call.method === 'bureau.agents.catalog') {
        return Response.json({
          jsonrpc: '2.0',
          id: call.id,
          result: {
            models: [],
            tools: [
              {
                name: 'issue-refund',
                description: 'Refunds an order to the card it was paid with.',
                shortDescription: 'Refunds an order',
                inputSchema: null,
                tier: 'mutating',
                defaultApproval: 'ask',
                source: 'host',
                plugin: null,
                users: [],
              },
            ],
          },
        });
      }
      if (call.method === 'weft.workflows.definitions.list') {
        return Response.json({
          jsonrpc: '2.0',
          id: call.id,
          result: {
            definitions: [
              {
                name: 'refund-flow',
                description: 'Refunds a batch',
                origin: 'code',
                state: 'active',
              },
            ],
          },
        });
      }
      if (call.method === 'bureau.workflows.list') {
        return Response.json({
          jsonrpc: '2.0',
          id: call.id,
          result: { workflows: [], nextOffset: null },
        });
      }
      if (call.method === 'bureau.agents.list') {
        return Response.json({
          jsonrpc: '2.0',
          id: call.id,
          result: {
            agents: [
              {
                name: 'echo',
                displayName: 'echo',
                description: 'Repeats the last message it was sent.',
                definitionRevision: 1,
                kind: 'code',
                a2a: false,
                media: null,
              },
            ],
          },
        });
      }
      const items =
        call.method === 'weft.workers.list' ? [{ id: 'worker-7', queue: 'default' }] : [];
      return Response.json({ jsonrpc: '2.0', id: call.id, result: { items } });
    }
    if (url.pathname.endsWith('/schedules')) {
      return Response.json({
        items: [{ id: 'schedule-7', workflowType: 'order' }],
        total: 1,
      });
    }
    if (url.pathname.endsWith('/reviews')) {
      return Response.json({ items: [{ reviewId: 'review-7', reviewType: 'approval' }] });
    }
    if (url.pathname.endsWith('/workflows')) {
      return Response.json({ items: [{ id: 'run-7', type: 'order' }], total: 1 });
    }
    return Response.json({});
  });
}

/** The shell's shortcuts in a registry of their own, with the keys that open things recorded. */
function shellRegistry(): { registry: ShortcutRegistry; opened: string[]; maps: number[] } {
  const registry = new ShortcutRegistry();
  const opened: string[] = [];
  const maps: number[] = [];
  registerShellShortcuts(registry, {
    navigate: (path) => opened.push(path),
    openShortcutMap: () => maps.push(1),
    openPalette: () => {},
  });
  return { registry, opened, maps };
}

const WAITING: NotificationEntry = {
  id: 'review:one',
  kind: 'approval',
  tier: 'warning',
  icon: 'shield-question-mark',
  title: 'tool-runner needs your approval',
  identifiers: ['tool-runner'],
  detail: 'Refund order 1234',
  joiner: ' in ',
  sessionId: 'session-refund',
  href: '/chats/session-refund',
  emittedAtMs: Date.now() - 120_000,
};

async function choose(query: string, resultName: RegExp, registry?: ShortcutRegistry) {
  stubEngine();
  landAt('/chats');
  const view = render(CommandPaletteLauncher, {
    props: {
      open: true,
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      ...(registry === undefined ? {} : { registry }),
    },
  });
  await fireEvent.input(await view.findByRole('combobox'), { target: { value: query } });
  const result = await view.findByRole('option', { name: resultName });
  await fireEvent.click(result);
}

describe('the command palette', () => {
  test('opens the selected run', async () => {
    await choose('run-7', /run-7/);
    await waitFor(() => expect(router.pathname).toBe('/runs/run-7'));
  });

  test('opens the selected schedule, not the list of schedules', async () => {
    await choose('schedule-7', /schedule-7/);
    await waitFor(() => expect(router.pathname).toBe(schedulePath('schedule-7')));
  });

  test('opens the selected worker, not the list of workers', async () => {
    await choose('worker-7', /worker-7/);
    await waitFor(() =>
      expect(router.pathname + '?' + router.search.toString()).toBe(workerPath('worker-7')),
    );
  });

  test('opens the reviews page for a review, which has no page of its own', async () => {
    await choose('review-7', /review-7/);
    await waitFor(() => expect(router.pathname).toBe('/reviews'));
  });
});

describe('the chats, agents, and commands', () => {
  test('lists the chat, then the agent, then the command, and nothing else, for a few letters', async () => {
    stubEngine();
    landAt('/chats');
    const view = render(CommandPaletteLauncher, {
      props: { open: true, client: new HttpClient({ baseUrl: 'http://localhost/api' }) },
    });
    expect(view.getByPlaceholderText(PALETTE_COPY.placeholder)).not.toBeNull();
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'ech' } });

    await waitFor(() => expect(view.getAllByRole('option')).toHaveLength(3));
    expect(view.getAllByRole('option').map((option) => option.getAttribute('aria-label'))).toEqual([
      'Hello echo, say this back, echo',
      'echo, Repeats the last message it was sent.',
      'New chat with echo',
    ]);
    expect(view.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
      'Chats',
      'Agents',
      'Actions',
    ]);
  });

  test('opens the chat the title names', async () => {
    await choose('ech', /^Hello echo, say this back/);
    await waitFor(() => expect(router.pathname).toBe('/chats/echo-chat'));
  });

  test('opens the agent’s page', async () => {
    await choose('ech', /^echo, Repeats/);
    await waitFor(() => expect(router.pathname).toBe('/agents/echo'));
  });

  test('New chat with echo opens a new chat with that agent', async () => {
    await choose('ech', /^New chat with echo$/);
    await waitFor(() =>
      expect(router.pathname + '?' + router.search.toString()).toBe('/chats/new?agent=echo'),
    );
  });

  test('Go to Reviews, an action of the registry, opens the reviews page', async () => {
    const { registry, opened } = shellRegistry();
    await choose('go to rev', /^Go to Reviews/, registry);
    await waitFor(() => expect(opened).toEqual(['/reviews']));
  });
});

describe('choosing with the keyboard', () => {
  test('Enter opens the first result, the chat', async () => {
    stubEngine();
    landAt('/chats');
    const view = render(CommandPaletteLauncher, {
      props: { open: true, client: new HttpClient({ baseUrl: 'http://localhost/api' }) },
    });
    const input = await view.findByRole('combobox');
    await fireEvent.input(input, { target: { value: 'ech' } });
    await waitFor(() => expect(view.getAllByRole('option')).toHaveLength(3));
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(router.pathname).toBe('/chats/echo-chat'));
  });
});

describe('the empty states', () => {
  test('says what to type when there is nothing to list before anything is typed, and when nothing matches', async () => {
    stubEngine();
    landAt('/chats');
    const view = render(CommandPaletteLauncher, {
      props: { open: true, client: new HttpClient({ baseUrl: 'http://localhost/api' }) },
    });
    expect(await view.findByText('Search the console')).not.toBeNull();
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'zzzqqq' } });
    expect(await view.findByText('No matches')).not.toBeNull();
  });
});

describe('the paths of a record', () => {
  test('encode the identifier', () => {
    expect(schedulePath('a b/c')).toBe('/schedules/a%20b%2Fc');
    expect(workerPath('a&b')).toBe('/health/workers?worker=a%26b');
  });
});

describe('every kind of result, in order', () => {
  function open(props: Record<string, unknown> = {}) {
    stubEngine();
    landAt('/chats');
    return render(CommandPaletteLauncher, {
      props: { open: true, client: new HttpClient({ baseUrl: 'http://localhost/api' }), ...props },
    });
  }

  const groups = (view: ReturnType<typeof open>) =>
    view.getAllByRole('group').map((group) => group.getAttribute('aria-label'));

  test('lists what is waiting on the person and the actions with their keys before anything is typed', async () => {
    const store = memoryStore();
    store.setActivity([WAITING]);
    const { registry } = shellRegistry();
    const view = open({ store, registry });

    await waitFor(() => expect(groups(view)).toEqual(['Waiting on you', 'Actions']));
    expect(
      view.getByRole('option', { name: 'tool-runner needs your approval in Refund order 1234' }),
    ).not.toBeNull();
    const search = view.getByRole('option', { name: 'Go to Reviews' });
    expect(search.getAttribute('aria-keyshortcuts')).toBe('G V');
  });

  test('a waiting item opens where it is waiting', async () => {
    const store = memoryStore();
    store.setActivity([WAITING]);
    const view = open({ store });

    await fireEvent.click(await view.findByRole('option', { name: /needs your approval/ }));

    await waitFor(() => expect(router.pathname).toBe('/chats/session-refund'));
  });

  test('reaches chats, workflows, runs, schedules, workers, reviews, agents, tools and actions, waiting first', async () => {
    const store = memoryStore();
    store.setActivity([WAITING]);
    const { registry } = shellRegistry();
    const view = open({ store, registry });
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'refund' } });

    await waitFor(() => expect(groups(view)).toContain('Tools'));
    // The refund workflow, the refund tool and the waiting refund each show once; a waiting item is first.
    expect(groups(view)).toEqual(['Waiting on you', 'Workflows', 'Tools']);
    await fireEvent.click(view.getByRole('option', { name: /^issue-refund/ }));
    await waitFor(() =>
      expect(router.pathname + '?' + router.search.toString()).toBe(toolPath('issue-refund')),
    );
  });

  test('a workflow type opens its page', async () => {
    const view = open();
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'refund-f' } });

    await fireEvent.click(await view.findByRole('option', { name: /^refund-flow/ }));

    await waitFor(() => expect(router.pathname).toBe('/workflows/refund-flow'));
  });

  test('> lists only the actions, and runs the one chosen', async () => {
    const { registry, opened, maps } = shellRegistry();
    const view = open({ registry });
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: '>keyboard' } });

    await waitFor(() => expect(groups(view)).toEqual(['Actions']));
    expect(view.getAllByRole('option')).toHaveLength(1);
    await fireEvent.click(view.getByRole('option', { name: 'Show keyboard shortcuts' }));
    expect(maps).toEqual([1]);
    expect(opened).toEqual([]);
  });

  test('> with nothing after it lists every action, and the chats each agent can be opened with', async () => {
    const { registry } = shellRegistry();
    const view = open({ registry });
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: '>' } });

    await waitFor(() =>
      expect(view.queryByRole('option', { name: 'New chat with echo' })).not.toBeNull(),
    );
    expect(groups(view)).toEqual(['Actions']);
    expect(view.getAllByRole('option').length).toBeGreaterThan(8);
  });

  test('@ lists only agents, all of them for a bare @', async () => {
    const view = open({ registry: shellRegistry().registry });
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: '@' } });

    await waitFor(() => expect(groups(view)).toEqual(['Agents']));
    expect(view.getAllByRole('option').map((option) => option.getAttribute('aria-label'))).toEqual([
      'echo, Repeats the last message it was sent.',
    ]);
    await fireEvent.click(view.getByRole('option', { name: /^echo/ }));
    await waitFor(() => expect(router.pathname).toBe('/agents/echo'));
  });

  test('a scope the principal lacks leaves its kinds out of the results', async () => {
    const locked = { disabled: true, title: 'Requires a scope' };
    const view = open({
      workflowReadGate: locked,
      reviewReadGate: locked,
      systemReadGate: locked,
      scheduleReadGate: locked,
    });
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'refund' } });

    await waitFor(() => expect(groups(view)).toEqual(['Tools']));
  });
});
