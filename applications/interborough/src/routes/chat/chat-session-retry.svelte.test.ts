/**
 * Running the last turn again after a run stopped partway (COR-2014, rows 19r, 19x, 20a, 20b and
 * 20c): `retryTurn` sends the person's message again as a new turn after the failed attempt, which
 * stays on record, in the page and in the thread the Bureau holds (the snapshot that ends the run,
 * and a thread read again). It never resumes a call the run was in the middle of, and a tool that
 * may change things and was interrupted goes back through its approval because its remembered
 * grant is forgotten first (`bureau.contexts.forgetgrants`).
 *
 * The Bureau is stubbed with a thread of its own, which a start adds the rows it lacks to, as the
 * real mount does, and which the stubbed run answers with: a mock stream that ended with no
 * snapshot would pass whether or not the thread still held the rows.
 */
import {
  appendMessages,
  CINDER_NOTES_METADATA_KEY,
  resolveMessageNotes,
  type ConversationHistory,
  type MessageNoteInfo,
} from '@lostgradient/chat';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy/chat.ts';
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

/** What the Bureau holds of the thread: the failed turn's rows, which a retry keeps. */
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
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'issue-refund', arguments: '{"orderId":"4471"}' },
      },
    ],
  },
];

type Forget = { contextId: string; tools: string[] };

/**
 * A stubbed Bureau: its thread, the grants it was asked to forget, the order of what it was asked,
 * and how it answers a forget. A start adds the rows the thread lacks, as the mount does, and the
 * run that follows answers with the thread it now holds, as the real one does when it ends.
 */
