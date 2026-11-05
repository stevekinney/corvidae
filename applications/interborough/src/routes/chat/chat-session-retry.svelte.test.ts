/**
 * Running the last turn again after a run stopped partway (COR-2014, rows 19r, 19x, 20a and 20c):
 * `retryTurn` asks the Bureau to take the failed turn back out of the thread (`bureau.contexts.rewind`)
 * and then sends the person's message again, so nothing of the failed attempt is kept, in the page or
 * in the thread the Bureau sends back (the snapshot that ends the run, and a thread read again). It
 * never resumes a call the run was in the middle of, and a tool that may change things goes back
 * through its approval because its remembered grant is forgotten with the turn.
 *
 * The Bureau is stubbed with a thread of its own, which the stubbed rewind shortens and the stubbed
 * run answers with, as the real one does: a mock stream that ended with no snapshot would pass
 * whether or not the thread still held the rows.
 */
import { appendMessages, type ConversationHistory } from '@lostgradient/chat';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';
import type { Fetcher } from '../../lib/bureau-client.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { ChatSessionState } from './chat-session.svelte.ts';
import type { ToolInfo } from './tool-activity.ts';

const THREAD = 'thread-1';

type WireMessage = Record<string, unknown> & { readonly id: string };

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

/** What the Bureau holds of the thread: the failed turn's rows, which a rewind takes out. */
const FAILED_PARTWAY: readonly WireMessage[] = [
  { id: 'u1', role: 'user', content: 'Please refund 4471' },
  { id: 'a1', role: 'assistant', content: 'Order 4471 is' },
];
const FAILED_ON_CALL: readonly WireMessage[] = [
  { id: 'u1', role: 'user', content: 'Please refund 4471' },
  {
    id: 'a1',
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'call-1', type: 'function', function: { name: 'issue-refund', arguments: '{}' } },
    ],
  },
];

type Rewind = { contextId: string; fromMessageId: string; forgetGrantsFor?: string[] };

/**
 * A stubbed Bureau: its thread, the rewinds it was asked for, and how it answers one. A rewind
 * removes the row and what follows it from the thread, and the run that follows answers with the
 * thread it now holds, as the real one does when it ends.
 */
function bureau(thread: readonly WireMessage[], rewindAnswer: () => Response | undefined) {
  const state = { thread: [...thread], rewinds: [] as Rewind[], bodies: [] as string[] };
  const restore = installFetchImplementation(async (_input, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      method?: string;
      params?: Rewind;
    };
    if (body.method !== 'bureau.contexts.rewind' || body.params === undefined) {
      throw new Error(`Unexpected Bureau call: ${String(body.method)}`);
    }
    state.rewinds.push(body.params);
    const refused = rewindAnswer();
    if (refused !== undefined) return refused;
    const at = state.thread.findIndex((message) => message.id === body.params?.fromMessageId);
    const removed = state.thread.splice(at).map((message) => message.id);
    return Response.json({ jsonrpc: '2.0', id: 1, result: { removed, forgotten: [] } });
  });
  /** The AG-UI door: a start is answered with the new reply and the thread the Bureau holds. */
  const fetchAgUi: Fetcher = async (url, init) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    // The page also reads the chat's last run for why it stopped; this chat has none.
    if (target.endsWith('/jsonrpc')) {
      return Response.json({
        jsonrpc: '2.0',
        id: 'tasks',
        result: { tasks: [], nextPageToken: null },
      });
    }
    if (target.endsWith('/messages')) {
      return Response.json({ threadId: THREAD, messages: state.thread });
    }
    // A thread with nothing going has no run to attach to.
    if (target.includes('/threads/')) {
      return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
    }
    state.bodies.push(typeof init?.body === 'string' ? init.body : '');
    const reply: WireMessage = { id: 'run-2:step:0', role: 'assistant', content: 'Refunded.' };
    const user: WireMessage = { id: 'u2', role: 'user', content: 'Please refund 4471' };
    const held = state.thread.some((message) => message.id === 'u1') ? [] : [user];
    state.thread = [...state.thread, ...held, reply];
    return sse([
      started('run-2'),
      { type: 'TEXT_MESSAGE_START', messageId: reply.id, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: reply.id, delta: 'Refunded.' },
      { type: 'TEXT_MESSAGE_END', messageId: reply.id },
      { type: 'MESSAGES_SNAPSHOT', messages: state.thread },
      { type: 'RUN_FINISHED', threadId: THREAD, runId: 'run-2', outcome: { type: 'success' } },
    ]);
  };
  return { state, fetchAgUi, restore };
}

