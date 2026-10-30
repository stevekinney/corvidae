/** Choosing a result in the ⌘K palette opens that record, not the collection it belongs to. */
import { HttpClient } from '@lostgradient/weft';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { schedulePath, workerPath } from './command-palette-search.ts';
import CommandPaletteLauncher from './command-palette.svelte';

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

async function choose(query: string, resultName: RegExp) {
  stubEngine();
  landAt('/chat');
  const view = render(CommandPaletteLauncher, {
    props: { open: true, client: new HttpClient({ baseUrl: 'http://localhost/api' }) },
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
    landAt('/chat');
    const view = render(CommandPaletteLauncher, {
      props: { open: true, client: new HttpClient({ baseUrl: 'http://localhost/api' }) },
    });
    expect(view.getByPlaceholderText('Search everything')).not.toBeNull();
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
      'Commands',
    ]);
  });

  test('opens the chat the title names', async () => {
    await choose('ech', /^Hello echo, say this back/);
    await waitFor(() => expect(router.pathname).toBe('/chat/echo-chat'));
  });

  test('opens the agent’s page', async () => {
    await choose('ech', /^echo, Repeats/);
    await waitFor(() => expect(router.pathname).toBe('/agents/echo'));
  });

  test('New chat with echo opens a new chat with that agent', async () => {
    await choose('ech', /^New chat with echo$/);
    await waitFor(() =>
      expect(router.pathname + '?' + router.search.toString()).toBe('/chat/new?agent=echo'),
    );
  });

  test('Go to Reviews opens the reviews page', async () => {
    await choose('go to rev', /^Go to Reviews$/);
    await waitFor(() => expect(router.pathname).toBe('/reviews'));
  });
});

describe('choosing with the keyboard', () => {
  test('Enter opens the first result, the chat', async () => {
    stubEngine();
    landAt('/chat');
    const view = render(CommandPaletteLauncher, {
      props: { open: true, client: new HttpClient({ baseUrl: 'http://localhost/api' }) },
    });
    const input = await view.findByRole('combobox');
    await fireEvent.input(input, { target: { value: 'ech' } });
    await waitFor(() => expect(view.getAllByRole('option')).toHaveLength(3));
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(router.pathname).toBe('/chat/echo-chat'));
  });
});

describe('the engine pages and the empty states', () => {
  test('an engine page opens by name', async () => {
    await choose('go to storage', /^Storage$/);
    await waitFor(() => expect(router.pathname).toBe('/storage'));
  });

  test('says what to type before anything is typed, and when nothing matches', async () => {
    stubEngine();
    landAt('/chat');
    const view = render(CommandPaletteLauncher, {
      props: { open: true, client: new HttpClient({ baseUrl: 'http://localhost/api' }) },
    });
    expect(await view.findByText('Search the console')).not.toBeNull();
    await fireEvent.input(await view.findByRole('combobox'), { target: { value: 'zzzqqq' } });
    expect(await view.findByText('No matches')).not.toBeNull();
  });
});

describe('the palette shortcut', () => {
  test('Cmd+K and Ctrl+K open the palette, and other keys leave it closed', async () => {
    stubEngine();
    landAt('/chat');
    const view = render(CommandPaletteLauncher, {
      props: { open: false, client: new HttpClient({ baseUrl: 'http://localhost/api' }) },
    });

    await fireEvent.keyDown(window, { key: 'k' });
    expect(view.queryByRole('combobox')).toBeNull();

    await fireEvent.keyDown(window, { key: 'K', ctrlKey: true });
    expect(await view.findByRole('combobox')).not.toBeNull();
  });
});

describe('the paths of a record', () => {
  test('encode the identifier', () => {
    expect(schedulePath('a b/c')).toBe('/schedules/a%20b%2Fc');
    expect(workerPath('a&b')).toBe('/workers?tab=list&worker=a%26b');
  });
});
