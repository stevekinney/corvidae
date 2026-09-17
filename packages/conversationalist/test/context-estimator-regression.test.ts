import { describe, expect, it } from 'bun:test';

import { estimateConversationTokens } from '../src/context';
import { truncateToTokenLimit } from '../src/context-truncation';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
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

describe('pluggable token estimator regression', () => {
  it('truncateToTokenLimit drives trimming when a custom (messages)=>number estimator is injected', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
      testEnvironment,
    );

    // Custom estimator: each message costs 10 tokens
    const callLog: number[] = [];
    const truncated = truncateToTokenLimit(conv, 15, {
      estimateConversationTokens(messages) {
        callLog.push(messages.length);
        return messages.length * 10;
      },
    });

    // 3 messages × 10 = 30 > 15; should trim to ≤15 tokens
    expect(callLog.length).toBeGreaterThan(0);
    expect(getOrderedMessages(truncated).length).toBeLessThan(3);
  });

  it('estimateConversationTokens uses the default simpleTokenEstimator when no estimator is supplied', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'hello world' }, testEnvironment);

    const tokens = estimateConversationTokens(conv);
    // simpleTokenEstimator counts characters / 4 plus overhead
    expect(tokens).toBeGreaterThan(0);
    expect(typeof tokens).toBe('number');
  });

  it('estimateConversationTokens uses a custom (messages)=>number estimator when provided', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      testEnvironment,
    );

    // Custom estimator: fixed 42 tokens regardless of content
    const tokens = estimateConversationTokens(conv, { estimateConversationTokens: () => 42 });
    expect(tokens).toBe(42);
  });

  it('truncateToTokenLimit default behavior unchanged when no estimator is supplied', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'short' },
      testEnvironment,
    );

    // With a large enough limit, no messages should be trimmed
    const truncated = truncateToTokenLimit(conv, 10_000);
    expect(getOrderedMessages(truncated).length).toBe(2);
  });
});
