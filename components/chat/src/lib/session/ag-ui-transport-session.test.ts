import { describe, expect, test } from 'bun:test';
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
  test('completes a transcript from a recorded AG-UI 1.0 run', async () => {
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
    expect(rejection).toMatchObject({ message: 'Backend unavailable (UNAVAILABLE)' });
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
});
