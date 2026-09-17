import { describe, expect, it } from 'bun:test';

import { simpleTokenEstimator } from '../src/context';
import { truncateFromPosition } from '../src/context-recent';
import { truncateToTokenLimit } from '../src/context-truncation';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { appendStreamingMessage, isStreamingMessage } from '../src/streaming';
import type { ConversationHistory as Conversation, Message } from '../src/types';

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `test-id-${++counter}`;
  })(),
};

describe('streaming message protection', () => {
  it('truncateToTokenLimit preserves streaming messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Old message one' },
      { role: 'assistant', content: 'Old response' },
      { role: 'user', content: 'Recent question' },
      testEnvironment,
    );
    const { conversation: withStreaming } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      withStreaming,
      1,
      { estimateTokens: simpleTokenEstimator },
      testEnvironment,
    );

    // Streaming message must survive even with a very low token limit
    const messages = getOrderedMessages(truncated);
    expect(messages.some((m) => isStreamingMessage(m))).toBe(true);
  });

  it('truncateFromPosition preserves streaming messages below cutoff position', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Message 0' }, testEnvironment);
    const { conversation: withStreaming } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );
    // Add more messages after the streaming one
    const updated = appendMessages(
      withStreaming,
      { role: 'user', content: 'Message 2' },
      { role: 'assistant', content: 'Message 3' },
      testEnvironment,
    );

    // Truncate from position 2, which would normally drop messages at positions 0 and 1
    // The streaming message (at position 1) should still be preserved
    const truncated = truncateFromPosition(updated, 2, undefined, testEnvironment);
    const messages = getOrderedMessages(truncated);

    expect(messages.some((m) => isStreamingMessage(m))).toBe(true);
    // Kept messages (position >= 2) should also be present
    expect(messages.some((m) => m.content === 'Message 2')).toBe(true);
  });
});
