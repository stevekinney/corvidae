/**
 * One chat session's state over stubbed Bureau requests: what a follow-up sends, what an attach
 * restores, and which approvals the conversation is waiting on.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import type { Fetcher } from '../../lib/bureau-client.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { ChatSessionState } from './chat-session.svelte.ts';

/** The text of a request's JSON body. */
function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('The request had no JSON body.');
  return init.body;
}

const THREAD = 'thread-1';
const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const started = { type: 'RUN_STARTED', threadId: THREAD, runId: 'run-1' };
const finished = {
  type: 'RUN_FINISHED',
  threadId: THREAD,
  runId: 'run-1',
  outcome: { type: 'success' },
};

let restore: (() => void) | undefined;
let sessions: ChatSessionState[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions = [];
  restore?.();
  restore = undefined;
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

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300 && !condition(); attempt += 1) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

describe('a message', () => {
  test('is answered by the agent, and the run’s end leaves the conversation not streaming', async () => {
    const session = open(async () =>
      sse([
        started,
        { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Hello.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
        finished,
      ]),
    );

    await session.controller.adapter.sendMessage({ role: 'user', content: 'Hi' }, []);

    const texts = session.conversation.ids.map((id) => session.conversation.messages[id]?.content);
    expect(texts).toEqual(['Hi', 'Hello.']);
    expect(session.streaming).toBe(false);
    expect(session.failure).toBeUndefined();
  });

  test('that fails leaves the reason for a person to read, and the row failed', async () => {
    const session = open(async () =>
      sse([{ type: 'RUN_ERROR', message: 'The thread is busy.', code: 'THREAD_BUSY' }]),
    );

    await session.controller.adapter
      .sendMessage({ role: 'user', content: 'Hi' }, [])
      .catch(() => undefined);

    expect(session.failure).toBe('The thread is busy.');
  });
});

describe('a follow-up', () => {
  test('goes to the Bureau under the id of its own row, as text, while the run is going', async () => {
    const calls: Array<{
      method: string;
      params: { contextId: string; input: { id: string; payload: string } };
    }> = [];
    restore = installFetchImplementation(async (_input, init) => {
      calls.push(JSON.parse(bodyText(init)));
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { outcome: 'admitted', receipt: { id: 'row', state: 'accepted' } },
      });
    });
    let finish: (() => void) | undefined;
    const open$ = new ReadableStream<Uint8Array>({
      start(controller) {
        const encode = (event: unknown) =>
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        encode(started);
        finish = () => {
          encode(finished);
          controller.close();
        };
      },
    });
    const session = open(
      async () => new Response(open$, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const turn = session.controller.adapter.sendMessage({ role: 'user', content: 'Start' }, []);
    await until(() => session.streaming);

    await session.controller.adapter.sendRunInput?.(THREAD, { role: 'user', content: 'More' }, []);

    const followUpId = session.conversation.ids.find(
      (id) => session.conversation.messages[id]?.content === 'More',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('bureau.contexts.input');
    expect(calls[0]?.params).toEqual({
      contextId: THREAD,
      input: { id: followUpId!, payload: 'More' },
    });
    finish?.();
    await turn;
  });

  test('sends the text of a message made of parts', async () => {
    const calls: Array<{ params: { input: { payload: string } } }> = [];
    restore = installFetchImplementation(async (_input, init) => {
      calls.push(JSON.parse(bodyText(init)));
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { outcome: 'admitted', receipt: { id: 'row', state: 'accepted' } },
      });
    });
    let finish: (() => void) | undefined;
    const open$ = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(started)}\n\n`));
        finish = () => {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finished)}\n\n`));
          controller.close();
        };
      },
    });
    const session = open(
      async () => new Response(open$, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const turn = session.controller.adapter.sendMessage({ role: 'user', content: 'Start' }, []);
    await until(() => session.streaming);

    await session.controller.adapter.sendRunInput?.(
      THREAD,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'One' },
          { type: 'text', text: 'Two' },
        ],
      },
      [],
    );

    expect(calls[0]?.params.input.payload).toBe('One\nTwo');
    finish?.();
    await turn;
  });
});

describe('an attach', () => {
  const snapshot = {
    type: 'MESSAGES_SNAPSHOT',
    messages: [{ id: 'user-1', role: 'user', content: 'Start the work' }],
  };

  test('restores the thread and then carries the run to its end', async () => {
    const session = open(async () =>
      sse([
        started,
        snapshot,
        { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Done.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
        finished,
      ]),
    );

    await session.attach();
    await until(() => !session.streaming && session.conversation.ids.length === 2);

    const texts = session.conversation.ids.map((id) => session.conversation.messages[id]?.content);
    expect(texts).toEqual(['Start the work', 'Done.']);
    expect(session.attaching).toBe(false);
  });

  const messages = [
    { id: 'u1', role: 'user', content: 'An earlier question' },
    { id: 'a1', role: 'assistant', content: 'An earlier answer.' },
  ];

  /** The mount for a thread with no run going: nothing to attach to, and its messages to read. */
  const settledThread =
    (answer: () => Response): Fetcher =>
    async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith('/messages')
        ? answer()
        : sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
    };

  test('restores a finished session’s whole transcript when no run is going', async () => {
    const session = open(settledThread(() => Response.json({ threadId: THREAD, messages })));

    await session.attach();

    const texts = session.conversation.ids.map((id) => session.conversation.messages[id]?.content);
    expect(texts).toEqual(['An earlier question', 'An earlier answer.']);
    expect(session.streaming).toBe(false);
    expect(session.attaching).toBe(false);
  });

  test('leaves an empty conversation for a thread the Bureau has no record of', async () => {
    const session = open(settledThread(() => Response.json({}, { status: 404 })));

    await session.attach();

    expect(session.conversation.ids).toEqual([]);
  });

  test('keeps a row typed while the transcript was being read, behind the rows it restores', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = open(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/messages')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      await held;
      return Response.json({ threadId: THREAD, messages });
    });

    const attaching = slow.attach();
    // A row appears on screen while the Bureau is still being asked.
    slow.conversation = {
      ...slow.conversation,
      ids: ['typed'],
      messages: {
        typed: {
          id: 'typed',
          role: 'user',
          content: 'Typed meanwhile',
          position: 0,
          createdAt: '2026-10-19T00:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      },
    };
    release?.();
    await attaching;

    const texts = slow.conversation.ids.map((id) => slow.conversation.messages[id]?.content);
    expect(texts).toEqual(['An earlier question', 'An earlier answer.', 'Typed meanwhile']);
  });

  test('tells the page when a run it started begins', async () => {
    let begun = 0;
    const session = new ChatSessionState({
      sessionId: THREAD,
      agentName: () => 'assistant',
      fetch: async () => sse([started, finished]),
      onRunStarted: () => {
        begun += 1;
      },
    });
    sessions.push(session);

    await session.controller.adapter.sendMessage({ role: 'user', content: 'Hi' }, []);

    expect(begun).toBe(1);
  });
});

describe('the approvals the conversation waits on', () => {
  test('are none for a conversation with no parked tool call', () => {
    const session = open(async () => sse([]));

    expect(session.approvals).toEqual([]);
  });
});
