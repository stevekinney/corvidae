import { describe, expect, it } from 'bun:test';

import {
  appendToolCall,
  appendToolResult,
  appendUnsafeMessage,
  createConversationHistory as createConversation,
  resolveToolResult,
  resolveToolResultAsync,
} from '../src/conversation/index';
import { redactPii } from '../src/plugins/pii-redaction';
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

const buildPendingConversation = (): Conversation => {
  let conversation = createConversation({ id: 'resolve' }, testEnvironment);
  conversation = appendToolCall(
    conversation,
    { id: 'call-1', name: 'deploy', arguments: { target: 'production' } },
    undefined,
    testEnvironment,
  );
  return appendUnsafeMessage(
    conversation,
    {
      role: 'tool-result',
      content: '',
      toolResult: { callId: 'call-1', outcome: 'action_required', content: { pending: true } },
    },
    testEnvironment,
  );
};

describe('resolveToolResult advanced boundaries', () => {
  it('runs environment.plugins over the replacement, same as appending a new tool result', () => {
    const env = { ...testEnvironment, plugins: [redactPii] };
    let conv = createConversation({ id: 'test' }, env);
    conv = appendToolCall(
      conv,
      { id: 'call-1', name: 'lookup-customer', arguments: {} },
      undefined,
      env,
    );
    conv = appendToolResult(
      conv,
      { callId: 'call-1', outcome: 'action_required', content: null },
      undefined,
      env,
    );

    const resolved = resolveToolResult(
      conv,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { email: 'user@example.com' } },
      undefined,
      env,
    );

    const replaced = getOrderedMessages(resolved).find((message) => message.role === 'tool-result');
    expect(replaced?.toolResult?.content).toEqual({ email: '[EMAIL_REDACTED]' });
  });

  it('resolveToolResultAsync collects a streaming toolResult before replacing the pending result', async () => {
    const conv = buildPendingConversation();

    const resolved = await resolveToolResultAsync(
      conv,
      'call-1',
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

    const toolResultMessages = getOrderedMessages(resolved).filter(
      (message) => message.role === 'tool-result' && message.toolResult?.callId === 'call-1',
    );
    expect(toolResultMessages).toHaveLength(1);
    expect(toolResultMessages[0]?.toolResult?.content).toEqual([{ chunk: 'a' }, { chunk: 'b' }]);
  });

  it('resolveToolResult throws on a streaming toolResult, same as appendToolResult', () => {
    const conv = buildPendingConversation();

    expect(() =>
      resolveToolResult(
        conv,
        'call-1',
        {
          callId: 'call-1',
          outcome: 'success',
          content: [],
          stream: {
            async *[Symbol.asyncIterator]() {
              yield 'chunk';
            },
          },
        },
        undefined,
        testEnvironment,
      ),
    ).toThrow(
      'materializeToolResult does not support streaming tool results. Use materializeToolResultAsync or materializeToolResultsAsync.',
    );
  });
});
