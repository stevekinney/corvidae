/**
 * A stream that dropped and could not be joined again (design rows 18d and 18e): while Interborough
 * cannot be reached the shell's banner is the one account of it, so the chat draws no banner of its
 * own for the dropped stream; once the server answers again the chat joins the run again by itself,
 * and says so with its own Reconnect only if that fails too.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { CHAT_COPY } from '../../app/copy.ts';
import ChatConversation from './chat-conversation.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
const monitors: ConnectionMonitor[] = [];
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
  for (const monitor of monitors.splice(0)) monitor.dispose();
});

function monitor(unreachable: boolean): ConnectionMonitor {
  const made = new ConnectionMonitor({
    probe: async () => {
      throw new TypeError('Failed to fetch');
    },
    probeDelayMs: () => 60_000,
    browserOffline: false,
  });
  monitors.push(made);
  if (unreachable) made.reportUnreachable();
  return made;
}

/** A Bureau whose stream for the thread is refused, which gives the page up at once, counting each try. */
function refusingStream(): { attempts: () => number } {
  let attempts = 0;
  restore = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url) => {
    if (url.includes('/threads/')) {
      attempts += 1;
      return new Response('', { status: 403 });
    }
    if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
    return undefined;
  }).restore;
  return { attempts: () => attempts };
}

const mount = (connection: ConnectionMonitor) => {
  landAt('/chats/session-1');
  return render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
      connection,
    },
  } as never);
};

describe('a chat whose stream could not be joined again', () => {
  test('says it with its own Reconnect when the server answers and the stream still cannot be joined', async () => {
    refusingStream();
    const { findByText, findByRole } = mount(monitor(false));

    expect(await findByText(CHAT_COPY.disconnected.title)).not.toBeNull();
    expect(await findByRole('button', { name: CHAT_COPY.disconnected.reconnect })).not.toBeNull();
  });

  test('draws no banner of its own while the server does not answer, and joins the run again once it does', async () => {
    const stream = refusingStream();
    const connection = monitor(false);
    const { findByText, findByRole } = mount(connection);
    expect(await findByText(CHAT_COPY.disconnected.title)).not.toBeNull();
    expect(await findByRole('button', { name: CHAT_COPY.disconnected.reconnect })).not.toBeNull();

    // The server stops answering: the banner is the shell's, and the chat's own goes, with its
    // Reconnect (the chat joins the run again by itself when the server is back).
    connection.reportUnreachable();
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(CHAT_COPY.disconnected.title),
    );
    expect(document.body.textContent).not.toContain(CHAT_COPY.disconnected.reconnect);
    const before = stream.attempts();

    connection.reportReachable();

    await waitFor(() => expect(stream.attempts()).toBeGreaterThan(before));
    // The second try failed the same way, so now the chat says so itself.
    expect(await findByText(CHAT_COPY.disconnected.title)).not.toBeNull();
  });
});
