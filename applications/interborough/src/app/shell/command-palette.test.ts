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

/** The engine as the palette searches it; a path that ends with `unreachable` does not answer. */
function stubEngine(unreachable?: string): void {
  restore = installFetchImplementation(async (input, init) => {
    const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(text, 'http://localhost');
    if (unreachable !== undefined && url.pathname.endsWith(unreachable)) {
      throw new Error('the host did not answer');
    }
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
              {
                id: 'refund-chat',
                owner: null,
                agentName: 'tool-runner',
                title: 'Please refund order 4471, it arrived damaged.',
                lastMessagePreview: 'I need your approval to refund it.',
                parentContextId: null,
                forkedFromMessageId: null,
                messageCount: 2,
                createdAt: '2026-10-23T14:00:00.000Z',
                updatedAt: '2026-10-23T14:01:00.000Z',
                activity: 'awaiting-input',
              },
            ],
          },
        });
      }
      if (call.method === 'bureau.tasks.list') {
        return Response.json({
          jsonrpc: '2.0',
          id: call.id,
          result: {
            tasks: [
              {
                id: 'task-refund',
                contextId: 'refund-chat',
                agentName: 'tool-runner',
                owner: 'me',
                actor: null,
                kind: 'chat',
                status: 'input-required',
                finishReason: null,
                statusMessage: null,
                createdAt: '2026-10-23T14:00:00.000Z',
                updatedAt: '2026-10-23T14:01:00.000Z',
                cleanup: null,
                openWaits: [{ kind: 'tool-approval', reviewId: 'review-1', callId: 'call-1' }],
              },
            ],
            nextPageToken: null,
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
                title: 'Issue refund',
                description: 'Refunds an order to the card it was paid with.',
                shortDescription: 'Refunds an order',
                inputSchema: null,
                tier: 'mutating',
                defaultApproval: 'ask',
                source: 'host',
                plugin: null,
                users: ['tool-runner'],
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
              {
                name: 'tool-runner',
                displayName: 'Tool runner',
                description: 'Looks an order up, then asks for approval to refund it.',
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
  detail: 'Refund order 1234',
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
    await choose('run-7', /^run-7/);
    await waitFor(() => expect(router.pathname).toBe('/runs/run-7'));
  });

  test('opens the selected schedule, not the list of schedules', async () => {
    // A schedule is named in words, not by its identifier (design row 03g); it is still found by it.
    await choose('schedule-7', /^Schedule for order/);
    await waitFor(() => expect(router.pathname).toBe(schedulePath('schedule-7')));
  });

  test('opens the selected worker, not the list of workers', async () => {
    await choose('worker-7', /^worker-7/);
    await waitFor(() =>
      expect(router.pathname + '?' + router.search.toString()).toBe(workerPath('worker-7')),
    );
  });

  test('opens the reviews page for a review, which has no page of its own', async () => {
    await choose('review-7', /^review-7/);
    await waitFor(() => expect(router.pathname).toBe('/reviews'));
  });
});

describe('the chats, agents, and commands', () => {
  test('lists the chat, then the agent, then the commands, and nothing else, for a few letters', async () => {
    stubEngine();
    landAt('/chats');
    const view = render(CommandPaletteLauncher, {
      props: { open: true, client: new HttpClient({ baseUrl: 'http://localhost/api' }) },
    });
    expect(view.getByPlaceholderText(PALETTE_COPY.placeholder)).not.toBeNull();
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'ech' } });

    await waitFor(() => expect(view.getAllByRole('option')).toHaveLength(4));
    expect(view.getAllByRole('option').map((option) => option.getAttribute('aria-label'))).toEqual([
      'Hello echo, say this back, Echo',
      'Echo, echo, agent',
      'New chat with echo',
      'New chat about ech',
    ]);
    expect(view.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
      'Chats',
      'Agents and tools',
      'Actions',
    ]);
  });

  test('opens the chat the title names', async () => {
    await choose('ech', /^Hello echo, say this back/);
    await waitFor(() => expect(router.pathname).toBe('/chats/echo-chat'));
  });

  test('opens the agent’s page', async () => {
    await choose('ech', /^Echo, echo, agent/);
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
    await waitFor(() => expect(view.getAllByRole('option')).toHaveLength(4));
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

describe('a search that failed', () => {
  test('says the search did not finish, not that nothing matched, when every domain failed', async () => {
    restore = installFetchImplementation(async () => {
      throw new Error('the host did not answer');
    });
    landAt('/chats');
    const view = render(CommandPaletteLauncher, {
      props: { open: true, client: new HttpClient({ baseUrl: 'http://localhost/api' }) },
    });

    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'zzzqqq' } });

    expect(await view.findByText(PALETTE_COPY.searchFailedTitle)).not.toBeNull();
    expect(view.queryByText(PALETTE_COPY.noMatchesTitle)).toBeNull();
  });

  test('says which results may be missing when one domain failed and the others found a match', async () => {
    stubEngine('/schedules');
    landAt('/chats');
    const view = render(CommandPaletteLauncher, {
      props: { open: true, client: new HttpClient({ baseUrl: 'http://localhost/api' }) },
    });

    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'echo' } });

    expect(await view.findByRole('option', { name: /Hello echo/ })).not.toBeNull();
    expect(await view.findByText(/Could not read schedules/)).not.toBeNull();
  });
});

