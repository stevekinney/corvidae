import { describe, expect, it } from 'bun:test';

import { truncateFromPosition } from '../src/context-recent';
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

describe('truncateFromPosition', () => {
  it('keeps messages from position onwards', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Message 0' },
      { role: 'assistant', content: 'Message 1' },
      { role: 'user', content: 'Message 2' },
      { role: 'assistant', content: 'Message 3' },
      testEnvironment,
    );

    const truncated = truncateFromPosition(conv, 2, undefined, testEnvironment);
    expect(getOrderedMessages(truncated)).toHaveLength(2);
    expect(getOrderedMessages(truncated)[0]?.content).toBe('Message 2');
    expect(getOrderedMessages(truncated)[1]?.content).toBe('Message 3');
  });

  it('preserves system messages by default', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Message 1' },
      { role: 'assistant', content: 'Message 2' },
      { role: 'user', content: 'Message 3' },
      testEnvironment,
    );

    const truncated = truncateFromPosition(conv, 2, undefined, testEnvironment);
    expect(getOrderedMessages(truncated).some((m) => m.role === 'system')).toBe(true);
    expect(getOrderedMessages(truncated)[0]?.content).toBe('System prompt');
  });

  it('can exclude system messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Message 1' },
      { role: 'assistant', content: 'Message 2' },
      testEnvironment,
    );

    const truncated = truncateFromPosition(
      conv,
      2,
      { preserveSystemMessages: false },
      testEnvironment,
    );
    expect(getOrderedMessages(truncated).every((m) => m.role !== 'system')).toBe(true);
  });

  it('renumbers positions correctly', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Message 0' },
      { role: 'assistant', content: 'Message 1' },
      { role: 'user', content: 'Message 2' },
      testEnvironment,
    );

    const truncated = truncateFromPosition(conv, 1, undefined, testEnvironment);
    getOrderedMessages(truncated).forEach((m, i) => {
      expect(m.position).toBe(i);
    });
  });

  it('handles multi-modal content in truncateFromPosition', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Msg 1' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Msg 2' }],
      },
      testEnvironment,
    );

    const truncated = truncateFromPosition(conv, 1, undefined, testEnvironment);
    expect(getOrderedMessages(truncated)).toHaveLength(1);
    expect(Array.isArray(getOrderedMessages(truncated)[0]!.content)).toBe(true);
  });

  it('preserves tool-call when truncating from a position that includes a tool-result', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Hello' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: {} },
      },
      { role: 'assistant', content: 'Waiting' },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    const truncated = truncateFromPosition(conv, 3, undefined, testEnvironment);
    const messages = getOrderedMessages(truncated);
    expect(messages.some((m) => m.role === 'tool-call')).toBe(true);
    expect(messages.some((m) => m.role === 'tool-result')).toBe(true);
  });

  it('returns a valid conversation when preserveToolPairs is true', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Hello' },
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

    const truncated = truncateFromPosition(conv, 2, { preserveToolPairs: true }, testEnvironment);
    const messages = getOrderedMessages(truncated);
    expect(messages.some((m) => m.role === 'tool-call')).toBe(true);
    expect(messages.some((m) => m.role === 'tool-result')).toBe(true);
  });

  it('throws when preserveToolPairs is false and a tool-result would be stranded', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Hello' },
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
      truncateFromPosition(
        conv,
        2,
        { preserveToolPairs: false, preserveSystemMessages: false },
        testEnvironment,
      ),
    ).toThrow(/preserveToolPairs: true/);
  });
});
