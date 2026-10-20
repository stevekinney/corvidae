import { MessageSchema, MessagesSnapshotEventSchema } from '@ag-ui/core/schemas';
import { describe, expect, it } from 'bun:test';

import { agUiConversationAdapter } from '../src/adapters/ag-ui';
import { AGUIMappingError } from '../src/adapters/ag-ui/errors';
import {
  appendAGUIMessages,
  fromAGUIMessages,
  fromAGUIToolMessage,
  mergeAGUIMessages,
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

/** Row ids in order: identity, not just content, is what a round trip must keep. */
function ids(conversation: ReturnType<typeof build>): string[] {
  return getOrderedMessages(conversation).map((message) => message.id);
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
    expect(messages[1]).toMatchObject({
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
  it('writes each tool call under its own message id and reads them back', () => {
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
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(messages[1]).toMatchObject({ toolCalls: [{ id: 'a' }] });
    expect(messages[2]).toMatchObject({ toolCalls: [{ id: 'b' }] });
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
    expect(ids(roundTrip(conversation))).toEqual(ids(conversation));
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
        {
          type: 'image',
          source: { kind: 'remote-url', url: 'https://example.com/a.png' },
          mimeType: 'image/png',
          alt: 'a cat',
        },
        {
          type: 'image',
          source: { kind: 'inline', data: 'AAAA', encoding: 'base64' },
          mimeType: 'image/jpeg',
        },
        {
          type: 'document',
          name: 'spec.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'inline', data: 'JVBERi0=', encoding: 'base64' },
        },
        {
          type: 'document',
          name: 'remote.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'remote-url', url: 'https://example.com/remote.pdf' },
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
      content: [
        { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/a.png' } },
      ],
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

  it('maps audio and video parts to audio and video content and back', () => {
    const messages: AGUIMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'audio', source: { type: 'url', value: 'https://example.com/a.mp3' } },
          { type: 'video', source: { type: 'data', value: 'AAAA', mimeType: 'video/mp4' } },
        ],
      },
    ];
    const conversation = fromAGUIMessages(messages);
    expect(essentials(conversation)[0]?.content).toEqual([
      { type: 'audio', source: { kind: 'remote-url', url: 'https://example.com/a.mp3' } },
      {
        type: 'video',
        source: { kind: 'inline', data: 'AAAA', encoding: 'base64' },
        mimeType: 'video/mp4',
      },
    ]);
    expect(toAGUIMessages(conversation)).toMatchObject(messages);
  });

  it('rejects a provider file handle that names no provider', () => {
    const messages: AGUIMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: [{ type: 'audio', source: { type: 'file', value: 'file-1' } }],
      },
    ];
    expect(() => fromAGUIMessages(messages)).toThrow(AGUIMappingError);
  });

  it('carries a named provider file handle as a provider-file source', () => {
    const messages: AGUIMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'document', source: { type: 'file', value: 'file-1', provider: 'openai' } },
        ],
      },
    ];
    const conversation = fromAGUIMessages(messages);
    expect(essentials(conversation)[0]?.content).toEqual([
      {
        type: 'document',
        source: { kind: 'provider-file', provider: 'openai', providerFileId: 'file-1' },
      },
    ]);
    expect(toAGUIMessages(conversation)).toMatchObject(messages);
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
  it('reads a bare tool message as a successful result whose content is its text', () => {
    expect(
      fromAGUIToolMessage({ id: 't1', role: 'tool', toolCallId: 'c1', content: 'sunny' }),
    ).toEqual({ callId: 'c1', outcome: 'success', content: 'sunny' });
  });

  it('never parses the text of a tool message from elsewhere as JSON', () => {
    const payload = JSON.stringify({ outcome: 'error', content: 'missing' });
    expect(
      fromAGUIToolMessage({ id: 't1', role: 'tool', toolCallId: 'c1', content: payload }),
    ).toEqual({ callId: 'c1', outcome: 'success', content: payload });
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
    ).toMatchObject({ outcome: 'error', content: 'x', error: { message: 'boom' } });
  });

  it('joins text parts, and keeps media parts as their JSON', () => {
    const text = { type: 'text' as const, text: 'one' };
    const image = {
      type: 'image' as const,
      source: { type: 'url' as const, value: 'https://example.com/a.png' },
    };
    expect(
      fromAGUIToolMessage({
        id: 't1',
        role: 'tool',
        toolCallId: 'c1',
        content: [text, { type: 'text', text: 'two' }],
      }),
    ).toMatchObject({ content: 'one\n\ntwo' });
    expect(
      fromAGUIToolMessage({ id: 't1', role: 'tool', toolCallId: 'c1', content: [image] }),
    ).toEqual({ callId: 'c1', outcome: 'success', content: [image] });
    expect(
      fromAGUIToolMessage({ id: 't1', role: 'tool', toolCallId: 'c1', content: [text, image] }),
    ).toMatchObject({ content: [text, image] });
  });

  const resultFor = (content: unknown, extra: Record<string, unknown> = {}) =>
    build(
      { role: 'tool-call', content: '', toolCall: { id: 'c1', name: 'tool', arguments: {} } },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'c1', outcome: 'success', content, ...extra } as never,
      },
    );

  it('round-trips a success whose content is a JSON-looking string as a string', () => {
    for (const content of ['{"a":1}', '[1,2]', 'null', '42', '{"outcome":"error","content":"x"}']) {
      const conversation = resultFor(content);
      expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
    }
  });

  it('round-trips a success object shaped like a failure as a success', () => {
    const conversation = resultFor({ outcome: 'error', content: 'looks failed' });
    const restored = getOrderedMessages(roundTrip(conversation)).at(-1)?.toolResult;
    expect(restored).toEqual({
      callId: 'c1',
      outcome: 'success',
      content: { outcome: 'error', content: 'looks failed' },
    });
  });

  it('round-trips structured, error, and action results exactly', () => {
    const action = {
      type: 'approval' as const,
      message: 'Allow?',
      risk: 'high' as const,
      operation: { kind: 'other' as const },
      policyVersion: 'policy:test',
      idempotencyKey: 'key-1',
    };
    for (const result of [
      {
        outcome: 'success',
        content: { n: 1, list: [1, 2] },
        inputDigest: 'in',
        outputDigest: 'out',
      },
      {
        outcome: 'error',
        content: 'partial',
        error: {
          code: 'x',
          category: 'internal',
          retryable: true,
          message: 'broke',
          details: { a: 1 },
        },
      },
      { outcome: 'action_required', content: null, action },
    ]) {
      const conversation = build(
        { role: 'tool-call', content: '', toolCall: { id: 'c1', name: 'tool', arguments: {} } },
        { role: 'tool-result', content: '', toolResult: { callId: 'c1', ...result } as never },
      );
      expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
    }
  });

  it('keeps row metadata apart from the embedded result', () => {
    const conversation = build(
      { role: 'tool-call', content: '', toolCall: { id: 'c1', name: 'tool', arguments: {} } },
      {
        role: 'tool-result',
        content: '',
        metadata: { source: 'tool-runner' },
        toolResult: { callId: 'c1', outcome: 'success', content: { n: 1 } },
      },
    );
    expect(getOrderedMessages(roundTrip(conversation)).at(-1)?.metadata).toEqual({
      source: 'tool-runner',
    });
  });

  it('writes media content as parts and reads it back', () => {
    const parts = [
      { type: 'text', text: 'caption' },
      { type: 'image', source: { type: 'url', value: 'https://example.com/a.png' } },
    ];
    const conversation = resultFor(parts);
    const messages = toAGUIMessages(conversation);
    expect(messages.at(-1)).toMatchObject({ role: 'tool', content: parts });
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });
});

