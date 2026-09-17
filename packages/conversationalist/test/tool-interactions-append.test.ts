import { describe, expect, it } from 'bun:test';

import {
  appendToolCall,
  appendToolCalls,
  appendToolResult,
  appendToolResultAsync,
  createConversationHistory as createConversation,
  getPendingToolCalls,
  getToolInteractions,
  materializeToolCall,
} from '../src/conversation/index';
import type { ConversationHistory as Conversation, Message } from '../src/types';

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `call-${++counter}`;
  })(),
};

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('tool interaction append and materialization', () => {
  it('appends tool-call and tool-result messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(conv, {
      name: 'tool',
      arguments: { input: 'value' },
    });
    const callId = getOrderedMessages(conv)[0]?.toolCall?.id;
    expect(callId).toBeDefined();

    conv = appendToolResult(conv, {
      callId: callId!,
      outcome: 'success',
      content: { ok: true },
    });

    const messages = getOrderedMessages(conv);
    expect(messages[0]?.role).toBe('tool-call');
    expect(messages[1]?.role).toBe('tool-result');
  });

  it('returns pending tool calls without results', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(conv, {
      name: 'tool',
      id: 'call-1',
      arguments: { input: 'value' },
    });

    const pending = getPendingToolCalls(conv);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('call-1');
  });

  it('returns no pending calls after results are recorded', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(conv, {
      name: 'tool',
      id: 'call-1',
      arguments: { input: 'value' },
    });
    conv = appendToolResult(conv, {
      callId: 'call-1',
      outcome: 'success',
      content: { ok: true },
    });

    const pending = getPendingToolCalls(conv);
    expect(pending).toHaveLength(0);
  });

  it('pairs tool calls with results', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(conv, {
      name: 'tool',
      id: 'call-1',
      arguments: { input: 'value' },
    });
    conv = appendToolResult(conv, {
      callId: 'call-1',
      outcome: 'success',
      content: { ok: true },
    });

    const interactions = getToolInteractions(conv);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.call.id).toBe('call-1');
    expect(interactions[0]?.result?.outcome).toBe('success');
  });

  it('generates call IDs when omitted', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(
      conv,
      {
        name: 'tool',
        arguments: { input: 'value' },
      },
      undefined,
      testEnvironment,
    );

    const [message] = getOrderedMessages(conv);
    expect(message?.toolCall?.id).toBe('call-1');
  });

  it('materializes tool calls with a shared ID generator interface', () => {
    expect(
      materializeToolCall(
        {
          name: 'tool',
          arguments: { value: 1 },
        },
        {
          generateId: () => 'materialized-call',
        },
      ),
    ).toEqual({
      id: 'materialized-call',
      name: 'tool',
      arguments: { value: 1 },
    });
  });

  it('rejects tool results without a matching tool call', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    expect(() =>
      appendToolResult(
        conv,
        {
          callId: 'missing',
          outcome: 'success',
          content: { ok: true },
        },
        undefined,
        testEnvironment,
      ),
    ).toThrow();
  });

  it('appends batches of tool calls in order', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCalls(
      conv,
      [
        { id: 'call-1', name: 'search', arguments: { query: 'alpha' } },
        { id: 'call-2', name: 'search', arguments: { query: 'beta' } },
      ],
      testEnvironment,
    );

    const messages = getOrderedMessages(conv);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.toolCall?.id).toBe('call-1');
    expect(messages[1]?.toolCall?.id).toBe('call-2');
  });

  it('returns the original conversation for empty tool-call batches', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    expect(appendToolCalls(conv, [], testEnvironment)).toBe(conv);
  });

  it('collects streamed tool results before persisting them', async () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendToolCall(conv, {
      id: 'call-1',
      name: 'tool',
      arguments: { input: 'value' },
    });

    conv = await appendToolResultAsync(
      conv,
      {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { chunk: 'a' };
            yield { chunk: 'b' };
          },
        },
      },
      undefined,
      testEnvironment,
    );

    const messages = getOrderedMessages(conv);
    expect(messages[1]?.toolResult?.content).toEqual([{ chunk: 'a' }, { chunk: 'b' }]);
  });
});
