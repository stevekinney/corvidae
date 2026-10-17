import { MessageSchema, MessagesSnapshotEventSchema } from '@ag-ui/core/schemas';
import { describe, expect, it } from 'bun:test';

import { agUiConversationAdapter } from '../src/adapters/ag-ui';
import { AGUIMappingError } from '../src/adapters/ag-ui/errors';
import {
  appendAGUIMessages,
  fromAGUIMessages,
  fromAGUIToolMessage,
} from '../src/adapters/ag-ui/inbound';
import { toAGUIMessages } from '../src/adapters/ag-ui/outbound';
import type { AGUIMessage } from '../src/adapters/ag-ui/types';
import { appendMessages, createConversationHistory } from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import type { MessageInput } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';
import { testEnvironment } from './adapter-test-fixtures';

function build(...inputs: MessageInput[]) {
  return appendMessages(
    createConversationHistory({ id: 'ag-ui' }, testEnvironment),
    ...inputs,
    testEnvironment,
  );
}

function roundTrip(conversation: ReturnType<typeof build>) {
  return fromAGUIMessages(toAGUIMessages(conversation));
}

/** The fields a round trip must preserve; ids and timestamps are minted locally. */
function essentials(conversation: ReturnType<typeof build>) {
  return getOrderedMessages(conversation).map((message) => ({
    role: message.role,
    content: message.content,
    metadata: message.metadata,
    toolCall: message.toolCall,
    toolResult: message.toolResult,
  }));
}

function expectValidSnapshot(messages: AGUIMessage[]): void {
  for (const message of messages) {
    expect(MessageSchema.safeParse(message).success).toBe(true);
  }
  const event = { type: 'MESSAGES_SNAPSHOT', messages };
  expect(MessagesSnapshotEventSchema.safeParse(event).success).toBe(true);
}

describe('AG-UI adapter: roles', () => {
  it('round-trips a user message', () => {
    const conversation = build({ role: 'user', content: 'Hello' });
    const messages = toAGUIMessages(conversation);
    expect(messages).toEqual([{ id: expect.any(String), role: 'user', content: 'Hello' }]);
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });

  it('round-trips an assistant message', () => {
    const conversation = build({ role: 'assistant', content: 'Hi there' });
    const messages = toAGUIMessages(conversation);
    expect(messages).toEqual([{ id: expect.any(String), role: 'assistant', content: 'Hi there' }]);
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });

  it('round-trips a system message', () => {
    const conversation = build({ role: 'system', content: 'Be brief.' });
    const messages = toAGUIMessages(conversation);
    expect(messages[0]).toMatchObject({ role: 'system', content: 'Be brief.' });
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });

  it('round-trips a developer message', () => {
    const conversation = build({ role: 'developer', content: 'Prefer metric units.' });
    const messages = toAGUIMessages(conversation);
    expect(messages[0]).toMatchObject({ role: 'developer', content: 'Prefer metric units.' });
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });

  it('round-trips a tool-call message as an assistant message with toolCalls', () => {
    const conversation = build({
      role: 'tool-call',
      content: '',
      toolCall: { id: 'call-1', name: 'get_weather', arguments: { city: 'NYC' } },
    });
    const messages = toAGUIMessages(conversation);
    expect(messages).toEqual([
      {
        id: expect.any(String),
        role: 'assistant',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          },
        ],
      },
    ]);
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });

  it('round-trips a successful tool-result message as a tool message', () => {
    const conversation = build(
      { role: 'tool-call', content: '', toolCall: { id: 'call-1', name: 'echo', arguments: {} } },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: { temperature: 72 } },
      },
    );
    const messages = toAGUIMessages(conversation);
    expect(messages[1]).toEqual({
      id: expect.any(String),
      role: 'tool',
      toolCallId: 'call-1',
      content: '{"temperature":72}',
    });
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });

  it('round-trips a failed tool result with its error and sets the AG-UI error field', () => {
    const error = {
      code: 'boom',
      category: 'internal' as const,
      retryable: false,
      message: 'it broke',
    };
    const conversation = build(
      { role: 'tool-call', content: '', toolCall: { id: 'call-1', name: 'echo', arguments: {} } },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'error', content: 'partial', error },
      },
    );
    const messages = toAGUIMessages(conversation);
    expect(messages[1]).toMatchObject({ role: 'tool', error: 'it broke' });
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });
});