describe('the paths of a record', () => {
  test('encode the identifier', () => {
    expect(schedulePath('a b/c')).toBe('/schedules/a%20b%2Fc');
    expect(workerPath('a&b')).toBe('/health/workers?worker=a%26b');
  });
});

/** A row's title and its meta: the two parts the design draws on one line, the second after a "·". */
function rowText(option: HTMLElement): [string, string] {
  const text = option.querySelector('.cinder-command-item__text');
  const meta = option.querySelector('.cinder-command-item__meta');
  return [
    (text?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    (meta?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  ];
}

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

  test('lists what is waiting on the person, then the Go to rows and New chat with their keys, before anything is typed', async () => {
    const store = memoryStore();
    store.setActivity([WAITING]);
    const { registry } = shellRegistry();
    const view = open({ store, registry });

    await waitFor(() => expect(groups(view)).toEqual(['Waiting on you', 'Actions']));
    expect(
      view.getByRole('option', { name: 'tool-runner needs your approval · Refund order 1234' }),
    ).not.toBeNull();
    // The Go to rows come first, then New chat, and the map of every shortcut is last (row 03c).
    const labels = view
      .getAllByRole('option')
      .map((option) => option.getAttribute('aria-label') ?? '');
    expect(labels.slice(1, 4)).toEqual(['Go to Home', 'Go to Chat', 'Go to Reviews']);
    expect(labels.indexOf('New chat')).toBeGreaterThan(labels.indexOf('Go to Settings'));
    expect(labels.at(-1)).toBe('Show keyboard shortcuts');
    // The keys read "G then R" and one key reads alone, as Cinder's keys prop draws them.
    const reviews = view.getByRole('option', { name: 'Go to Reviews' });
    expect(reviews.textContent?.replace(/\s+/g, ' ').trim()).toBe('Go to Reviews G then R');
    expect(
      view.getByRole('option', { name: 'New chat' }).textContent?.replace(/\s+/g, ' ').trim(),
    ).toBe('New chat C');
    // The actions carry no heading of their own while nothing is typed, only their group's name.
    expect(view.queryByText(PALETTE_COPY.groups.actions)).toBeNull();
  });

  test('the key hints are gone while single-key shortcuts are off, and the rows still run', async () => {
    const { registry, opened } = shellRegistry();
    registry.setSingleKeyShortcuts(false);
    const view = open({ registry });

    const reviews = await view.findByRole('option', { name: 'Go to Reviews' });
    expect(reviews.textContent?.replace(/\s+/g, ' ').trim()).toBe('Go to Reviews');
    await fireEvent.click(reviews);
    expect(opened).toEqual(['/reviews']);
  });

  test('the footer names the prefixes and the key that opens a row', async () => {
    const view = open();
    const footer = await view.findByText('Enter to open');
    expect(footer.parentElement?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '> actions @ agents Enter to open',
    );
  });

  test('a waiting item opens where it is waiting', async () => {
    const store = memoryStore();
    store.setActivity([WAITING]);
    const view = open({ store });

    await fireEvent.click(await view.findByRole('option', { name: /needs your approval/ }));

    await waitFor(() => expect(router.pathname).toBe('/chats/session-refund'));
  });

  test('groups a search for "refund" as waiting, chats, runs, agents and tools, workflows, then actions', async () => {
    const store = memoryStore();
    store.setActivity([WAITING]);
    const { registry } = shellRegistry();
    const view = open({ store, registry });
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'refund' } });

    await waitFor(() => expect(groups(view)).toContain('Agents and tools'));
    // The five groups of row 03g keep their order; the workflow type, which the board does not
    // draw, sits after them and before the actions, never between two of the board's groups.
    expect(groups(view)).toEqual([
      'Waiting on you',
      'Chats',
      'Runs',
      'Agents and tools',
      'Workflows',
      'Actions',
    ]);
    const label = (index: number) => view.getAllByRole('option')[index]?.getAttribute('aria-label');
    expect(label(0)).toBe('tool-runner needs your approval · Refund order 1234');
    expect(
      view.getByRole('option', {
        name: 'Please refund order 4471, it arrived damaged., Tool runner',
      }),
    ).not.toBeNull();
    // A run is titled after the chat that began it, and says what it waits for.
    const run = view.getByRole('option', {
      name: 'Refund order 4471, Tool runner, waiting for approval',
    });
    expect(rowText(run)).toEqual(['Refund order 4471', 'Tool runner · waiting for approval']);
    // A tool reads as its name for a person, the identifier small and monospaced, and who uses it.
    const tool = view.getByRole('option', {
      name: 'Issue refund, issue-refund, tool, Tool runner',
    });
    expect(rowText(tool)).toEqual(['Issue refund', 'issue-refund · tool · Tool runner']);
    expect(tool.querySelector('code.ib-identifier')?.textContent).toBe('issue-refund');
    expect(view.getByRole('option', { name: 'New chat about refund' })).not.toBeNull();
    await fireEvent.click(tool);
    await waitFor(() =>
      expect(router.pathname + '?' + router.search.toString()).toBe(toolPath('issue-refund')),
    );
  });

  test('the first result is highlighted, and a waiting item leads with its amber glyph', async () => {
    const store = memoryStore();
    store.setActivity([WAITING]);
    const view = open({ store });
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'refund' } });

    const first = await view.findByRole('option', {
      name: 'tool-runner needs your approval · Refund order 1234',
    });
    await waitFor(() => expect(first.getAttribute('aria-selected')).toBe('true'));
    expect(
      first.querySelector('.cinder-command-item__leading')?.getAttribute('data-cinder-tone'),
    ).toBe('warning');
  });

  test('New chat about the query opens a new chat holding the topic', async () => {
    const view = open();
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'refund' } });

    await fireEvent.click(await view.findByRole('option', { name: 'New chat about refund' }));

    await waitFor(() =>
      expect(router.pathname + '?' + router.search.toString()).toBe('/chats/new?about=refund'),
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

    await waitFor(() => expect(groups(view)).toEqual(['Agents and tools']));
    expect(groups(view)).toEqual(['Agents and tools']);
    expect(view.getAllByRole('option').map((option) => option.getAttribute('aria-label'))).toEqual([
      'Echo, echo, agent',
      'Tool runner, tool-runner, agent',
    ]);
    await fireEvent.click(view.getByRole('option', { name: /^Echo/ }));
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

    await waitFor(() => expect(groups(view)).toContain('Agents and tools'));
    // What is behind a scope is not read: no workflows, schedules, workers or reviews.
    expect(groups(view)).not.toContain('Workflows');
    expect(groups(view)).not.toContain('Schedules');
    expect(groups(view)).not.toContain('Workers');
    expect(groups(view)).not.toContain('Reviews');
  });
});
