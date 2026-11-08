/**
 * Opening a chat whose run is still going and then finishes without asking anything (COR-2016,
 * design row 16m): the page joins the run, shows what it said, and never takes the person's focus,
 * because there was no approval to bring them to.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, expect, test } from 'bun:test';

import ChatConversation from './chat-conversation.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

test('joins a run that finishes without asking, and leaves focus where the person has it', async () => {
  restore = bureau(
    { 'bureau.contexts.get': () => CONTEXT, 'bureau.reviews.list': () => ({ reviews: [] }) },
    (url) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
      if (url.includes('/threads/')) {
        return sse([
          { type: 'RUN_STARTED', threadId: 'session-1', runId: 'native-1' },
          { type: 'TEXT_MESSAGE_START', messageId: 'reply-1', role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply-1', delta: 'Order 4471 is $42.00.' },
          { type: 'TEXT_MESSAGE_END', messageId: 'reply-1' },
          { type: 'RUN_FINISHED', threadId: 'session-1', runId: 'native-1' },
        ]);
      }
      return undefined;
    },
  ).restore;
  landAt('/chats/session-1');

  const { findByText, container } = render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
    },
  } as never);

  expect(await findByText(/Order 4471 is \$42\.00\./)).not.toBeNull();
  expect(container.querySelector('[data-approval-decision]')).toBeNull();
  expect(document.activeElement?.closest('[data-approval-decision]') ?? null).toBeNull();
});