describe('AG-UI adapter: structure', () => {
  it('groups consecutive tool calls into one assistant message and splits them again', () => {
    const conversation = build(
      { role: 'user', content: 'Weather in two cities?' },
      { role: 'tool-call', content: '', toolCall: { id: 'a', name: 'weather', arguments: 'NYC' } },
      { role: 'tool-call', content: '', toolCall: { id: 'b', name: 'weather', arguments: 'SF' } },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'a', outcome: 'success', content: 'sunny' },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'b', outcome: 'success', content: 'foggy' },
      },
      { role: 'assistant', content: 'Sunny and foggy.' },
    );
    const messages = toAGUIMessages(conversation);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(messages[1]).toMatchObject({ toolCalls: [{ id: 'a' }, { id: 'b' }] });
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });

  it('splits an assistant message that carries both text and tool calls', () => {
    const messages: AGUIMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Checking.',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } },
        ],
      },
    ];
    const conversation = fromAGUIMessages(messages);
    expect(essentials(conversation)).toEqual([
      {
        role: 'assistant',
        content: 'Checking.',
        metadata: {},
        toolCall: undefined,
        toolResult: undefined,
      },
      {
        role: 'tool-call',
        content: '',
        metadata: {},
        toolCall: { id: 'c1', name: 'lookup', arguments: { q: 1 } },
        toolResult: undefined,
      },
    ]);
  });

  it('round-trips message metadata', () => {
    const conversation = build({ role: 'user', content: 'Hi', metadata: { source: 'web', n: 2 } });
    expect(toAGUIMessages(conversation)[0]).toMatchObject({ metadata: { source: 'web', n: 2 } });
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });

  it('skips hidden and snapshot messages', () => {
    const conversation = build(
      { role: 'user', content: 'visible' },
      { role: 'assistant', content: 'secret', hidden: true },
      { role: 'snapshot', content: 'state' },
    );
    expect(toAGUIMessages(conversation).map((message) => message.role)).toEqual(['user']);
  });

  it('maps multi-modal user content to AG-UI parts and back', () => {
    const conversation = build({
      role: 'user',
      content: [
        { type: 'text', text: 'Look at these' },
        { type: 'image', url: 'https://example.com/a.png', mimeType: 'image/png', text: 'a cat' },
        { type: 'image', url: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg' },
        {
          type: 'document',
          name: 'spec.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'base64', data: 'JVBERi0=' },
        },
        {
          type: 'document',
          name: 'remote.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'reference', uri: 'https://example.com/remote.pdf' },
        },
      ],
    });
    const messages = toAGUIMessages(conversation);
    expect(messages[0]).toMatchObject({
      content: [
        { type: 'text', text: 'Look at these' },
        {
          type: 'image',
          source: { type: 'url', value: 'https://example.com/a.png', mimeType: 'image/png' },
          metadata: { text: 'a cat' },
        },
        { type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/jpeg' } },
        {
          type: 'document',
          source: { type: 'data', value: 'JVBERi0=', mimeType: 'application/pdf' },
        },
        { type: 'document', source: { type: 'url', value: 'https://example.com/remote.pdf' } },
      ],
    });
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });

  it('rejects unsupported content with a ConversationalistError naming the part', () => {
    const conversation = build({
      role: 'assistant',
      content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }],
    });
    try {
      toAGUIMessages(conversation);
      throw new Error('expected toAGUIMessages to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AGUIMappingError);
      expect(error).toBeInstanceOf(ConversationalistError);
      expect((error as AGUIMappingError).code).toBe('error:validation');
      expect((error as AGUIMappingError).kind).toBe('server_tool_use');
    }
  });

  it('rejects a system message with non-text content', () => {
    const conversation = build({
      role: 'system',
      content: [{ type: 'image', url: 'https://example.com/a.png' }],
    });
    expect(() => toAGUIMessages(conversation)).toThrow(AGUIMappingError);
  });
});

