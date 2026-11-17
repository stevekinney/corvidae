/**
 * The chat page hands Chat where its turns stand (COR-2283 R3 to R6): when the stream of a run it
 * was reading drops, the turn is `reconnecting`, so Chat says by the composer which try comes next,
 * of how many, and when, with a Retry that reads the run again at once.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
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

/** A read that never answers, until the page gives it up. */
function hanging(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('The read was given up.', 'AbortError')),
    );
  });
}

/**
 * A Bureau whose run stream sends the run's start and its rows, then drops. The first try to read
 * it again never answers, so the page stays on its first scheduled try; the read Retry starts fails
 * as a network failure does, and every read after that never answers. Counts the reads.
 */
function droppingStream(): { reads: () => number } {
  let reads = 0;
  restore = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url, init) => {
    if (url.includes('/threads/')) {
      reads += 1;
      if (reads === 3) return Promise.reject(new TypeError('Failed to fetch'));
      if (reads > 1) return hanging(init);
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
    await waitUntil(() => notice() !== null, { message: 'the reconnect notice' });
    expect(notice()?.textContent).toMatch(
      /Connection lost\. Reconnecting, attempt 1 of 7\. Next try in \d+s\./,
    );
    // One notice: the composer's own reconnect status is not drawn a second time.
    expect(container.querySelector('[data-chat-composer-drawer="reconnecting"]')).toBeNull();

    await waitUntil(() => stream.reads() === 2, { message: 'the first try to read again' });
    const retry = [...notice()!.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Retry',
    )!;
    await fireEvent.click(retry);

    // Retry reads again at once; that read fails too, and the turn still says the run's stream
    // dropped, with the count started over.
    await waitUntil(() => stream.reads() >= 3, { message: 'the read Retry starts' });
    await waitUntil(() => notice()?.textContent?.includes('attempt 1 of 7') === true, {
      message: 'the reconnect notice after Retry',
    });
  });
});