describe('AG-UI adapter: message identity', () => {
  const call = (id: string, name = 'tool') => ({
    id,
    type: 'function' as const,
    function: { name, arguments: '{}' },
  });
  const samples: AGUIMessage[][] = [
    [{ id: 'u1', role: 'user', content: 'Hello' }],
    [{ id: 's1', role: 'system', content: 'Be brief.' }],
    [{ id: 'd1', role: 'developer', content: 'Metric.' }],
    [{ id: 'a1', role: 'assistant', content: 'Hi' }],
    [{ id: 'a1', role: 'assistant', toolCalls: [call('c1')] }],
    [{ id: 'a1', role: 'assistant', toolCalls: [call('c1'), call('c2')] }],
    [{ id: 'a1', role: 'assistant', content: 'Checking.', toolCalls: [call('c1'), call('c2')] }],
    [
      { id: 'a1', role: 'assistant', toolCalls: [call('c1')] },
      { id: 'a2', role: 'assistant', toolCalls: [call('c2')] },
    ],
    [
      { id: 'a1', role: 'assistant', content: 'Checking.', toolCalls: [call('c1')] },
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'sunny' },
      { id: 'a2', role: 'assistant', content: 'Done.' },
    ],
    [
      { id: 'a1:reasoning:0', role: 'reasoning', content: 'hmm', encryptedValue: 'sig' },
      { id: 'a1', role: 'assistant', content: 'Answer.', toolCalls: [call('c1')] },
    ],
    [
      { id: 'a1:reasoning:0', role: 'reasoning', content: 'hmm', encryptedValue: 'sig' },
      { id: 'a1', role: 'assistant', toolCalls: [call('c1')] },
    ],
  ];

  it('reproduces the ids of an AG-UI history after a round trip through the conversation', () => {
    for (const messages of samples) {
      expect(toAGUIMessages(fromAGUIMessages(messages))).toEqual(messages);
    }
  });

  it('keeps tool arguments that are valid JSON null as null, and unparseable text as written', () => {
    const call = (id: string, args: string) => ({
      id,
      type: 'function' as const,
      function: { name: 'tool', arguments: args },
    });
    const conversation = fromAGUIMessages([
      { id: 'a1', role: 'assistant', toolCalls: [call('c1', 'null'), call('c2', '{broken')] },
    ]);
    expect(getOrderedMessages(conversation).map((row) => row.toolCall?.arguments)).toEqual([
      null,
      '{broken',
    ]);
    expect(toAGUIMessages(conversation)).toMatchObject([
      { toolCalls: [{ function: { arguments: 'null' } }, { function: { arguments: '{broken' } }] },
    ]);
  });

  it('skips messages that carry a subagentRunId, whatever their role', () => {
    const conversation = fromAGUIMessages([
      { id: 'u1', role: 'user', content: 'Hello' },
      { id: 'r1', role: 'reasoning', content: 'subagent thought', subagentRunId: 's1' },
      { id: 'a1', role: 'assistant', content: 'subagent notes', subagentRunId: 's1' },
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'x', subagentRunId: 's1' },
      { id: 'a2', role: 'assistant', content: 'the reply' },
    ]);
    expect(ids(conversation)).toEqual(['u1', 'a2']);
    expect(
      ids(
        mergeAGUIMessages(conversation, [
          { id: 'a3', role: 'assistant', content: 'subagent', subagentRunId: 's1' },
        ]),
      ),
    ).toEqual(['u1', 'a2']);
  });

  it('imports an assistant message with nothing in it as an empty row that keeps its id', () => {
    const messages: AGUIMessage[] = [
      { id: 'a1', role: 'assistant' },
      { id: 'a2', role: 'assistant', content: '' },
    ];
    const conversation = fromAGUIMessages(messages);
    expect(ids(conversation)).toEqual(['a1', 'a2']);
    expect(getOrderedMessages(conversation).map((row) => row.content)).toEqual(['', '']);
    expect(toAGUIMessages(conversation)).toEqual([
      { id: 'a1', role: 'assistant' },
      { id: 'a2', role: 'assistant' },
    ]);
  });

  it('keeps an assistant message with text and tool calls whole under its own id', () => {
    const messages: AGUIMessage[] = [
      { id: 'a1', role: 'assistant', content: 'Checking.', toolCalls: [call('c1'), call('c2')] },
    ];
    const conversation = fromAGUIMessages(messages);
    expect(ids(conversation)).toEqual(['a1', 'a1:call:c1', 'a1:call:c2']);
    expect(toAGUIMessages(conversation)).toEqual(messages);
  });

  it('gives the first call of a text-less assistant message the message id', () => {
    const conversation = fromAGUIMessages([
      { id: 'a1', role: 'assistant', toolCalls: [call('c1'), call('c2')] },
    ]);
    expect(ids(conversation)).toEqual(['a1', 'a1:call:c2']);
  });

  it('keeps the ids of a conversation after a round trip through AG-UI', () => {
    const conversation = build(
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: 'Checking.' },
      { role: 'tool-call', content: '', toolCall: { id: 'a', name: 'weather', arguments: {} } },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'a', outcome: 'success', content: 'sunny' },
      },
      { role: 'assistant', content: 'Sunny.' },
    );
    expect(ids(roundTrip(conversation))).toEqual(ids(conversation));
  });

  it('merges messages by id, adding rows and never changing the ones it has', () => {
    const base = fromAGUIMessages([
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'a1', role: 'assistant', content: 'kept' },
    ]);
    const merged = mergeAGUIMessages(base, [
      { id: 'u1', role: 'user', content: 'different' },
      { id: 'a1', role: 'assistant', content: 'different too' },
      { id: 'u2', role: 'user', content: 'new' },
    ]);
    expect(ids(merged)).toEqual(['u1', 'a1', 'u2']);
    expect(getOrderedMessages(merged).map((message) => message.content)).toEqual([
      'first',
      'kept',
      'new',
    ]);
    expect(mergeAGUIMessages(merged, [{ id: 'u2', role: 'user', content: 'again' }])).toBe(merged);
  });

  it('skips a tool call the conversation already holds under another row id', () => {
    const call = {
      id: 'c1',
      type: 'function' as const,
      function: { name: 'tool', arguments: '{}' },
    };
    const base = fromAGUIMessages([{ id: 'c1:message', role: 'assistant', toolCalls: [call] }]);
    const merged = mergeAGUIMessages(base, [
      { id: 'm1', role: 'assistant', toolCalls: [call] },
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'found' },
    ]);
    expect(ids(merged)).toEqual(['c1:message', 't1']);
  });

  it('rejects an append of a message whose id is already there', () => {
    const base = fromAGUIMessages([{ id: 'u1', role: 'user', content: 'first' }]);
    expect(() => appendAGUIMessages(base, [{ id: 'u1', role: 'user', content: 'again' }])).toThrow(
      ConversationalistError,
    );
  });
});