describe('AG-UI adapter: inbound validation', () => {
  it('rejects a message that fails the AG-UI schema before mapping it', () => {
    const malformed = [{ id: 'm1', role: 'user' }] as unknown as AGUIMessage[];
    try {
      fromAGUIMessages(malformed);
      throw new Error('expected fromAGUIMessages to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AGUIMappingError);
      expect((error as AGUIMappingError).kind).toBe('message');
      expect((error as AGUIMappingError).code).toBe('error:validation');
    }
  });

  it('skips activity messages, which are progress rather than conversation content', () => {
    const conversation = fromAGUIMessages([
      { id: 'a1', role: 'activity', activityType: 'PLAN', content: { steps: 2 } },
      { id: 'u1', role: 'user', content: 'Go' },
    ]);
    expect(essentials(conversation).map((message) => message.role)).toEqual(['user']);
  });

  it('rejects audio parts, which have no Conversationalist representation', () => {
    const messages: AGUIMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: [{ type: 'audio', source: { type: 'url', value: 'https://example.com/a.mp3' } }],
      },
    ];
    expect(() => fromAGUIMessages(messages)).toThrow(AGUIMappingError);
  });

  it('marks a bare tool error as an error outcome', () => {
    const conversation = fromAGUIMessages([
      {
        id: 'a1',
        role: 'assistant',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
      },
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'oops', error: 'failed' },
    ]);
    const result = getOrderedMessages(conversation)[1]?.toolResult;
    expect(result).toMatchObject({
      outcome: 'error',
      content: 'oops',
      error: { message: 'failed' },
    });
  });

  it('exposes export, import, and append on the adapter object', () => {
    const imported = agUiConversationAdapter.import([{ id: 'u1', role: 'user', content: 'One' }]);
    const appended = agUiConversationAdapter.append(imported, [
      { id: 'a1', role: 'assistant', content: 'Two' },
    ]);
    expect(agUiConversationAdapter.export(appended).map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(appendAGUIMessages(imported, [])).toBe(imported);
  });
});

describe('AG-UI adapter: tool message results', () => {
  it('reads a bare tool message as a successful result', () => {
    expect(
      fromAGUIToolMessage({ id: 't1', role: 'tool', toolCallId: 'c1', content: 'sunny' }),
    ).toEqual({ callId: 'c1', outcome: 'success', content: 'sunny' });
  });

  it('joins text parts and keeps the outcome a canonical payload spells out', () => {
    const payload = JSON.stringify({ outcome: 'error', content: 'missing' });
    expect(
      fromAGUIToolMessage({
        id: 't1',
        role: 'tool',
        toolCallId: 'c1',
        content: [
          { type: 'text', text: payload.slice(0, 5) },
          { type: 'image', source: { type: 'url', value: 'https://example.com/a.png' } },
          { type: 'text', text: payload.slice(5) },
        ],
      }),
    ).toEqual({
      callId: 'c1',
      outcome: 'success',
      content: `${payload.slice(0, 5)}\n\n${payload.slice(5)}`,
    });
    expect(
      fromAGUIToolMessage({ id: 't1', role: 'tool', toolCallId: 'c1', content: payload }),
    ).toMatchObject({ outcome: 'error', content: 'missing' });
  });

  it('marks a result the message flags with an error as failed', () => {
    expect(
      fromAGUIToolMessage({
        id: 't1',
        role: 'tool',
        toolCallId: 'c1',
        content: 'x',
        error: 'boom',
      }),
    ).toMatchObject({ outcome: 'error', error: { message: 'boom' } });
  });
});
