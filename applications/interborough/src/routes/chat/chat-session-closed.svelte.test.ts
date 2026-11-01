/**
 * A session whose chat was deleted (COR-1968): the Bureau starts a chat again when it is sent to, so
 * a closed session sends nothing, and a not-found answer is handed to the page to check.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';
import type { Fetcher } from '../../lib/bureau-client.ts';
import { ChatSessionState } from './chat-session.svelte.ts';

let sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions = [];
});

function open(
  fetchAgUi: Fetcher,
  options: { closed?: () => boolean; onNotFound?: () => void } = {},
): ChatSessionState {
  const session = new ChatSessionState({
    sessionId: 'thread-1',
    agentName: () => 'assistant',
    fetch: fetchAgUi,
    ...options,
  });
  sessions.push(session);
  return session;
}

describe('a closed session', () => {
  test('sends nothing, however the message is sent', async () => {
    const requests: string[] = [];
    const session = open(
      async () => {
        requests.push('request');
        return new Response('', { status: 404 });
      },
      { closed: () => true },
    );

    const outcome = await session.send('Still there?').then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(requests).toEqual([]);
  });
});

describe('a not-found answer', () => {
  test('is handed to the page when a send is answered with HTTP 404', async () => {
    let told = 0;
    const session = open(async () => new Response('', { status: 404 }), {
      onNotFound: () => {
        told += 1;
      },
    });

    await session.send('Hello').catch(() => undefined);

    await waitUntil(() => told > 0, { message: 'the page is told' });
  });
});
