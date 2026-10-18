import { describe, expect, it } from 'bun:test';

import { simpleTokenEstimator } from '../src/context';
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

describe('core', () => {
  it('returns unchanged if under limit', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Hi' }, testEnvironment);

    const truncated = truncateToTokenLimit(
      conv,
      1000,
      { estimateTokens: simpleTokenEstimator },
      testEnvironment,
    );
    expect(getOrderedMessages(truncated)).toHaveLength(getOrderedMessages(conv).length);
  });

  it('removes oldest messages first to fit limit', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'This is a longer message that takes more tokens' },
      { role: 'assistant', content: 'Response one' },
      { role: 'user', content: 'Short' },
      { role: 'assistant', content: 'Response two' },
      testEnvironment,
    );

    // Set a low token limit that can't fit all messages
    const truncated = truncateToTokenLimit(
      conv,
      10,
      { estimateTokens: simpleTokenEstimator },
      testEnvironment,
    );
    expect(getOrderedMessages(truncated).length).toBeLessThan(getOrderedMessages(conv).length);
  });

  it('preserves system messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User message' },
      { role: 'assistant', content: 'Assistant message' },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      5,
      { estimateTokens: simpleTokenEstimator },
      testEnvironment,
    );
    expect(getOrderedMessages(truncated).some((m) => m.role === 'system')).toBe(true);
  });

  it('preserves last N messages when specified', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Old message one' },
      { role: 'assistant', content: 'Old response' },
      { role: 'user', content: 'New message' },
      { role: 'assistant', content: 'New response' },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      10,
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 2,
      },
      testEnvironment,
    );

    // The last 2 messages should always be preserved
    const lastMessages = getOrderedMessages(truncated).slice(-2);
    expect(lastMessages[0]?.content).toBe('New message');
    expect(lastMessages[1]?.content).toBe('New response');
  });

  it('returns only system and protected messages when token limit is too low', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'Very long system prompt that takes many tokens' },
      { role: 'user', content: 'Old message' },
      { role: 'assistant', content: 'Old response' },
      { role: 'user', content: 'New message' },
      { role: 'assistant', content: 'New response' },
      testEnvironment,
    );

    // Token limit so low that only system + last N fit (or even just those)
    const truncated = truncateToTokenLimit(
      conv,
      1, // Very low limit
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 2,
      },
      testEnvironment,
    );

    // Should contain system message and last 2 protected messages
    expect(getOrderedMessages(truncated).some((m) => m.role === 'system')).toBe(true);
    // Positions should be renumbered
    getOrderedMessages(truncated).forEach((m, i) => {
      expect(m.position).toBe(i);
    });
  });

  it('handles messages with multi-modal content during truncation', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', source: { kind: 'data-url', url: 'data:image/png;base64,abc' } },
        ],
      },
      { role: 'assistant', content: 'I see it' },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      1, // Very low limit to trigger the special path
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 1,
      },
      testEnvironment,
    );

    // Should preserve array content structure
    expect(getOrderedMessages(truncated).length).toBeGreaterThan(0);
  });

  it('handles messages with tool calls during truncation', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Do something' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: '{}' },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'done' },
      },
      { role: 'assistant', content: 'Done!' },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      1, // Very low limit
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 2,
      },
      testEnvironment,
    );

    // Should handle toolCall and toolResult properties
    expect(getOrderedMessages(truncated).length).toBeGreaterThan(0);
  });

  it('preserves tool pairs when a tool-result is protected by preserveLastN', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Start' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      1,
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 1,
        preserveToolPairs: true,
      },
      testEnvironment,
    );

    const messages = getOrderedMessages(truncated);
    expect(messages.some((m) => m.role === 'tool-call')).toBe(true);
    expect(messages.some((m) => m.role === 'tool-result')).toBe(true);
  });

  it('throws when preserveToolPairs is false and a tool-result would be stranded', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Start' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    expect(() =>
      truncateToTokenLimit(
        conv,
        1,
        {
          estimateTokens: () => 1,
          preserveLastN: 1,
          preserveToolPairs: false,
        },
        testEnvironment,
      ),
    ).toThrow(/preserveToolPairs: true/);
  });
});