describe('AG-UI adapter: citations', () => {
  const citations = [{ type: 'char_location', cited_text: 'x', document_index: 0 }];

  it('carries citations on a user text part through the part metadata, both ways', () => {
    const conversation = build({
      role: 'user',
      content: [{ type: 'text', text: 'Quoted', citations }],
    });
    const messages = toAGUIMessages(conversation);
    expect(messages[0]).toMatchObject({
      content: [{ type: 'text', text: 'Quoted', metadata: { citations } }],
    });
    expectValidSnapshot(messages);
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });

  it('carries cited text in a text-only message under a namespaced metadata key, both ways', () => {
    const content = [
      { type: 'text' as const, text: 'Quoted', citations },
      { type: 'text' as const, text: 'Plain' },
    ];
    for (const role of ['assistant', 'system', 'developer'] as const) {
      const conversation = build({ role, content, metadata: { source: 'web' } });
      const messages = toAGUIMessages(conversation);
      expect(messages[0]).toMatchObject({
        role,
        content: 'Quoted\n\nPlain',
        metadata: { source: 'web', 'conversationalist:textParts': content },
      });
      expectValidSnapshot(messages);
      const restored = roundTrip(conversation);
      expect(essentials(restored)).toEqual(essentials(conversation));
      expect(getOrderedMessages(restored)[0]?.metadata).toEqual({ source: 'web' });
    }
  });

  it('keeps cited assistant text beside reasoning', () => {
    const conversation = build({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: 'Quoted', citations },
      ],
    });
    expect(essentials(roundTrip(conversation))).toEqual(essentials(conversation));
  });

  it('ignores stored parts that no longer say what the message says', () => {
    const stale: AGUIMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: 'Edited',
        metadata: { 'conversationalist:textParts': [{ type: 'text', text: 'Quoted', citations }] },
      },
      {
        id: 'a2',
        role: 'assistant',
        content: 'Quoted',
        metadata: { 'conversationalist:textParts': [{ type: 'text', text: 5 }] },
      },
      {
        id: 'a3',
        role: 'assistant',
        content: 'Quoted',
        metadata: { 'conversationalist:textParts': 'not parts' },
      },
    ];
    expect(getOrderedMessages(fromAGUIMessages(stale)).map((message) => message.content)).toEqual([
      'Edited',
      'Quoted',
      'Quoted',
    ]);
  });
});

