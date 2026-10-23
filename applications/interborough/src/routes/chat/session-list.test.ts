import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';
import SessionList from './session-list.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: SessionList } } as never);

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
    landAt('/chat');

    const { findByRole } = mount();

    const list = await findByRole('navigation', { name: 'Chats' });
    await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(3));
    const rows = [...list.querySelectorAll('li')];
    expect(rows[0]?.textContent).toContain('Chat 0');
    expect(rows[2]?.textContent).toContain('Chat 2');
    // The snippet is the latest message, not the title again, and the agent is named for a screen
    // reader through its avatar, with no visible "Agent:" label.
    expect(rows[0]?.textContent).toContain(CONTEXT.lastMessagePreview);
    expect(rows[0]?.textContent).toContain(CONTEXT.agentName);
    expect(list.textContent).not.toContain('Agent:');
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/chat/session-0');
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
    landAt('/chat');

    const { findByRole } = mount();

    const list = await findByRole('navigation', { name: 'Chats' });
    await waitFor(() =>
      expect(list.textContent).toContain('Which environment should the release go to?'),
    );
    const headings = [...list.querySelectorAll('h2')].map((heading) => heading.textContent);
    expect(headings).toEqual(['Needs you', 'Today']);
    const [needs, today] = [...list.querySelectorAll('section')];
    expect(needs?.textContent).toContain('Waiting chat');
    expect(needs?.querySelectorAll('.cinder-badge')).toHaveLength(1);
    expect(today?.textContent).toContain('Finished chat');
    expect(today?.querySelectorAll('.cinder-badge')).toHaveLength(0);
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
    landAt('/chat');

    const { findByRole } = mount();

    const list = await findByRole('navigation', { name: 'Chats' });
    await waitFor(() => expect(list.textContent).toContain('Last said'));
    expect(list.querySelectorAll('.cinder-badge')).toHaveLength(1);
  });

  test('says nothing at the end of the list', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 2, false),
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chat');

    const { findByRole } = mount();

    const list = await findByRole('navigation', { name: 'Chats' });
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
    landAt('/chat');
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
    landAt('/chat');
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
    landAt('/chat');
    const { findByRole } = mount();

    const row = await findByRole('link', { name: /Chat 0/ });
    row.click();

    expect(router.pathname).toBe('/chat/session-0');
  });

  test('has a New chat action that opens /chat/new, and leaves a modified click to the browser', async () => {
    const served = bureau({
      'bureau.contexts.list': () => page(0, 1, false),
      'bureau.reviews.list': () => ({ reviews: [] }),
    });
    restore = served.restore;
    landAt('/chat');
    const { findByRole } = mount();
    const action = await findByRole('link', { name: 'New chat' });

    action.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(router.pathname).toBe('/chat');
    action.click();

    expect(action.getAttribute('href')).toBe('/chat/new');
    expect(router.pathname).toBe('/chat/new');
  });
});
