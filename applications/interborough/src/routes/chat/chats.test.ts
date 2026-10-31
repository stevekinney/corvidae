import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { router } from '../../lib/router.svelte.ts';
import Chats from './chats.svelte';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: Chats } } as never);

const page = (offset: number, count: number, more: boolean) => ({
  contexts: Array.from({ length: count }, (_, index) => ({
    ...CONTEXT,
    id: `session-${offset + index}`,
    title: `Chat ${offset + index}`,
  })),
  nextOffset: more ? offset + count : null,
});

describe('the list of sessions', () => {
  test('is the sessions the Bureau lists, newest first, each as a link with its latest message and its agent', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 3, false),
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chats');

    const { findByRole } = mount();

    const list = await findByRole('region', { name: 'Chats' });
    await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(3));
    const rows = [...list.querySelectorAll('li')];
    expect(rows[0]?.textContent).toContain('Chat 0');
    expect(rows[2]?.textContent).toContain('Chat 2');
    // The snippet is the latest message, not the title again, and the agent is named for a screen
    // reader through its avatar, with no visible "Agent:" label.
    expect(rows[0]?.textContent).toContain(CONTEXT.lastMessagePreview);
    expect(rows[0]?.textContent).toContain(CONTEXT.agentName);
    expect(list.textContent).not.toContain('Agent:');
    expect(rows[0]?.querySelector('button')).not.toBeNull();
    expect(rows[0]?.querySelector('time')).not.toBeNull();
    expect(served.calls.find((call) => call.method === 'bureau.contexts.list')?.params).toEqual({
      // Only the chats a person started: a goal's or a schedule's session is reached from its run.
      origin: 'chat',
      limit: 20,
      offset: 0,
    });
  });

  test('lists a chat whose run waits on you under Needs you, above the others, with the question it asks and a chip; a finished chat has none', async () => {
    const now = new Date().toISOString();
    const served = bureau({
      'bureau.contexts.list': () => ({
        contexts: [
          { ...CONTEXT, id: 'finished', title: 'Finished chat', updatedAt: now },
          {
            ...CONTEXT,
            id: 'waiting',
            title: 'Waiting chat',
            agentName: 'request-human-input',
            lastMessagePreview: 'Ship the release',
            activity: 'awaiting-input',
            // Older than the finished chat: Needs you comes first whatever the age.
            updatedAt: '2026-10-01T09:00:00.000Z',
          },
        ],
        nextOffset: null,
      }),
      'bureau.reviews.list': () => ({
        reviews: [
          {
            id: 'review-1',
            runId: 'run-1',
            kind: 'human-wait',
            sessionId: 'waiting',
            signalName: 'environment',
            prompt: 'Which environment should the release go to?',
            requestedAt: 1,
            ageMilliseconds: 1,
            status: 'pending',
          },
        ],
      }),
    });
    restore = served.restore;
    landAt('/chats');

    const { findByRole } = mount();

    const list = await findByRole('region', { name: 'Chats' });
    await waitFor(() =>
      expect(list.textContent).toContain('Which environment should the release go to?'),
    );
    // One flat list, the chat that waits on the person first.
    const groups = [...list.querySelectorAll('[data-group]')].map((row) =>
      row.getAttribute('data-group'),
    );
    expect(groups.slice(0, 2)).toEqual(['needs-you', 'today']);
    const needs = list.querySelector('[data-group="needs-you"]');
    const today = list.querySelector('[data-group="today"]');
    expect(needs?.textContent).toContain('Waiting chat');
    expect(needs?.querySelectorAll('.cinder-badge')).toHaveLength(1);
    expect(today?.textContent).toContain('Finished chat');
    expect(today?.querySelectorAll('.cinder-badge')).toHaveLength(0);
  });

  test('lists a waiting chat from a page that is not loaded under Needs you, read on its own', async () => {
    const waitingReview = (sessionId: string, id: string) => ({
      id,
      runId: `run-${id}`,
      kind: 'human-wait',
      sessionId,
      signalName: 'environment',
      prompt: `Question of ${sessionId}?`,
      requestedAt: 1,
      ageMilliseconds: 1,
      status: 'pending',
    });
    const served = bureau({
      // Twenty newer chats fill the first page; the waiting ones are older, past it.
      'bureau.contexts.list': () => page(0, 20, true),
      'bureau.reviews.list': () => ({
        reviews: [
          waitingReview('late-waiting', 'review-1'),
          waitingReview('late-goal', 'review-2'),
          waitingReview('session-3', 'review-3'),
        ],
      }),
      'bureau.contexts.get': (params) => {
        const contextId = String(params['contextId']);
        return {
          ...CONTEXT,
          id: contextId,
          title: `Late ${contextId}`,
          agentName: 'request-human-input',
          activity: 'awaiting-input',
          updatedAt: '2026-09-01T09:00:00.000Z',
          // A goal's session is not one of the chats Chat lists.
          origin: contextId === 'late-goal' ? 'goal' : 'chat',
        };
      },
    });
    restore = served.restore;
    landAt('/chats');

    const { findByRole } = mount();

    const list = await findByRole('region', { name: 'Chats' });
    await waitFor(() => expect(list.textContent).toContain('Late late-waiting'));
    const needs = list.querySelectorAll('[data-group="needs-you"]');
    expect(needs).toHaveLength(1);
    expect(needs[0]?.textContent).toContain('Question of late-waiting?');
    expect(list.textContent).not.toContain('late-goal');
    // Only the chats the loaded pages lack are read: `session-3` is already on the page.
    const reads = served.calls
      .filter((call) => call.method === 'bureau.contexts.get')
      .map((call) => String(call.params['contextId']))
      .toSorted((left, right) => left.localeCompare(right));
    expect(reads).toEqual(['late-goal', 'late-waiting']);
  });

  test('marks an idle chat whose latest run failed with a Failed chip, and none whose latest run recovered', async () => {
    const run = (id: string, contextId: string, status: string, updatedAt: string) => ({
      id,
      contextId,
      agentName: 'assistant',
      owner: 'anonymous:local',
      actor: null,
      kind: 'chat',
      status,
      finishReason: null,
      statusMessage: null,
      createdAt: updatedAt,
      updatedAt,
      cleanup: null,
      openWaits: [],
    });
    const served = bureau({
      'bureau.contexts.list': () => page(0, 3, false),
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.tasks.list': () => ({
        tasks: [
          run('t-1', 'session-0', 'failed', '2026-10-23T09:00:00.000Z'),
          run('t-2', 'session-1', 'failed', '2026-10-23T08:00:00.000Z'),
          run('t-3', 'session-1', 'completed', '2026-10-23T09:30:00.000Z'),
        ],
        nextPageToken: null,
      }),
    });
    restore = served.restore;
    landAt('/chats');

    const { findByRole } = mount();

    const list = await findByRole('region', { name: 'Chats' });
    await waitFor(() =>
      expect(list.querySelector('[data-chat="session-0"]')?.textContent).toContain('Failed'),
    );
    expect(list.querySelector('[data-chat="session-1"]')?.textContent).not.toContain('Failed');
    expect(list.querySelector('[data-chat="session-2"]')?.textContent).not.toContain('Failed');
  });

  test('falls back to the last message for a waiting chat when the reviews cannot be read', async () => {
    const served = bureau({
      'bureau.contexts.list': () => ({
        contexts: [
          {
            ...CONTEXT,
            id: 'waiting',
            activity: 'awaiting-input',
            lastMessagePreview: 'Last said',
          },
        ],
        nextOffset: null,
      }),
    });
    restore = served.restore;
    landAt('/chats');

    const { findByRole } = mount();

    const list = await findByRole('region', { name: 'Chats' });
    await waitFor(() => expect(list.textContent).toContain('Last said'));
    expect(list.querySelectorAll('.cinder-badge')).toHaveLength(1);
  });

  test('says nothing at the end of the list', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 2, false),
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chats');

    const { findByRole } = mount();

    const list = await findByRole('region', { name: 'Chats' });
    await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(2));
    expect(list.textContent).not.toContain('End of list');
  });

  test('asks for the next page by its offset when Load more is pressed', async () => {
    const served = bureau({
      'bureau.contexts.list': (params) =>
        params['offset'] === 0 ? page(0, 20, true) : page(20, 2, false),
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chats');
    const { findByRole } = mount();

    const more = await findByRole('button', { name: 'Load more' });
    more.click();

    await waitFor(() =>
      expect(
        served.calls
          .filter((call) => call.method === 'bureau.contexts.list')
          .map((call) => call.params['offset']),
      ).toContain(20),
    );
  });

  test('does not repeat a session the next page gives again, and stays', async () => {
    const served = bureau({
      // A session began after the first page was read, so offset 20 starts with its last row.
      'bureau.contexts.list': (params) =>
        params['offset'] === 0
          ? page(0, 20, true)
          : { contexts: page(19, 2, false).contexts, nextOffset: null },
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chats');
    const { container, findByRole } = mount();

    const more = await findByRole('button', { name: 'Load more' });
    more.click();

    await waitFor(() => expect(container.textContent).toContain('Chat 20'));
    expect(container.textContent).not.toContain('Something went wrong');
    expect(container.textContent?.match(/Chat 19(?!\d)/g)).toHaveLength(1);
  });

  test('opens a session when its row is pressed', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 1, false),
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chats');
    const { findByRole } = mount();

    const row = await findByRole('button', { name: /Chat 0/ });
    row.click();

    expect(router.pathname).toBe('/chats/session-0');
  });

  test('shows no time for a chat whose time is unreadable', async () => {
    const served = bureau({
      'bureau.contexts.list': () => ({
        contexts: [{ ...CONTEXT, id: 'session-0', title: 'Chat 0', updatedAt: 'not a date' }],
        nextOffset: null,
      }),
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chats');
    const { findByRole } = mount();

    const row = await findByRole('button', { name: /Chat 0/ });

    expect(row.querySelector('time')).toBeNull();
  });

  test('says to pick a chat, with New chat as an action, until one is open', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 1, false),
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chats');

    const { findByRole } = mount();

    const detail = await findByRole('region', { name: 'Open chat' });
    expect(detail.textContent).toContain('Pick a chat');
    expect(detail.querySelector('a[href="/chats/new"]')?.textContent).toContain('New chat');
    const title = await findByRole('heading', { level: 1 });
    expect(title.textContent?.trim()).toBe('Chats');
  });

  test('opens the chat the address names beside the list, marks its row, and reads it when no page holds it', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 2, true),
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.contexts.get': (params) => ({
        ...CONTEXT,
        id: String(params['contextId']),
        title: 'An old chat',
      }),
    });
    restore = served.restore;
    landAt('/chats/old-one');

    const { findByRole } = mount();

    const row = await findByRole('button', { name: /An old chat/ });
    expect(row.getAttribute('aria-current')).toBe('true');
    const title = await findByRole('heading', { level: 1 });
    expect(title.textContent?.trim()).toBe('An old chat');
    // The list's own title is no longer the page's heading.
    expect(await findByRole('heading', { level: 2, name: 'Chats' })).not.toBeNull();
  });

  test('lists a new chat first, as a row of its own, until the Bureau lists it', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 2, false),
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.agents.list': () => ({ agents: [AGENT] }),
    });
    restore = served.restore;
    landAt('/chats/new?agent=assistant');

    const { findAllByRole } = mount();

    const rows = await findAllByRole('button', { name: /Chat \d|New chat/ });
    const draft = rows.find((row) => row.getAttribute('data-group') === 'draft');
    expect(draft?.textContent).toContain('New chat');
    expect(draft?.getAttribute('aria-current')).toBe('true');
    expect(rows[0]).toBe(draft as HTMLElement);
  });

  test('has a New chat action that opens /chats/new, and leaves a modified click to the browser', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 1, false),
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chats');
    const { findAllByRole } = mount();
    const actions = await findAllByRole('link', { name: 'New chat' });
    const action = actions[0] as HTMLElement;

    action.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(router.pathname).toBe('/chats');
    action.click();

    expect(action.getAttribute('href')).toBe('/chats/new');
    expect(router.pathname).toBe('/chats/new');
  });
});
