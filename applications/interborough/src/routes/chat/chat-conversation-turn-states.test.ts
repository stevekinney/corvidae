/**
 * The chat page hands Chat where its turns stand (COR-2283 R3 to R6): when the stream of a run it
 * was reading drops, the turn is `reconnecting`, so Chat says by the composer which try comes next,
 * of how many, and when, with a Retry that reads the run again at once.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import ChatConversation from './chat-conversation.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const TURNS = [
  { id: 'u1', role: 'user', content: 'Plan the week' },
  { id: 'a1', role: 'assistant', content: 'Here is a first' },
];

/**
 * A Bureau whose run stream sends the run's start and its rows, then drops; every later read of
 * the stream fails as a network failure does. Counts the reads.
 */
function droppingStream(): { reads: () => number } {
  let reads = 0;
  restore = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url) => {
    if (url.includes('/threads/')) {
      reads += 1;
      if (reads > 1) return Promise.reject(new TypeError('Failed to fetch'));
      // The frames are read first, then the next read finds the connection gone.
      let pulls = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (pulls > 1) {
              controller.error(new TypeError('network connection lost'));
              return;
            }
            for (const frame of [
              { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
              { type: 'MESSAGES_SNAPSHOT', messages: TURNS },
            ]) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
            }
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: TURNS });
    return undefined;
  }).restore;
  return { reads: () => reads };
}

describe('a run whose stream dropped', () => {
  test('says by the composer which try comes next, of how many, and when, and Retry reads again at once', async () => {
    const stream = droppingStream();
    landAt('/chats/session-1');
    const { container } = render(QueryPage, {
      props: {
        page: ChatConversation,
        pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
      },
    } as never);

    const notice = () => container.querySelector<HTMLElement>('.chat-connection-notice');
    await waitFor(() => expect(notice()).not.toBeNull(), { timeout: 10_000 });
    expect(notice()?.textContent).toMatch(
      /Connection lost\. Reconnecting, attempt \d+ of 7\. Next try in \d+s\./,
    );
    // One notice: the composer's own reconnect status is not drawn a second time.
    expect(container.querySelector('[data-chat-composer-drawer="reconnecting"]')).toBeNull();

    const before = stream.reads();
    const retry = [...notice()!.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Retry',
    )!;
    await fireEvent.click(retry);

    await waitFor(() => expect(stream.reads()).toBeGreaterThan(before));
  });
});
