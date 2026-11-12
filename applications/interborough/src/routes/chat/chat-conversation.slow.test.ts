/** Slow transport recovery coverage: both failed reconnect cycles remain real-time and isolated. */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, expect, jest, test } from 'bun:test';

import ChatConversation from './chat-conversation.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  restore?.();
  restore = undefined;
});

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

async function sendMessage(container: HTMLElement, text: string): Promise<void> {
  const box = container.querySelector('textarea');
  if (box === null) throw new Error('The composer did not render.');
  await fireEvent.input(box, { target: { value: text } });
  await fireEvent.keyDown(box, { key: 'Enter' });
}

test('shows the session read failure, then the same failed run after dismissal', async () => {
  restore = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url) => {
    if (url.endsWith('/messages') || url.includes('/threads/')) {
      throw new TypeError('Failed to fetch');
    }
    if (url.includes('/agents/')) {
      return sse([{ type: 'RUN_ERROR', message: 'The thread is busy.', code: 'X' }]);
    }
    return undefined;
  }).restore;
  landAt('/chats/session-1');
  const { container, findByText, findByRole, queryByText } = render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
    },
  } as never);

  expect(await findByText('Failed to fetch')).not.toBeNull();

  await sendMessage(container, 'Hello');
  expect(await findByText('The thread is busy.')).not.toBeNull();
  await fireEvent.click(await findByRole('button', { name: 'Dismiss alert' }));
  await waitUntil(() => queryByText('The thread is busy.') === null, {
    message: 'dismissed alert removed',
  });
  expect(queryByText('The thread is busy.')).toBeNull();

  await sendMessage(container, 'Hello again');
  expect(await findByText('The thread is busy.')).not.toBeNull();
});
