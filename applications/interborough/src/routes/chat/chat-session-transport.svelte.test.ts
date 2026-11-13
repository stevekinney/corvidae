/**
 * What a session says of its own transports, and when a new chat's history may be read (COR-2293).
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, expect, test } from 'bun:test';
import type { Fetcher } from '../../lib/bureau-client.ts';
import { ChatSessionState } from './chat-session.svelte.ts';
import { AG_UI_PATH } from './run-wiring.ts';

const sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});
const open = (fetch: Fetcher, options: { readonly unopened?: boolean } = {}) => {
  const session = new ChatSessionState({
    sessionId: 'thread',
    agentName: () => 'assistant',
    fetch,
    ...options,
  });
  sessions.push(session);
  return session;
};
const urlOf = (input: Parameters<Fetcher>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const sse = (events: readonly unknown[]): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const started = { type: 'RUN_STARTED', threadId: 'thread', runId: 'run' };
const finished = { type: 'RUN_FINISHED', threadId: 'thread', runId: 'run' };
const reply = [
  { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Hi.' },
  { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
];
const isHistoryRead = (url: string): boolean => url === `${AG_UI_PATH}/threads/thread/messages`;

test('an opener’s transport is active from its request until its turn ends', async () => {
  const response = Promise.withResolvers<Response>();
  let posted = false;
  const session = open(async (_input, init) => {
    if (init?.method !== 'POST') return new Response('', { status: 404 });
    posted = true;
    return response.promise;
  });
  expect(session.transportActive).toBe(false);

  const sending = session.send('Hello');
  await waitUntil(() => posted, { message: 'the opener was posted' });

  // Nothing is attaching: the controller's own turn is what holds the transport.
  expect(session.attaching).toBe(false);
  expect(session.transportActive).toBe(true);
  response.resolve(sse([started, ...reply, finished]));
  await sending;
  expect(session.transportActive).toBe(false);
});

test('a new chat reads no history before its first run begins, and reads it once it has', async () => {
  const requests: string[] = [];
  const session = open(
    async (input, init) => {
      const url = urlOf(input);
      requests.push(url);
      if (url === `${AG_UI_PATH}/threads/thread/run`)
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      if (init?.method === 'POST') return sse([started, ...reply, finished]);
      return new Response('', { status: 404 });
    },
    { unopened: true },
  );

  // Before anything is sent: a refresh reads nothing, and a recovery attaches without a history read.
  expect(await session.refresh()).toBe(false);
  expect(requests).toEqual([]);
  expect(await session.reconnect()).toBe(false);
  expect(requests).toEqual([`${AG_UI_PATH}/threads/thread/run`]);

  await session.send('Hello');
  expect(requests.some(isHistoryRead)).toBe(false);
  expect(requests.filter((url) => url === `${AG_UI_PATH}/agents/assistant/run`)).toHaveLength(1);

  // The run's start kept the thread, so an idle refresh reads it now.
  await session.refresh().catch(() => false);
  expect(requests.some(isHistoryRead)).toBe(true);
});

test('a chat that names an existing thread reads its history when nothing is going', async () => {
  const requests: string[] = [];
  const session = open(async (input) => {
    const url = urlOf(input);
    requests.push(url);
    if (url === `${AG_UI_PATH}/threads/thread/run`)
      return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
    return new Response('', { status: 404 });
  });

  await session.attach();

  expect(requests.some(isHistoryRead)).toBe(true);
});

test('a refresh whose read a whole turn began and ended inside keeps the message that turn sent', async () => {
  // COR-2412: the refresh after an approval's run stopped read the thread while the follow-up from
  // Up next was sent and stopped on its own approval; the stale read replaced the follow-up's row.
  const staleHistory = Promise.withResolvers<Response>();
  let historyRequested = false;
  const session = open(async (input, init) => {
    const url = urlOf(input);
    if (isHistoryRead(url)) {
      historyRequested = true;
      return staleHistory.promise;
    }
    // The attach after a refresh joins the waiting run from its cursor: no messages snapshot.
    if (url === `${AG_UI_PATH}/threads/thread/run`)
      return sse([started, { type: 'STATE_SNAPSHOT', snapshot: {} }, finished]);
    if (init?.method === 'POST') return sse([started, ...reply, finished]);
    return new Response('', { status: 404 });
  });

  const refreshing = session.refresh().catch(() => false);
  await waitUntil(() => historyRequested, { message: 'the refresh read the thread' });
  await session.send('And one more thing');
  expect(session.streaming).toBe(false);

  staleHistory.resolve(Response.json({ threadId: 'thread', messages: [] }));
  expect(await refreshing).toBe(false);

  const texts = session.conversation.ids.map((id) =>
    JSON.stringify(session.conversation.messages[id]?.content ?? ''),
  );
  expect(texts.some((text) => text.includes('And one more thing'))).toBe(true);
});
