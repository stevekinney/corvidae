/**
 * The chat route's page (the list with the open chat beside it) over stubbed Bureau requests: a session whose title and agent could not be
 * read is never left on the loading skeleton, however its second read fails.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';

import { breadcrumbTrail } from '../../app/breadcrumbs.svelte.ts';
import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { CHAT_COPY } from '../../app/copy/chat.ts';
import { VIEW_COPY } from '../../app/copy/view-pages.ts';
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

/** Chat's composer, when it is drawn: an availability state that replaces it hides it. */
function queryComposer(container: HTMLElement): HTMLElement | null {
  const wrapper = container.querySelector<HTMLElement>('.chat-input-wrapper');
  return wrapper === null || wrapper.style.display === 'none' ? null : wrapper;
}

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

    await findByRole('heading', { level: 2, name: CHAT_COPY.load.errorTitle });
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

    await findByRole('heading', { level: 2, name: CHAT_COPY.load.errorTitle });
    expect(getByText(CHAT_COPY.load.errorDescription)).not.toBeNull();
    // COR-2285 V3: Chat's error state stands in the transcript's place under the page's one
    // heading, and nothing is sent to a chat that did not load: there is no composer.
    expect(container.querySelector('[data-chat-availability="error"]')).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe(CHAT_COPY.load.crumb);
    expect(queryComposer(container)).toBeNull();
    // The list beside it stays live.
    expect(container.querySelector('input[type="search"], [role="searchbox"]')).not.toBeNull();
    expect(breadcrumbTrail('/chats/session-1').map((item) => item.label)).toEqual([
      'Chat',
      CHAT_COPY.load.crumb,
    ]);
  });

  test('offers Try again as the primary action and All conversations, which opens the list alone', async () => {
    contextAnswering(failing);
    landAt('/chats/session-1');
    const { findByRole } = mount();

    const retry = await findByRole('button', { name: CHAT_COPY.load.tryAgain });
    const back = await findByRole('button', { name: CHAT_COPY.load.allConversations });
    expect(retry.getAttribute('data-cinder-variant')).toBe('primary');
    expect(back.getAttribute('data-cinder-variant')).toBe('secondary');
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
      await view.findByRole('heading', { level: 2, name: CHAT_COPY.load.errorTitle });
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

  test('draws nothing for 300 ms, then Chat’s skeleton turns, with the editor kept and Send waiting (COR-2285 V2)', async () => {
    neverAnswering();
    landAt('/chats/session-1');
    jest.useFakeTimers();
    const { container, getByRole } = mount();
    await settle(4);

    // A read that is quick never flashes a placeholder.
    const loading = () => container.querySelector('[data-testid="chat-unavailable"]');
    expect(loading()?.querySelector('.cinder-skeleton')).toBeNull();
    expect(loading()?.querySelector('textarea')).toBeNull();

    jest.advanceTimersByTime(300);
    await until(() =>
      expect(loading()?.querySelector('[data-chat-availability="loading"]')).not.toBeNull(),
    );

    expect(loading()?.querySelectorAll('.cinder-skeleton').length).toBeGreaterThan(2);
    expect(loading()?.textContent).toContain(CHAT_COPY.load.loading);
    const composer = getByRole('textbox', { name: /^Message/ });
    expect(composer.getAttribute('placeholder')).toBe('Message the agent…');
    expect(composer.hasAttribute('disabled')).toBe(false);
    expect(getByRole('button', { name: 'Loading…' }).hasAttribute('disabled')).toBe(true);
    // Not slow yet, so no slow line.
    expect(container.textContent).not.toContain(CHAT_COPY.load.stillLoading);
    // The breadcrumb does not show the identifier of a chat that is still being read.
    expect(breadcrumbTrail('/chats/session-1').map((item) => item.label)).toEqual([
      'Chat',
      CHAT_COPY.load.crumb,
    ]);
  });

  test('says it is still loading after 10 s with Cancel, and a canceled read offers Try again and All conversations', async () => {
    let answers = 0;
    restore = bureau(
      { 'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }) },
      (url, init) => {
        if (url.endsWith('/messages') || url.includes('/threads/')) return undefined;
        const body = typeof init?.body === 'string' ? init.body : '{}';
        if (!body.includes('bureau.contexts.get')) return undefined;
        answers += 1;
        return new Response(new ReadableStream({ start() {} }));
      },
    ).restore;
    landAt('/chats/session-1');
    jest.useFakeTimers();
    const { container, findByRole } = mount();
    await settle(4);

    // Chat counts the seconds from the clock, so the clock moves with the timers.
    jest.advanceTimersByTime(300);
    await until(() =>
      expect(container.querySelector('[data-chat-availability="loading"]')).not.toBeNull(),
    );
    jest.setSystemTime(new Date(Date.now() + 10_000));
    jest.advanceTimersByTime(1_000);
    await until(() => expect(container.textContent).toContain(CHAT_COPY.load.stillLoading));

    // Chat's own slow notice, not a banner or an alert.
    expect(container.querySelector('[data-chat-availability="loading"][data-slow]')).not.toBeNull();
    expect(container.querySelector('[role="alert"], .cinder-banner')).toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Cancel' }));

    await until(() =>
      expect(container.querySelector('[data-chat-availability="canceled"]')).not.toBeNull(),
    );
    expect(router.current.route?.pattern).toBe('/chats/:chat');
    expect(container.textContent).toContain(CHAT_COPY.load.canceledTitle);
    const back = await findByRole('button', { name: CHAT_COPY.load.allConversations });
    expect(back.getAttribute('data-cinder-variant')).toBe('secondary');
    // Said once (COR-2327 B6): no notice over the composer, and the reason Send is off beside it.
    expect(container.querySelector('[data-chat-composer-drawer]')).toBeNull();
    const send = container.querySelector<HTMLButtonElement>('button[data-chat-send]')!;
    expect(send.disabled).toBe(true);
    const reason = container.querySelector('.chat-input-paused-reason');
    expect(reason?.textContent?.trim()).toBe(CHAT_COPY.load.sendBlocked);
    expect(send.getAttribute('aria-describedby')).toContain(reason?.id ?? 'missing-reason');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.readOnly).toBe(false);
    const asked = answers;
    // One label for one job (COR-2327 Q1): a canceled read, a failed one and a failing list each
    // offer Try again.
    expect(
      container.querySelector('[data-chat-availability="canceled"]')?.textContent,
    ).not.toContain('Retry');
    await fireEvent.click(await findByRole('button', { name: CHAT_COPY.load.tryAgain }));
    await until(() => expect(answers).toBeGreaterThan(asked));
    await until(() =>
      expect(container.querySelector('[data-chat-availability="loading"]')).not.toBeNull(),
    );
  });

  test('stays canceled when the reads held at Cancel answer late, and reads again only on Try again', async () => {
    // Every read of the chat is held: the pane's, and the list's read of the open chat's row.
    const held: Array<() => void> = [];
    let asked = 0;
    restore = bureau(
      { 'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }) },
      (url, init) => {
        if (url.endsWith('/messages') || url.includes('/threads/')) {
          return url.endsWith('/messages')
            ? Response.json({ threadId: 'session-1', messages: [] })
            : undefined;
        }
        const body = typeof init?.body === 'string' ? init.body : '{}';
        if (!body.includes('bureau.contexts.get')) return undefined;
        asked += 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              held.push(() => {
                try {
                  controller.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({
                        jsonrpc: '2.0',
                        id: 'bureau.contexts.get',
                        result: { ...CONTEXT, title: 'Plan the week' },
                      }),
                    ),
                  );
                  controller.close();
                } catch {
                  // The read was aborted: its stream is gone.
                }
              });
            },
          }),
        );
      },
    ).restore;
    landAt('/chats/session-1');
    jest.useFakeTimers();
    const { container, findByRole } = mount();
    await settle(4);
    jest.advanceTimersByTime(300);
    await until(() =>
      expect(container.querySelector('[data-chat-availability="loading"]')).not.toBeNull(),
    );
    jest.setSystemTime(new Date(Date.now() + 10_000));
    jest.advanceTimersByTime(1_000);
    await until(() => expect(container.textContent).toContain(CHAT_COPY.load.stillLoading));
    await fireEvent.click(await findByRole('button', { name: 'Cancel' }));
    await until(() =>
      expect(container.querySelector('[data-chat-availability="canceled"]')).not.toBeNull(),
    );
    const canceled = container.querySelector('[data-testid="chat-unavailable"]');

    // The reads that were out at Cancel answer now, as the server gets to them, and so does any
    // read that follows from them.
    for (let round = 0; round < 3; round += 1) {
      for (const answer of held.splice(0)) answer();
      await settle(8);
      jest.advanceTimersByTime(1_000);
      await settle(8);
    }

    // The person canceled: nothing loads the chat behind their back, and the state is the same one.
    expect(container.querySelector('[data-testid="chat-unavailable"]')).toBe(canceled);
    expect(container.querySelector('[data-chat-availability="canceled"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-header"]')).toBeNull();
    const readsBeforeRetry = asked;

    // Try again reads it again, and the chat it answers is shown.
    await fireEvent.click(await findByRole('button', { name: CHAT_COPY.load.tryAgain }));
    await until(() => expect(asked).toBeGreaterThan(readsBeforeRetry));
    for (const answer of held.splice(0)) answer();
    jest.useRealTimers();
    await findByRole('heading', { level: 1, name: 'Plan the week' });
  });

  test('keeps what the person typed while the chat was read, in the chat that replaces the placeholders', async () => {
    let answer: (() => void) | undefined;
    restore = bureau(
      {
        'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
        'bureau.contexts.get': () => ({ ...CONTEXT, title: 'Plan the week' }),
      },
      (url, init) => {
        if (url.endsWith('/messages') || url.includes('/threads/')) {
          return url.endsWith('/messages')
            ? Response.json({ threadId: 'session-1', messages: [] })
            : undefined;
        }
        const body = typeof init?.body === 'string' ? init.body : '{}';
        if (!body.includes('bureau.contexts.get') || answer !== undefined) return undefined;
        // The first read waits until the test lets it through.
        return new Response(
          new ReadableStream({
            start(controller) {
              answer = () => {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      jsonrpc: '2.0',
                      id: 'bureau.contexts.get',
                      result: { ...CONTEXT, title: 'Plan the week' },
                    }),
                  ),
                );
                controller.close();
              };
            },
          }),
        );
      },
    ).restore;
    landAt('/chats/session-1');
    const { container, findByRole } = mount();

    const box = await findByRole('textbox', { name: /^Message/ });
    await fireEvent.input(box, { target: { value: 'Before it loads' } });
    await until(() => expect(answer).toBeDefined());
    answer?.();

    await findByRole('heading', { level: 1, name: 'Plan the week' });
    await waitFor(() => expect(container.querySelector('textarea')?.value).toBe('Before it loads'));
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
    expect(container.querySelector('[data-testid="chat-unavailable"]')).toBeNull();
    // Once it has loaded the breadcrumb names the chat by its title.
    expect(breadcrumbTrail('/chats/session-1').map((item) => item.label)).toEqual([
      'Chat',
      'Plan the week',
    ]);
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
