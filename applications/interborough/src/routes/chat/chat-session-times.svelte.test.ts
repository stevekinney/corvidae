/**
 * The Bureau's clock in a chat session (COR-2014, rows 16q and 17h). The Bureau stamps each event
 * it sends with its own time, which the session reads, so a message the person writes is stamped
 * with the Bureau's time (a host on an offset clock shows its own time for it, sent or not), a
 * call the session watched start counts from the Bureau's time on its `TOOL_CALL_START`, and a run
 * that ended says when.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';
import type { Fetcher } from '../../lib/bureau-client.ts';
import { BureauClock } from '../../lib/bureau-clock.ts';
import { ChatSessionState } from './chat-session.svelte.ts';

const THREAD = 'thread-1';
const NATIVE = 'native-1';
const meta = { '@lostgradient/bureau': { runId: NATIVE, sessionId: THREAD } };
const PAGE = Date.parse('2026-11-05T15:00:00.000Z');
const BUREAU = Date.parse('2026-11-02T16:45:00.000Z');
const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

let sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions = [];
});

/** A session whose page clock stands still at `PAGE`, over a Bureau answering with `start`. */
function open(start: () => Response): ChatSessionState {
  const fetchAgUi: Fetcher = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/messages')) return Response.json({ threadId: THREAD, messages: [] });
    if (url.includes('/threads/')) {
      return sse([
        { type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND', timestamp: BUREAU },
      ]);
    }
    if (url.includes('/agents/')) return start();
    return new Response('not found', { status: 404 });
  };
  const session = new ChatSessionState({
    sessionId: THREAD,
    agentName: () => 'tool-runner',
    fetch: fetchAgUi,
    clock: new BureauClock(() => PAGE),
  });
  sessions.push(session);
  return session;
}

const userRow = (session: ChatSessionState) =>
  session.conversation.ids
    .map((id) => session.conversation.messages[id])
    .find((row) => row?.role === 'user');

describe('a chat session on the Bureau’s clock', () => {
  test('stamps the message the person writes with the Bureau’s time, read from the attach', async () => {
    const session = open(() => new Response('unavailable', { status: 503 }));
    await session.attach();
    expect(session.clock.now()).toBe(BUREAU);
    await session.send('Also look up order 4398, the same carrier.').catch(() => undefined);
    await waitUntil(() => userRow(session) !== undefined, { message: 'the row is written' });
    expect(userRow(session)?.createdAt).toBe('2026-11-02T16:45:00.000Z');
  });

  test('keeps when a watched call started and answered, and when the run ended, on the Bureau’s clock', async () => {
    const started = BUREAU + 2_000;
    const answered = BUREAU + 2_400;
    const ended = BUREAU + 3_200;
    const session = open(() =>
      sse([
        {
          type: 'RUN_STARTED',
          threadId: THREAD,
          runId: 'run-a',
          metadata: meta,
          timestamp: BUREAU,
        },
        {
          type: 'TOOL_CALL_START',
          toolCallId: 'call-2',
          toolCallName: 'lookup-order',
          metadata: meta,
          timestamp: started,
        },
        {
          type: 'TOOL_CALL_ARGS',
          toolCallId: 'call-2',
          delta: '{}',
          metadata: meta,
          timestamp: started,
        },
        { type: 'TOOL_CALL_END', toolCallId: 'call-2', metadata: meta, timestamp: started },
        {
          type: 'TOOL_CALL_RESULT',
          messageId: 'native-1:step:0:result:call-2',
          toolCallId: 'call-2',
          content: 'delivered',
          role: 'tool',
          metadata: meta,
          timestamp: answered,
        },
        {
          type: 'RUN_ERROR',
          message: 'The model provider dropped the connection.',
          code: 'RUN_FAILED',
          metadata: meta,
          timestamp: ended,
        },
      ]),
    );
    await session.attach();
    await session.send('Also look up order 4398, the same carrier.').catch(() => undefined);
    await waitUntil(() => session.stoppedAt !== undefined, { message: 'the run ended' });
    expect(session.callStarts.get('call-2')).toBe(started);
    expect(session.callEnds.get('call-2')).toBe(answered);
    expect(session.stoppedAt).toBe(ended);
  });
});
