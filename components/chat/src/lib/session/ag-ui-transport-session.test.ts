import type { Message as AGUIMessage } from '@ag-ui/core';
import { describe, expect, test } from 'bun:test';
import { toAGUIMessages } from 'conversationalist';
import { createConversationHistory } from '../components/chat/builders.ts';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import { AGUIChatTransportError } from './ag-ui-transport-error.ts';
import { createAGUIChatTransport } from './ag-ui-transport.ts';
import weatherRun from './fixtures/ag-ui-weather-run.json';
import { rolesOf } from './session-controller-frame-test-support.ts';
import {
  ChatRunFailureError,
  type ChatSessionHooks,
  type ChatSessionRequest,
} from './session-controller-support.ts';
import { createChatSessionController } from './session-controller.ts';

async function* asyncEvents(events: readonly unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event;
}

function createSession(
  openStream: (request: ChatSessionRequest) => AsyncIterable<unknown> | Iterable<unknown>,
  hooks: ChatSessionHooks = {},
) {
  let conversation: ConversationHistory = createConversationHistory({ id: 'ag-ui-session' });
  const requests: ChatSessionRequest[] = [];
  const errors: unknown[] = [];
  const controller = createChatSessionController({
    executionOwner: 'server',
    getConversation: () => conversation,
    setConversation: (next) => {
      conversation = next;
    },
    hooks: { ...hooks, onError: (error) => errors.push(error) },
    transport: createAGUIChatTransport((request) => {
      requests.push(request);
      return openStream(request);
    }),
  });
  return {
    controller,
    requests,
    errors,
    get conversation() {
      return conversation;
    },
  };
}

function contents(conversation: ConversationHistory): unknown[] {
  return conversation.ids.map((id) => conversation.messages[id]?.content);
}