function bureau(thread: readonly WireMessage[], forgetAnswer: () => Response | undefined) {
  const state = {
    thread: [...thread],
    forgets: [] as Forget[],
    bodies: [] as string[],
    order: [] as string[],
  };
  const restore = installFetchImplementation(async (_input, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      method?: string;
      params?: Forget;
    };
    if (body.method !== 'bureau.contexts.forgetgrants' || body.params === undefined) {
      throw new Error(`Unexpected Bureau call: ${String(body.method)}`);
    }
    state.forgets.push(body.params);
    state.order.push('forget');
    const refused = forgetAnswer();
    if (refused !== undefined) return refused;
    return Response.json({ jsonrpc: '2.0', id: 1, result: { forgotten: [] } });
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
    const sent = typeof init?.body === 'string' ? init.body : '';
    state.bodies.push(sent);
    state.order.push('start');
    // The rows the start sends that the thread does not hold yet: the person's new message.
    const held = new Set(state.thread.map((message) => message.id));
    const added = ((JSON.parse(sent) as { messages?: WireMessage[] }).messages ?? []).filter(
      (message) => !held.has(message.id) && message['role'] === 'user',
    );
    const reply: WireMessage = { id: 'run-2:step:0', role: 'assistant', content: 'Refunded.' };
    state.thread = [...state.thread, ...added, reply];
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
  forgetAnswer: () => Response | undefined = () => undefined,
) {
  const stub = bureau(thread, forgetAnswer);
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

/**
 * A chat opened on a run that finished a refund and then stopped on a read-only lookup: the
 * refund's call has its result, the lookup has none.
 */
const stoppedAfterRefund = (empty: ConversationHistory) =>
  appendMessages(
    empty,
    { id: 'u0', role: 'user', content: 'Earlier question' },
    {
      id: 'c0',
      role: 'tool-call',
      content: '',
      toolCall: { id: 'call-0', name: 'issue-credit', arguments: { orderId: '1' } },
    },
    {
      id: 'r0',
      role: 'tool-result',
      content: '',
      toolResult: { callId: 'call-0', outcome: 'success', content: {} },
    },
    { id: 'u1', role: 'user', content: 'Please refund 4471' },
    {
      id: 'c1',
      role: 'tool-call',
      content: '',
      toolCall: { id: 'call-1', name: 'issue-refund', arguments: { orderId: '4471' } },
    },
    {
      id: 'r1',
      role: 'tool-result',
      content: '',
      toolResult: { callId: 'call-1', outcome: 'success', content: {} },
    },
    {
      id: 'c2',
      role: 'tool-call',
      content: '',
      toolCall: { id: 'call-2', name: 'lookup-order', arguments: { orderId: '4471' } },
    },
  );

const REFUND_THEN_LOOKUP = new Map<string, ToolInfo>([
  ['issue-credit', { title: 'Issue credit', tier: 'dangerous' }],
  ['issue-refund', { title: 'Issue refund', tier: 'dangerous' }],
  ['lookup-order', { title: 'Lookup order', tier: 'read-only' }],
]);

/** The text of the visible rows, the failed attempt's included. */
const BOTH_ATTEMPTS = [
  'user:Please refund 4471',
  'assistant:Order 4471 is',
  'user:Please refund 4471',
  'assistant:Refunded.',
];

describe('running the last turn again', () => {
  test('is offered for a last message that is plain text, once nothing is going', () => {
    expect(open(FAILED_PARTWAY, stopped).session.canRetryTurn).toBe(true);
    expect(open([], (empty) => empty).session.canRetryTurn).toBe(false);
  });

  test('sends the message again as a new turn over a thread that still holds the failed attempt', async () => {
    const { session, state } = open(FAILED_PARTWAY, stopped);

    await session.retryTurn();

    // A reply that stopped with no call under way has no grant to forget.
    expect(state.forgets).toEqual([]);
    expect(state.bodies).toHaveLength(1);
    expect(state.bodies[0]).toContain('Please refund 4471');
    expect(state.bodies[0]).toContain('Order 4471 is');
    expect(session.failure).toBeUndefined();
  });

  test('keeps the failed attempt when the run ends with the thread the Bureau holds', async () => {
    const { session, state } = open(FAILED_PARTWAY, stopped);

    await session.retryTurn();

    expect(state.thread.map((message) => message.id).slice(0, 2)).toEqual(['u1', 'a1']);
    expect(state.thread).toHaveLength(4);
    expect(visibleText(session)).toEqual(BOTH_ATTEMPTS);
  });

  test('keeps the failed attempt in a chat opened again afterwards', async () => {
    const { session } = open(FAILED_PARTWAY, stopped);
    await session.retryTurn();

    expect(await session.refresh()).toBe(true);

    expect(visibleText(session)).toEqual(BOTH_ATTEMPTS);
  });

  test('never resumes a call the run was in the middle of, and the interrupted call stays on record', async () => {
    const { session, state } = open(FAILED_ON_CALL, stoppedOnCall);

    await session.retryTurn();

    expect(state.bodies[0]).not.toContain('"resume"');
    expect(toolRows(session)).toEqual(['a1']);
    expect(visibleText(session)).toEqual([
      'user:Please refund 4471',
      'tool-call:',
      'user:Please refund 4471',
      'assistant:Refunded.',
    ]);
  });

  test('keeps the failed attempt’s status line on its row through the run’s snapshot and a thread read again', async () => {
    const line: MessageNoteInfo = {
      kind: 'stopped',
      id: 'stopped:task-1',
      reason: 'The model provider dropped the connection.',
      failed: true,
    };
    const { session } = open(FAILED_ON_CALL, (empty) => {
      const history = stoppedOnCall(empty);
      const row = history.messages['a1']!;
      return {
        ...history,
        messages: {
          ...history.messages,
          a1: { ...row, metadata: { ...row.metadata, [CINDER_NOTES_METADATA_KEY]: [line] } },
        },
      };
    });

    await session.retryTurn();
    expect(resolveMessageNotes(session.conversation.messages['a1']!)).toEqual([line]);

    expect(await session.refresh()).toBe(true);
    expect(resolveMessageNotes(session.conversation.messages['a1']!)).toEqual([line]);
  });

  test('has the Bureau forget the grant of an unanswered call that may change things before the turn is sent, so it asks again', async () => {
    const tools = new Map<string, ToolInfo>([
      ['issue-refund', { title: 'Issue refund', tier: 'dangerous' }],
    ]);
    const { session, state } = open(FAILED_ON_CALL, stoppedOnCall);

    await session.retryTurn({ tools });

    expect(state.forgets).toEqual([{ contextId: THREAD, tools: ['issue-refund'] }]);
    expect(state.order).toEqual(['forget', 'start']);
  });

  test('keeps the grant of a changing call that finished in the failed turn, whose result is on record', async () => {
    const { session, state } = open(FAILED_PARTWAY, stoppedAfterRefund);

    expect(session.interruptedCallsThatMayChange(REFUND_THEN_LOOKUP)).toEqual([]);

    await session.retryTurn({ tools: REFUND_THEN_LOOKUP });

    expect(state.forgets).toEqual([]);
    expect(state.bodies).toHaveLength(1);
  });

  test('forgets the grant of an interrupted call the catalog does not classify', async () => {
    const { session, state } = open(FAILED_ON_CALL, stoppedOnCall);

    await session.retryTurn();

    expect(state.forgets[0]?.tools).toEqual(['issue-refund']);
  });

  test('forgets the grant of no call that only reads', async () => {
    const reads = new Map<string, ToolInfo>([
      ['issue-refund', { title: 'Issue refund', tier: 'read-only' }],
    ]);
    const { session, state } = open(FAILED_ON_CALL, stoppedOnCall);

    await session.retryTurn({ tools: reads });

    expect(state.forgets).toEqual([]);
    expect(state.bodies).toHaveLength(1);
  });

  test('sends nothing and says so when the grant cannot be forgotten', async () => {
    const { session, state } = open(FAILED_ON_CALL, stoppedOnCall, () =>
      Response.json(
        { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'down' } },
        { status: 500 },
      ),
    );

    await session.retryTurn();

    expect(state.bodies).toEqual([]);
    expect(session.failure).toBe(CHAT_COPY.stopLine.retryFailed);
    expect(visibleText(session)).toEqual(['user:Please refund 4471', 'tool-call:']);
    expect(toolRows(session)).toEqual(['a1']);
  });

  test('is not offered for a message that is not plain text, and sends nothing then', async () => {
    const { session, state } = open([], (empty) =>
      appendMessages(empty, { role: 'user', content: '   ' }),
    );
    expect(session.canRetryTurn).toBe(false);
    await session.retryTurn();
    expect(state.forgets).toEqual([]);
    expect(state.bodies).toEqual([]);
  });
});