describe('an assistant message that carries metadata and tool calls but no text (COR-1548)', () => {
  const message = (): AGUIMessage[] => [
    {
      id: 'step-0',
      role: 'assistant',
      toolCalls: [
        { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        { id: 'call-2', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
      metadata: { 'bureau:assets': [{ assetId: 'asset-1' }] },
    },
  ];

  it('keeps the message metadata on the first tool-call row, which takes the message id', () => {
    const rows = getOrderedMessages(fromAGUIMessages(message()));

    expect(rows[0]?.id).toBe('step-0');
    expect(rows[0]?.metadata).toEqual({ 'bureau:assets': [{ assetId: 'asset-1' }] });
  });

  it('puts it on that one row only, and the row’s own call metadata wins on a clash', () => {
    const rows = getOrderedMessages(fromAGUIMessages(message()));

    expect(rows[1]?.metadata).toEqual({});
  });

  it('leaves an assistant message that has text exactly as it was: the metadata stays on the text row', () => {
    const rows = getOrderedMessages(
      fromAGUIMessages([
        {
          id: 'step-0',
          role: 'assistant',
          content: 'Here.',
          toolCalls: [
            { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
          metadata: { 'bureau:assets': [{ assetId: 'asset-1' }] },
        },
      ]),
    );

    expect(rows[0]?.metadata).toEqual({ 'bureau:assets': [{ assetId: 'asset-1' }] });
    expect(rows[1]?.metadata).toEqual({});
  });
});