describe('driving a chat session from an AG-UI stream', () => {
  test('completes a transcript from a hand-written AG-UI 1.0 run', async () => {
    const results: unknown[] = [];
    const session = createSession(() => weatherRun, {
      onToolResult: (result) => results.push(result),
    });
    await session.controller.adapter.sendMessage(
      { role: 'user', content: 'What is the weather in Brooklyn?' },
      [],
    );

    expect(session.errors).toEqual([]);
    expect(session.requests).toHaveLength(1);
    expect(rolesOf(session.conversation)).toEqual([
      'user',
      'assistant',
      'tool-call',
      'tool-result',
      'assistant',
    ]);
    const [user, thinking, call, result, answer] = contents(session.conversation);
    expect(user).toBe('What is the weather in Brooklyn?');
    expect(thinking).toEqual([
      {
        type: 'thinking',
        thinking: 'The user wants the weather, so I should call the weather tool.',
        signature: '',
      },
      { type: 'text', text: 'Let me check the weather.' },
    ]);
    expect(answer).toBe('It is sunny and 72F in Brooklyn.');
    expect(call).toBe('');
    expect(result).toBe('');
    const rows = session.conversation.ids.map((id) => session.conversation.messages[id]);
    expect(rows[2]?.toolCall).toEqual({
      id: 'call-1',
      name: 'get_weather',
      arguments: { city: 'Brooklyn' },
    });
    expect(rows[3]?.toolResult).toMatchObject({
      callId: 'call-1',
      outcome: 'success',
      content: 'Sunny, 72F',
    });
    expect(results).toHaveLength(1);
    expect(rows.every((row) => row?.metadata['_streaming'] !== true)).toBe(true);
  });

  test('takes the events from an async source as well', async () => {
    const session = createSession(() => asyncEvents(weatherRun));
    await session.controller.adapter.sendMessage({ role: 'user', content: 'Weather?' }, []);
    expect(session.errors).toEqual([]);
    expect(rolesOf(session.conversation)).toHaveLength(5);
  });

  test('hands the backend the turn it is answering', async () => {
    const session = createSession(() => weatherRun);
    await session.controller.adapter.sendMessage({ role: 'user', content: 'Weather?' }, []);
    expect(session.requests[0]?.turn).toBe(1);
    expect(rolesOf(session.requests[0]?.conversation ?? createConversationHistory())).toEqual([
      'user',
    ]);
  });

  test('surfaces a RUN_ERROR as a failed run', async () => {
    const session = createSession(() => [
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      { type: 'RUN_ERROR', message: 'Backend unavailable', code: 'UNAVAILABLE' },
    ]);
    const rejection = await session.controller.adapter
      .sendMessage({ role: 'user', content: 'Hi' }, [])
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ChatRunFailureError);
    expect(rejection).toMatchObject({ message: 'Backend unavailable' });
    expect(session.errors).toHaveLength(1);
  });

  test('fails the run with a typed error when an event is invalid', async () => {
    const session = createSession(() => [
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      { type: 'TEXT_MESSAGE_START' },
    ]);
    const rejection = await session.controller.adapter
      .sendMessage({ role: 'user', content: 'Hi' }, [])
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(AGUIChatTransportError);
    expect(rejection).toMatchObject({ kind: 'invalid-event', eventIndex: 1 });
    expect(session.errors).toEqual([rejection]);
  });

  test('reports a cancelled run through onRunAborted', async () => {
    const aborted: unknown[] = [];
    const session = createSession(
      () => [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'cancelled' } },
      ],
      { onRunAborted: (notice) => aborted.push(notice) },
    );
    await session.controller.adapter.sendMessage({ role: 'user', content: 'Hi' }, []);
    expect(aborted).toEqual([{ reason: 'cancelled' }]);
  });

  test('keeps the wire message id of the assistant row after run.completed', async () => {
    const session = createSession(() => [
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      { type: 'TEXT_MESSAGE_START', messageId: 'wire-assistant-1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'wire-assistant-1', delta: 'Hello.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'wire-assistant-1' },
      { type: 'RUN_FINISHED', threadId: 't', runId: 'r' },
    ]);
    await session.controller.adapter.sendMessage({ role: 'user', content: 'Hi' }, []);
    expect(session.errors).toEqual([]);
    expect(session.conversation.ids).toHaveLength(2);
    expect(session.conversation.ids[1]).toBe('wire-assistant-1');
    expect(session.conversation.messages['wire-assistant-1']?.content).toBe('Hello.');
  });

  test('merges a whole-thread snapshot by id instead of duplicating the rows on screen', async () => {
    const reply = (id: string, text: string) => [
      { type: 'TEXT_MESSAGE_START', messageId: id },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text },
      { type: 'TEXT_MESSAGE_END', messageId: id },
    ];
    let turn = 0;
    const session = createSession((request) => {
      turn += 1;
      return turn === 1
        ? [
            { type: 'RUN_STARTED', threadId: 't', runId: 'r1' },
            ...reply('a1', 'answer 1'),
            { type: 'RUN_FINISHED', threadId: 't', runId: 'r1' },
          ]
        : [
            { type: 'RUN_STARTED', threadId: 't', runId: 'r2' },
            // The standard backend behaviour: the whole thread, as the run input carried it.
            { type: 'MESSAGES_SNAPSHOT', messages: toAGUIMessages(request.conversation) },
            ...reply('a2', 'answer 2'),
            { type: 'RUN_FINISHED', threadId: 't', runId: 'r2' },
          ];
    });
    await session.controller.adapter.sendMessage({ role: 'user', content: 'question 1' }, []);
    await session.controller.adapter.sendMessage({ role: 'user', content: 'question 2' }, []);

    expect(session.errors).toEqual([]);
    expect(rolesOf(session.conversation)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(contents(session.conversation)).toEqual([
      'question 1',
      'answer 1',
      'question 2',
      'answer 2',
    ]);
    expect(session.conversation.ids[1]).toBe('a1');
    expect(session.conversation.ids[3]).toBe('a2');
  });

  test('stops mid-stream without reporting an error and settles the row it was streaming', async () => {
    let reached = (): void => undefined;
    const streaming = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const session = createSession((request) =>
      (async function* () {
        yield { type: 'RUN_STARTED', threadId: 't', runId: 'r' };
        yield { type: 'TEXT_MESSAGE_START', messageId: 'a1' };
        yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'partial' };
        reached();
        // Nothing more arrives until the session stops asking.
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      })(),
    );
    const sent = session.controller.adapter.sendMessage({ role: 'user', content: 'Hi' }, []);
    await streaming;
    await session.controller.stop();
    await sent;

    expect(session.errors).toEqual([]);
    expect(rolesOf(session.conversation)).toEqual(['user', 'assistant']);
    const rows = session.conversation.ids.map((id) => session.conversation.messages[id]);
    expect(rows[1]?.content).toBe('partial');
    expect(rows.every((row) => row?.metadata['_streaming'] !== true)).toBe(true);
  });

  describe('tool call identity across a backend snapshot of the same thread', () => {
    const textMessage = (id: string, text: string) => [
      { type: 'TEXT_MESSAGE_START', messageId: id },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text },
      { type: 'TEXT_MESSAGE_END', messageId: id },
    ];
    const toolCall = (parentMessageId?: string) => [
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'c1',
        toolCallName: 'lookup',
        ...(parentMessageId === undefined ? {} : { parentMessageId }),
      },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"q":1}' },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
      { type: 'TOOL_CALL_RESULT', messageId: 'c1-result', toolCallId: 'c1', content: 'found' },
    ];

    /**
     * Turn 1 streams `first`; turn 2 opens with the thread as the backend
     * stores it: the client's own messages as the run input carried them, and
     * the backend's assistant message holding the call.
     */
    async function twoTurns(first: unknown[], backendAssistant: AGUIMessage) {
      let turn = 0;
      const session = createSession((request) => {
        turn += 1;
        if (turn === 1)
          return [
            { type: 'RUN_STARTED', threadId: 't', runId: 'r1' },
            ...first,
            ...textMessage('a1', 'answer 1'),
            { type: 'RUN_FINISHED', threadId: 't', runId: 'r1' },
          ];
        const [question1] = toAGUIMessages(request.conversation);
        const client = toAGUIMessages(request.conversation);
        return [
          { type: 'RUN_STARTED', threadId: 't', runId: 'r2' },
          {
            type: 'MESSAGES_SNAPSHOT',
            messages: [
              question1,
              backendAssistant,
              { id: 'c1-result', role: 'tool', toolCallId: 'c1', content: 'found' },
              { id: 'a1', role: 'assistant', content: 'answer 1' },
              client.at(-1),
            ],
          },
          ...textMessage('a2', 'answer 2'),
          { type: 'RUN_FINISHED', threadId: 't', runId: 'r2' },
        ];
      });
      await session.controller.adapter.sendMessage({ role: 'user', content: 'question 1' }, []);
      const afterFirst = [...session.conversation.ids];
      await session.controller.adapter.sendMessage({ role: 'user', content: 'question 2' }, []);
      return { session, afterFirst };
    }

    const call = {
      id: 'c1',
      type: 'function' as const,
      function: { name: 'lookup', arguments: '{"q":1}' },
    };
    const toolRows = (conversation: ConversationHistory) =>
      conversation.ids.filter((id) => conversation.messages[id]?.toolCall !== undefined);

    async function expectMerged(
      first: unknown[],
      backendAssistant: AGUIMessage,
      expectedAfterFirst: string[],
    ) {
      const { session, afterFirst } = await twoTurns(first, backendAssistant);
      expect(session.errors).toEqual([]);
      expect(afterFirst.slice(1)).toEqual(expectedAfterFirst);
      expect(toolRows(session.conversation)).toHaveLength(1);
      expect(rolesOf(session.conversation)).toEqual([
        'user',
        ...expectedAfterFirst.map((id) => session.conversation.messages[id]?.role ?? 'missing'),
        'user',
        'assistant',
      ]);
      expect(contents(session.conversation).at(-1)).toBe('answer 2');
      expect(session.conversation.ids).toHaveLength(afterFirst.length + 2);
    }

    test('a call that names no parent', async () => {
      await expectMerged(toolCall(), { id: 'm1', role: 'assistant', toolCalls: [call] }, [
        'c1:message',
        'c1-result',
        'a1',
      ]);
    });

    test('a call whose parent streamed text first', async () => {
      await expectMerged(
        [...textMessage('m1', 'Let me look.'), ...toolCall('m1')],
        { id: 'm1', role: 'assistant', content: 'Let me look.', toolCalls: [call] },
        ['m1', 'm1:call:c1', 'c1-result', 'a1'],
      );
    });

    test('a call whose parent never streamed text', async () => {
      await expectMerged(toolCall('m1'), { id: 'm1', role: 'assistant', toolCalls: [call] }, [
        'm1',
        'c1-result',
        'a1',
      ]);
    });

    test('a call that follows reasoning and names a parent that never streamed text', async () => {
      await expectMerged(
        [
          { type: 'REASONING_START', messageId: 'span-1' },
          { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' },
          { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'hmm' },
          { type: 'REASONING_MESSAGE_END', messageId: 'r1' },
          { type: 'REASONING_END', messageId: 'span-1' },
          ...toolCall('m1'),
        ],
        { id: 'm1', role: 'assistant', toolCalls: [call] },
        ['m1', 'm1:call:c1', 'c1-result', 'a1'],
      );
    });

    test('a call that ends before its parent message does', async () => {
      await expectMerged(
        [
          { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Let me ' },
          ...toolCall('m1').slice(0, 3),
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'look.' },
          { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
          toolCall('m1')[3],
        ],
        { id: 'm1', role: 'assistant', content: 'Let me look.', toolCalls: [call] },
        ['m1', 'm1:call:c1', 'c1-result', 'a1'],
      );
    });

    test('a call that ends before its parent message has started', async () => {
      await expectMerged(
        [...toolCall('m1'), ...textMessage('m1', 'Looked.')],
        { id: 'm1', role: 'assistant', content: 'Looked.', toolCalls: [call] },
        ['m1', 'm1:call:c1', 'c1-result', 'a1'],
      );
    });
  });

  describe('a backend snapshot under its own ids, with the client holding a thread', () => {
    const run = (messages: unknown[] | undefined, streamReply: boolean) => [
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      ...(messages === undefined ? [] : [{ type: 'MESSAGES_SNAPSHOT', messages }]),
      ...(streamReply
        ? [
            { type: 'TEXT_MESSAGE_START', messageId: 'streamed-1' },
            { type: 'TEXT_MESSAGE_CONTENT', messageId: 'streamed-1', delta: 'the reply' },
            { type: 'TEXT_MESSAGE_END', messageId: 'streamed-1' },
          ]
        : []),
      { type: 'RUN_FINISHED', threadId: 't', runId: 'r' },
    ];

    /** A first turn that echoes nothing, then the scenario's second turn. */
    async function secondTurn(second: (request: ChatSessionRequest) => unknown[]) {
      let turn = 0;
      const session = createSession((request) => {
        turn += 1;
        return turn === 1
          ? [
              { type: 'RUN_STARTED', threadId: 't', runId: 'r1' },
              { type: 'TEXT_MESSAGE_START', messageId: 'a1' },
              { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'answer 1' },
              { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
              { type: 'RUN_FINISHED', threadId: 't', runId: 'r1' },
            ]
          : second(request);
      });
      await session.controller.adapter.sendMessage({ role: 'user', content: 'question 1' }, []);
      await session.controller.adapter.sendMessage({ role: 'user', content: 'question 2' }, []);
      expect(session.errors).toEqual([]);
      return session;
    }

    test('a snapshot of only what the producer owns keeps its reply', async () => {
      const session = await secondTurn(() =>
        run([{ id: 'reply-1', role: 'assistant', content: 'the reply' }], false),
      );
      expect(contents(session.conversation)).toEqual([
        'question 1',
        'answer 1',
        'question 2',
        'the reply',
      ]);
      expect(session.conversation.ids[3]).toBe('reply-1');
    });

    test("a whole thread under the backend's own ids keeps the reply and not the history again", async () => {
      const session = await secondTurn(() =>
        run(
          [
            { id: 'b-u1', role: 'user', content: 'question 1' },
            { id: 'b-a1', role: 'assistant', content: 'answer 1' },
            { id: 'b-u2', role: 'user', content: 'question 2' },
            { id: 'reply-1', role: 'assistant', content: 'the reply' },
          ],
          false,
        ),
      );
      expect(contents(session.conversation)).toEqual([
        'question 1',
        'answer 1',
        'question 2',
        'the reply',
      ]);
    });

    test('the reply is not added twice when the run also streamed it under the same id', async () => {
      const session = await secondTurn(() =>
        run(
          [
            { id: 'b-u2', role: 'user', content: 'question 2' },
            { id: 'streamed-1', role: 'assistant', content: 'the reply' },
          ],
          true,
        ),
      );
      expect(contents(session.conversation)).toEqual([
        'question 1',
        'answer 1',
        'question 2',
        'the reply',
      ]);
    });

    test('a backend that echoes the client ids is unchanged', async () => {
      const session = await secondTurn((request) =>
        run(toAGUIMessages(request.conversation), true),
      );
      expect(contents(session.conversation)).toEqual([
        'question 1',
        'answer 1',
        'question 2',
        'the reply',
      ]);
      expect(session.conversation.ids[3]).toBe('streamed-1');
    });

    test('a backend that sends no snapshot keeps what it streamed', async () => {
      const session = await secondTurn(() => run(undefined, true));
      expect(contents(session.conversation)).toHaveLength(4);
    });
  });

  test('a snapshot holding a still-open message that already made a call and got its result is valid', async () => {
    const call = {
      id: 'c1',
      type: 'function' as const,
      function: { name: 'lookup', arguments: '{}' },
    };
    const session = createSession((request) => {
      const [question] = toAGUIMessages(request.conversation);
      return [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Let me ' },
        {
          type: 'TOOL_CALL_START',
          toolCallId: 'c1',
          toolCallName: 'lookup',
          parentMessageId: 'm1',
        },
        { type: 'TOOL_CALL_END', toolCallId: 'c1' },
        { type: 'TOOL_CALL_RESULT', messageId: 'c1-result', toolCallId: 'c1', content: 'found' },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [
            question,
            { id: 'm1', role: 'assistant', content: 'Let me ', toolCalls: [call] },
            { id: 'c1-result', role: 'tool', toolCallId: 'c1', content: 'found' },
          ],
        },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'look.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r' },
      ];
    });
    await session.controller.adapter.sendMessage({ role: 'user', content: 'question' }, []);
    expect(session.errors).toEqual([]);
    expect(session.conversation.ids.slice(1)).toEqual(['m1', 'm1:call:c1', 'c1-result']);
    expect(session.conversation.messages['m1']?.content).toBe('Let me look.');
  });
});
