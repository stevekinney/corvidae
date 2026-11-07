/**
 * The chat route's page (the list with the open chat beside it) over stubbed Bureau requests: a session whose title and agent could not be
 * read is never left on the loading skeleton, however its second read fails.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';

import { breadcrumbTrail } from '../../app/breadcrumbs.svelte.ts';
import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { CHAT_COPY, VIEW_COPY } from '../../app/copy.ts';
import { settle, until } from '../../lib/fake-timers.test-support.ts';
import { chatSessionPath } from '../../lib/identifier-paths.ts';
import { router } from '../../lib/router.svelte.ts';
import Chats from './chats.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: Chats } } as never);

/** Bureau requests that answer `contexts.get` as `answer` says, counting how often it is asked. */
function contextAnswering(answer: () => Response): { asked: () => number } {
  let asked = 0;
  // The list beside the chat reads its own page of chats, and answers them none.
  restore = bureau(
    { 'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }) },
    (url, init) => {
      if (url.endsWith('/messages') || url.includes('/threads/')) return undefined;
      const body = typeof init?.body === 'string' ? init.body : '{}';
      if (!body.includes('bureau.contexts.get')) return undefined;
      asked += 1;
      return answer();
    },
  ).restore;
  return { asked: () => asked };
}

describe('a session whose page could not read it', () => {
  test('is not found when the Bureau says there is no such session, and not the loading skeleton', async () => {
    contextAnswering(() =>
      Response.json(
        {
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32004, message: 'NotFound', data: { httpStatus: 404 } },
        },
        { status: 404 },
      ),
    );
    landAt('/chats/session-1');

    const { findByRole, container } = mount();

    await findByRole('heading', { level: 1, name: VIEW_COPY.chat.notFound?.title ?? '' });
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  test('is the forbidden page when the Bureau refuses the person the chat', async () => {
    contextAnswering(() => Response.json({ error: 'Forbidden' }, { status: 403 }));
    landAt('/chats/session-1');

    const { findByRole, container } = mount();

    await findByRole('heading', { name: VIEW_COPY.chat.forbidden.title });
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  test('is an error with a way to try again for any other failure', async () => {
    let healthy = false;
    const context = contextAnswering(() =>
      healthy
        ? Response.json({
            jsonrpc: '2.0',
            id: 1,
            result: {
              id: 'session-1',
              owner: null,
              agentName: 'assistant',
              title: 'Plan the week',
              lastMessagePreview: null,
              parentContextId: null,
              forkedFromMessageId: null,
              model: null,
              effort: null,
              permissionMode: 'on-changes',
              configVersion: 0,
              messageCount: 0,
              createdAt: '2026-10-19T08:00:00.000Z',
              updatedAt: '2026-10-19T08:00:00.000Z',
              activity: 'idle',
            },
          })
        : Response.json({ error: 'The server broke.' }, { status: 500 }),
    );
    landAt('/chats/session-1');

    const { findByRole, container } = mount();

    await findByRole('heading', { level: 1, name: CHAT_COPY.load.errorTitle });
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    const asked = context.asked();
    healthy = true;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(context.asked()).toBeGreaterThan(asked));
  });
});

describe('a chat that cannot be loaded (design rows 17c, 17d, 17e)', () => {
  const failing = () => Response.json({ error: 'The server broke.' }, { status: 500 });

  test('replaces the conversation area with the error state, names the chat in the breadcrumb, and draws no composer', async () => {
    contextAnswering(failing);
    landAt('/chats/session-1');

    const { findByRole, getByText, container } = mount();

    await findByRole('heading', { level: 1, name: CHAT_COPY.load.errorTitle });
    expect(getByText(CHAT_COPY.load.errorDescription)).not.toBeNull();
    // Nothing is sent to a chat that did not load.
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('.weft-chat-surface')).toBeNull();
    // The list beside it stays live.
    expect(container.querySelector('input[type="search"], [role="searchbox"]')).not.toBeNull();
    expect(breadcrumbTrail('/chats/session-1').map((item) => item.label)).toEqual([
      'Chat',
      CHAT_COPY.load.crumb,
    ]);
  });

  test('offers Try again as the primary action and Back to chats, which opens the list alone', async () => {
    contextAnswering(failing);
    landAt('/chats/session-1');
    const { findByRole } = mount();

    const retry = await findByRole('button', { name: CHAT_COPY.load.tryAgain });
    const back = await findByRole('button', { name: CHAT_COPY.load.backToChats });
    expect(retry.getAttribute('data-cinder-variant')).toBe('primary');
    expect(back.getAttribute('data-cinder-variant')).toBe('ghost');
    await fireEvent.click(back);

    expect(router.current.route?.pattern).toBe('/chats');
  });

  test('keeps the shell’s banner out while the server does not answer, and puts it back when the chat loads', async () => {
    const monitor = new ConnectionMonitor({
      probe: async () => {
        throw new TypeError('Failed to fetch');
      },
      probeDelayMs: () => 60_000,
      browserOffline: false,
    });
    restore = bureau(
      { 'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }) },
      (url, init) => {
        if (url.endsWith('/messages') || url.includes('/threads/')) return undefined;
        const body = typeof init?.body === 'string' ? init.body : '{}';
        if (!body.includes('bureau.contexts.get')) return undefined;
        throw new TypeError('Failed to fetch');
      },
    ).restore;
    landAt('/chats/session-1');
    const view = render(QueryPage, { props: { page: Chats, connection: monitor } } as never);
    try {
      await view.findByRole('heading', { level: 1, name: CHAT_COPY.load.errorTitle });
      await waitFor(() => expect(monitor.shownInPlace).toBe(true));
    } finally {
      cleanup();
      monitor.dispose();
    }
    expect(monitor.shownInPlace).toBe(false);
  });
});

describe('a session the page is still reading (design rows 17j, 17y)', () => {
  /** A Bureau that never answers the read of the chat, so the placeholders stay. */
  function neverAnswering() {
    restore = bureau(
      { 'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }) },
      (url, init) => {
        if (url.endsWith('/messages') || url.includes('/threads/')) return undefined;
        const body = typeof init?.body === 'string' ? init.body : '{}';
        return body.includes('bureau.contexts.get')
          ? new Response(new ReadableStream({ start() {} }))
          : undefined;
      },
    ).restore;
  }

  test('draws nothing for 300 ms, then placeholders in the real layout with the composer disabled', async () => {
    neverAnswering();
    landAt('/chats/session-1');
    jest.useFakeTimers();
    const { container, queryByRole, getByRole } = mount();
    await settle(4);

    // A read that is quick never flashes a placeholder.
    const loading = () => container.querySelector('[data-testid="chat-loading"]');
    expect(loading()?.querySelector('.cinder-skeleton')).toBeNull();
    expect(loading()?.querySelector('textarea')).toBeNull();

    jest.advanceTimersByTime(300);
    await until(() => expect(loading()?.querySelector('.cinder-skeleton')).not.toBeNull());

    const composer = getByRole('textbox', { name: /^Message/ });
    expect(composer.getAttribute('placeholder')).toBe('Message the agent…');
    expect(composer.hasAttribute('disabled')).toBe(true);
    expect(queryByRole('button', { name: 'Send message' })?.hasAttribute('disabled')).toBe(true);
    // Not slow yet, so no status line.
    expect(container.textContent).not.toContain(CHAT_COPY.load.stillLoading);
  });

  test('says it is still loading after 10 s, with a ghost Cancel that returns to the chat list', async () => {
    neverAnswering();
    landAt('/chats/session-1');
    jest.useFakeTimers();
    const { container, findByRole } = mount();
    await settle(4);

    jest.advanceTimersByTime(10_000);
    await until(() => expect(container.textContent).toContain(CHAT_COPY.load.stillLoading));

    // It is Cinder's own status line, not a banner or an alert.
    const status = container.querySelector('.cinder-skeleton-status');
    expect(status?.getAttribute('role')).toBe('status');
    expect(container.querySelector('[role="alert"], .cinder-banner')).toBeNull();
    const cancel = await findByRole('button', { name: 'Cancel' });
    await fireEvent.click(cancel);

    expect(router.current.route?.pattern).toBe('/chats');
  });

  test('shows the chat, and no placeholder, once it has loaded', async () => {
    restore = bureau(
      { 'bureau.contexts.get': () => ({ ...CONTEXT, title: 'Plan the week' }) },
      (url) =>
        url.endsWith('/messages') || url.includes('/threads/')
          ? Response.json({ threadId: 'session-1', messages: [] })
          : undefined,
    ).restore;
    landAt('/chats/session-1');

    const { findByRole, container } = mount();

    await findByRole('heading', { level: 1, name: 'Plan the week' });
    expect(container.querySelector('[data-testid="chat-loading"]')).toBeNull();
  });
});

describe('a session whose identifier the path cannot carry', () => {
  for (const sessionId of ['new', '.', '..']) {
    test(`opens the session ${sessionId}, and not the new chat or another page`, async () => {
      const { calls, restore: restoreBureau } = bureau(
        {
          'bureau.contexts.get': () => ({
            ...CONTEXT,
            id: sessionId,
            title: 'A session by an odd name',
          }),
        },
        (url) =>
          url.endsWith('/messages') || url.includes('/threads/')
            ? Response.json({ threadId: sessionId, messages: [] })
            : undefined,
      );
      restore = restoreBureau;
      landAt(chatSessionPath(sessionId));

      const { findByRole } = mount();

      await findByRole('heading', { level: 1, name: 'A session by an odd name' });
      expect(calls.find((call) => call.method === 'bureau.contexts.get')?.params).toEqual({
        contextId: sessionId,
      });
    });
  }
});
