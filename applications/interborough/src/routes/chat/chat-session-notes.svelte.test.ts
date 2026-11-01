/**
 * The lines a run leaves under a chat's messages, on a session: stamped when the turn ends, kept
 * when the thread is read again, and said again by a reloaded thread (the memory it stored and why
 * its last run stopped).
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { appendMessages } from '@lostgradient/chat';

import type { Fetcher } from '../../lib/bureau-client.ts';
import { ChatSessionState } from './chat-session.svelte.ts';

const THREAD = 'thread-1';
const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const started = { type: 'RUN_STARTED', threadId: THREAD, runId: 'run-1' };
const reply = [
  { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Noted.' },
  { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
];
const wakeup = {
  type: 'CUSTOM',
  name: 'bureau.wakeup-scheduled',
  value: { runId: 'native', duration: '6h', wakeAt: 1_900_000_000_000 },
};

let sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions = [];
});

function open(fetchAgUi: Fetcher): ChatSessionState {
  const session = new ChatSessionState({
    sessionId: THREAD,
    agentName: () => 'assistant',
    fetch: fetchAgUi,
  });
  sessions.push(session);
  return session;
}

function notesOn(session: ChatSessionState, id: string): unknown {
  return session.conversation.messages[id]?.metadata?.['cinder:notes'];
}

const url = (input: Parameters<Fetcher>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

describe('a turn that ends in an error', () => {
  const erroring = () =>
    open(async () =>
      sse([
        started,
        ...reply,
        wakeup,
        { type: 'RUN_ERROR', message: 'Budget exceeded: max calls 1', code: 'BUDGET_EXCEEDED' },
      ]),
    );

  test('puts the line under the person’s own message, since its partial reply was taken back', async () => {
    const session = erroring();

    await session.controller.adapter
      .sendMessage({ role: 'user', content: 'Hi' }, [])
      .catch(() => undefined);

    expect(session.failure).toContain('Budget exceeded');
    expect(session.conversation.ids.map((id) => notesOn(session, id))).toMatchObject([
      [{ kind: 'wakeup' }],
    ]);
  });

  test('never puts the line under the reply of the turn before', async () => {
    const session = erroring();
    session.conversation = appendMessages(
      session.conversation,
      { id: 'earlier-user', role: 'user', content: 'First' },
      { id: 'earlier', role: 'assistant', content: 'An earlier reply.' },
    );

    await session.controller.adapter
      .sendMessage({ role: 'user', content: 'Hi' }, [])
      .catch(() => undefined);

    expect(notesOn(session, 'earlier')).toBeUndefined();
    expect(session.conversation.ids.at(-1)).not.toBe('earlier');
    const last = session.conversation.ids.at(-1) ?? '';
    expect(notesOn(session, last)).toMatchObject([{ kind: 'wakeup' }]);
  });
});

describe('a child run that settles in a later turn than the one it started in', () => {
  test('changes the line the page already holds, which the merge keeps over the terminal’s copy', async () => {
    const session = open(async () =>
      sse([
        started,
        ...reply,
        {
          type: 'CUSTOM',
          name: 'bureau.child-run-settled',
          value: { childRunId: 'child-1', status: 'failed' },
        },
        { ...started, type: 'RUN_FINISHED', outcome: { type: 'success' } },
      ]),
    );
    session.conversation = appendMessages(
      session.conversation,
      { id: 'earlier-user', role: 'user', content: 'First' },
      {
        id: 'earlier',
        role: 'assistant',
        content: 'Handing it off.',
        metadata: {
          'cinder:notes': [
            {
              kind: 'child-run',
              id: 'child:child-1',
              childRunId: 'child-1',
              agentName: 'researcher',
              status: 'running',
              href: '/runs/child-1',
            },
          ],
        },
      },
    );

    await session.controller.adapter.sendMessage({ role: 'user', content: 'And now?' }, []);

    expect(notesOn(session, 'earlier')).toMatchObject([{ kind: 'child-run', status: 'failed' }]);
    expect(notesOn(session, 'reply')).toBeUndefined();
  });
});

describe('a thread read again', () => {
  const settled =
    (messages: unknown[], tasks: unknown[]): Fetcher =>
    async (input) => {
      const address = url(input);
      if (address.endsWith('/messages')) return Response.json({ threadId: THREAD, messages });
      if (address.endsWith('/jsonrpc')) {
        return Response.json({ jsonrpc: '2.0', id: 'x', result: { tasks, nextPageToken: null } });
      }
      return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
    };

  test('says why its last run stopped when the page opens on it', async () => {
    const session = open(
      settled(
        [
          { id: 'u1', role: 'user', content: 'Look it up' },
          { id: 'a1', role: 'assistant', content: 'Looking.' },
        ],
        [
          {
            id: 'task-1',
            contextId: THREAD,
            agentName: 'assistant',
            owner: 'owner',
            actor: null,
            kind: 'chat',
            origin: { kind: 'chat' },
            status: 'failed',
            finishReason: 'budget-exceeded',
            statusMessage: 'Budget exceeded: max calls 1',
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-01T00:00:01.000Z',
            cleanup: null,
            openWaits: [],
          },
        ],
      ),
    );

    await session.attach();

    expect(notesOn(session, 'a1')).toEqual([
      { kind: 'stopped', id: 'stopped', reason: 'Budget exceeded: max calls 1' },
    ]);
  });

  test('keeps the wakeup the page was told of, which the thread does not hold', async () => {
    let tasks = 0;
    const session = open(async (input, init) => {
      const address = url(input);
      if (address.endsWith('/messages')) {
        return Response.json({
          threadId: THREAD,
          messages: [
            { id: 'u1', role: 'user', content: 'Hi' },
            { id: 'reply', role: 'assistant', content: 'Noted.' },
          ],
        });
      }
      if (address.endsWith('/jsonrpc')) {
        tasks += 1;
        return Response.json({
          jsonrpc: '2.0',
          id: 'x',
          result: { tasks: [], nextPageToken: null },
        });
      }
      if (init?.method === 'POST')
        return sse([
          started,
          ...reply,
          wakeup,
          { ...started, type: 'RUN_FINISHED', outcome: { type: 'success' } },
        ]);
      return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
    });
    await session.controller.adapter.sendMessage({ role: 'user', content: 'Hi' }, []);
    expect(notesOn(session, 'reply')).toHaveLength(1);

    await session.refresh();

    expect(tasks).toBeGreaterThan(0);
    expect(notesOn(session, 'reply')).toMatchObject([{ kind: 'wakeup' }]);
  });
});

describe('a run that only called a tool', () => {
  test('puts a wakeup on a row the run owns, not the previous turn’s reply', async () => {
    const session = open(async () =>
      sse([
        started,
        {
          type: 'TOOL_CALL_START',
          toolCallId: 'call-1',
          toolCallName: 'wait',
          parentMessageId: 'step-1',
        },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', delta: '{}' },
        { type: 'TOOL_CALL_END', toolCallId: 'call-1' },
        {
          type: 'TOOL_CALL_RESULT',
          messageId: 'result-1',
          toolCallId: 'call-1',
          content: 'scheduled',
          role: 'tool',
        },
        wakeup,
        { ...started, type: 'RUN_FINISHED', outcome: { type: 'success' } },
      ]),
    );
    session.conversation = appendMessages(
      session.conversation,
      { id: 'earlier-user', role: 'user', content: 'First' },
      { id: 'earlier', role: 'assistant', content: 'An earlier reply.' },
    );

    await session.controller.adapter.sendMessage({ role: 'user', content: 'Wait a while' }, []);

    // The run made no reply, so the line goes with the tool row it made (shown as a group), and the
    // previous turn's reply, which the merge would not keep it on, has none.
    expect(notesOn(session, 'step-1')).toMatchObject([{ kind: 'wakeup' }]);
    expect(notesOn(session, 'earlier')).toBeUndefined();
  });
});
