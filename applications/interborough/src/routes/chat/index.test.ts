/**
 * The chat route's page over stubbed Bureau requests: a session whose title and agent could not be
 * read is never left on the loading skeleton, however its second read fails.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { VIEW_COPY } from '../../app/copy.ts';
import { chatSessionPath } from '../../lib/identifier-paths.ts';
import ChatIndex from './index.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: ChatIndex } } as never);

/** Bureau requests that answer `contexts.get` as `answer` says, counting how often it is asked. */
function contextAnswering(answer: () => Response): { asked: () => number } {
  let asked = 0;
  restore = bureau({}, (url, init) => {
    if (url.endsWith('/messages') || url.includes('/threads/')) return undefined;
    const body = typeof init?.body === 'string' ? init.body : '{}';
    if (!body.includes('bureau.contexts.get')) return undefined;
    asked += 1;
    return answer();
  }).restore;
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

    await findByRole('heading', { level: 1, name: VIEW_COPY.chat.error.title });
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    const asked = context.asked();
    healthy = true;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(context.asked()).toBeGreaterThan(asked));
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
