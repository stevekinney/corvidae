/**
 * Running the last turn again after a run stopped partway (COR-2014): `retryTurn` drops the reply
 * that stopped and sends the person's message again, so nothing of the failed attempt is kept, and it
 * never resumes a call the run was in the middle of.
 */
import { appendMessages, type ConversationHistory } from '@lostgradient/chat';
import { afterEach, describe, expect, test } from 'bun:test';

import type { Fetcher } from '../../lib/bureau-client.ts';
import { ChatSessionState } from './chat-session.svelte.ts';

const THREAD = 'thread-1';

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const started = (runId: string) => ({
  type: 'RUN_STARTED',
  threadId: THREAD,
  runId,
  metadata: { '@lostgradient/bureau': { runId, sessionId: THREAD, durable: false } },
});

const fresh = [
  started('run-2'),
  { type: 'TEXT_MESSAGE_START', messageId: 'run-2:step:0', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'run-2:step:0', delta: 'Refunded.' },
  { type: 'TEXT_MESSAGE_END', messageId: 'run-2:step:0' },
  { type: 'RUN_FINISHED', threadId: THREAD, runId: 'run-2', outcome: { type: 'success' } },
];

let sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions = [];
});

function open(fetchAgUi: Fetcher, history?: (empty: ConversationHistory) => ConversationHistory) {
  const session = new ChatSessionState({
    sessionId: THREAD,
    agentName: () => 'assistant',
    fetch: fetchAgUi,
  });
  sessions.push(session);
  if (history !== undefined) session.conversation = history(session.conversation);
  return session;
}

const visibleText = (session: ChatSessionState) =>
  session.conversation.ids.flatMap((id) => {
    const row = session.conversation.messages[id];
    return row === undefined || row.hidden || typeof row.content !== 'string'
      ? []
      : [`${row.role}:${row.content}`];
  });

/** A chat opened on a run that stopped partway: the person's message and the reply that stopped. */
const stopped = (empty: ConversationHistory) =>
  appendMessages(
    empty,
    { role: 'user', content: 'Please refund 4471' },
    { role: 'assistant', content: 'Order 4471 is' },
  );

describe('running the last turn again', () => {
  test('is offered for a last message that is plain text, once nothing is going', () => {
    expect(open(async () => sse(fresh), stopped).canRetryTurn).toBe(true);
    expect(open(async () => sse(fresh)).canRetryTurn).toBe(false);
  });

  test('drops the reply that stopped and sends the same message again, keeping nothing of it', async () => {
    const bodies: string[] = [];
    const session = open(async (_url, init) => {
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      return sse(fresh);
    }, stopped);

    await session.retryTurn();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('Please refund 4471');
    expect(bodies[0]).not.toContain('Order 4471 is');
    expect(visibleText(session)).toEqual(['user:Please refund 4471', 'assistant:Refunded.']);
    expect(session.failure).toBeUndefined();
  });

  test('never resumes a call the run was in the middle of: the request carries no result for it', async () => {
    const bodies: string[] = [];
    const session = open(
      async (_url, init) => {
        bodies.push(typeof init?.body === 'string' ? init.body : '');
        return sse(fresh);
      },
      (empty) =>
        appendMessages(
          empty,
          { role: 'user', content: 'Please refund 4471' },
          {
            role: 'tool-call',
            content: '',
            toolCall: { id: 'c1', name: 'issue-refund', arguments: { orderId: '4471' } },
          },
        ),
    );

    await session.retryTurn();

    expect(bodies[0]).not.toContain('"toolCallId":"c1"');
    expect(bodies[0]).not.toContain('issue-refund');
  });

  test('is not offered for a message that is not plain text, and sends nothing then', async () => {
    let sent = 0;
    const session = open(
      async () => {
        sent += 1;
        return sse(fresh);
      },
      (empty) => appendMessages(empty, { role: 'user', content: '   ' }),
    );
    expect(session.canRetryTurn).toBe(false);
    await session.retryTurn();
    expect(sent).toBe(0);
  });
});