let sessions: ChatSessionState[] = [];
let restores: (() => void)[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  for (const restore of restores.toReversed()) restore();
  sessions = [];
  restores = [];
});

/** A chat opened on the thread the stubbed Bureau holds. */
function open(
  thread: readonly WireMessage[],
  history: (empty: ConversationHistory) => ConversationHistory,
  rewindAnswer: () => Response | undefined = () => undefined,
) {
  const stub = bureau(thread, rewindAnswer);
  restores.push(stub.restore);
  const session = new ChatSessionState({
    sessionId: THREAD,
    agentName: () => 'assistant',
    fetch: stub.fetchAgUi,
  });
  sessions.push(session);
  session.conversation = history(session.conversation);
  return { session, ...stub };
}

const visibleText = (session: ChatSessionState) =>
  session.conversation.ids.flatMap((id) => {
    const row = session.conversation.messages[id];
    return row === undefined || row.hidden || typeof row.content !== 'string'
      ? []
      : [`${row.role}:${row.content}`];
  });

const toolRows = (session: ChatSessionState) =>
  session.conversation.ids.filter(
    (id) => session.conversation.messages[id]?.toolCall !== undefined,
  );

/** A chat opened on a run that stopped partway: the person's message and the reply that stopped. */
const stopped = (empty: ConversationHistory) =>
  appendMessages(
    empty,
    { id: 'u1', role: 'user', content: 'Please refund 4471' },
    { id: 'a1', role: 'assistant', content: 'Order 4471 is' },
  );

/** A chat opened on a run that stopped on a call of `issue-refund` that has no answer. */
const stoppedOnCall = (empty: ConversationHistory) =>
  appendMessages(
    empty,
    { id: 'u1', role: 'user', content: 'Please refund 4471' },
    {
      id: 'a1',
      role: 'tool-call',
      content: '',
      toolCall: { id: 'call-1', name: 'issue-refund', arguments: { orderId: '4471' } },
    },
  );

describe('running the last turn again', () => {
  test('is offered for a last message that is plain text, once nothing is going', () => {
    expect(open(FAILED_PARTWAY, stopped).session.canRetryTurn).toBe(true);
    expect(open([], (empty) => empty).session.canRetryTurn).toBe(false);
  });

  test('has the Bureau take the turn back out of the thread, then sends the message again over a fresh reply', async () => {
    const { session, state } = open(FAILED_PARTWAY, stopped);

    await session.retryTurn();

    expect(state.rewinds).toEqual([{ contextId: THREAD, fromMessageId: 'u1' }]);
    expect(state.bodies).toHaveLength(1);
    expect(state.bodies[0]).toContain('Please refund 4471');
    expect(state.bodies[0]).not.toContain('Order 4471 is');
    expect(session.failure).toBeUndefined();
  });

  test('keeps nothing of the failed attempt when the run ends with the thread the Bureau holds', async () => {
    const { session, state } = open(FAILED_PARTWAY, stopped);

    await session.retryTurn();

    expect(state.thread.map((message) => message.id)).not.toContain('a1');
    expect(visibleText(session)).toEqual(['user:Please refund 4471', 'assistant:Refunded.']);
  });

  test('keeps nothing of the failed attempt in a chat opened again afterwards', async () => {
    const { session } = open(FAILED_PARTWAY, stopped);
    await session.retryTurn();

    expect(await session.refresh()).toBe(true);

    expect(visibleText(session)).toEqual(['user:Please refund 4471', 'assistant:Refunded.']);
  });

  test('never resumes a call the run was in the middle of, and the interrupted call leaves the transcript for good', async () => {
    const { session, state } = open(FAILED_ON_CALL, stoppedOnCall);

    await session.retryTurn();

    expect(state.bodies[0]).not.toContain('"toolCallId":"call-1"');
    expect(state.bodies[0]).not.toContain('issue-refund');
    expect(toolRows(session)).toEqual([]);
    expect(visibleText(session)).toEqual(['user:Please refund 4471', 'assistant:Refunded.']);
  });

  test('has the Bureau forget the grant of an unanswered call that may change things, so it asks again', async () => {
    const tools = new Map<string, ToolInfo>([
      ['issue-refund', { title: 'Issue refund', tier: 'dangerous' }],
    ]);
    const { session, state } = open(FAILED_ON_CALL, stoppedOnCall);

    await session.retryTurn({ tools });

    expect(state.rewinds).toEqual([
      { contextId: THREAD, fromMessageId: 'u1', forgetGrantsFor: ['issue-refund'] },
    ]);
  });

  test('forgets the grant of a call the catalog does not classify', async () => {
    const { session, state } = open(FAILED_ON_CALL, stoppedOnCall);

    await session.retryTurn();

    expect(state.rewinds[0]?.forgetGrantsFor).toEqual(['issue-refund']);
  });

  test('forgets the grant of no call that only reads', async () => {
    const reads = new Map<string, ToolInfo>([
      ['issue-refund', { title: 'Issue refund', tier: 'read-only' }],
    ]);
    const { session, state } = open(FAILED_ON_CALL, stoppedOnCall);

    await session.retryTurn({ tools: reads });

    expect(state.rewinds[0]?.forgetGrantsFor).toBeUndefined();
  });

  test('sends nothing and keeps the transcript when a run still holds the chat', async () => {
    const { session, state } = open(FAILED_PARTWAY, stopped, () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32000,
          message: 'A run is going',
          data: { weftCode: 'Conflict', httpStatus: 409, reason: 'run-in-progress' },
        },
      }),
    );

    await session.retryTurn();

    expect(state.bodies).toEqual([]);
    expect(session.failure).toBe(CHAT_COPY.stopLine.retryBusy);
    expect(visibleText(session)).toEqual(['user:Please refund 4471', 'assistant:Order 4471 is']);
  });

  test('sends nothing and says so when the Bureau cannot be asked', async () => {
    const { session, state } = open(FAILED_PARTWAY, stopped, () =>
      Response.json(
        { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'down' } },
        { status: 500 },
      ),
    );

    await session.retryTurn();

    expect(state.bodies).toEqual([]);
    expect(session.failure).toBe(CHAT_COPY.stopLine.retryFailed);
    expect(visibleText(session)).toEqual(['user:Please refund 4471', 'assistant:Order 4471 is']);
  });

  test('sends the message again when the Bureau never held it, with nothing to take back', async () => {
    const { session, state } = open([], stopped, () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32000,
          message: 'No message',
          data: { weftCode: 'NotFound', httpStatus: 404, resource: 'message' },
        },
      }),
    );

    await session.retryTurn();

    expect(state.bodies).toHaveLength(1);
    expect(visibleText(session)).toEqual(['user:Please refund 4471', 'assistant:Refunded.']);
  });

  test('is not offered for a message that is not plain text, and sends nothing then', async () => {
    const { session, state } = open([], (empty) =>
      appendMessages(empty, { role: 'user', content: '   ' }),
    );
    expect(session.canRetryTurn).toBe(false);
    await session.retryTurn();
    expect(state.rewinds).toEqual([]);
    expect(state.bodies).toEqual([]);
  });
});
