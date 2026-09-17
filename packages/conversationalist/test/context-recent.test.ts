import { describe, expect, it } from 'bun:test';

import { getRecentMessages } from '../src/context-recent';
import {
  appendMessages,
  appendUnsafeMessage,
  createConversationHistory as createConversation,
  createConversationHistoryUnsafe as createConversationUnsafe,
} from '../src/conversation/index';

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `test-id-${++counter}`;
  })(),
};

describe('getRecentMessages', () => {
  it('returns the last N messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System message' },
      { role: 'user', content: 'User 1' },
      { role: 'assistant', content: 'Assistant 1' },
      { role: 'user', content: 'User 2' },
      { role: 'assistant', content: 'Assistant 2' },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.content).toBe('User 2');
    expect(recent[1]?.content).toBe('Assistant 2');
  });

  it('excludes system messages by default', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System' },
      { role: 'user', content: 'User' },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 10);
    expect(recent.every((m) => m.role !== 'system')).toBe(true);
  });

  it('includes system messages when option is set', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System' },
      { role: 'user', content: 'User' },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 10, { includeSystem: true });
    expect(recent.some((m) => m.role === 'system')).toBe(true);
  });

  it('excludes hidden messages by default', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Visible' },
      { role: 'user', content: 'Hidden', hidden: true },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.content).toBe('Visible');
  });

  it('preserves tool-call when the recent slice includes a tool-result', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Before' },
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

    const recent = getRecentMessages(conv, 1);
    expect(recent.some((m) => m.role === 'tool-call')).toBe(true);
    expect(recent.some((m) => m.role === 'tool-result')).toBe(true);
  });

  it('drops orphan tool results when preserving tool pairs', () => {
    let conv = createConversationUnsafe({ id: 'test' }, testEnvironment);
    conv = appendUnsafeMessage(
      conv,
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'missing', outcome: 'success', content: 'ok' },
      },
      testEnvironment,
    );

    const recent = getRecentMessages(conv, 1, { preserveToolPairs: true });
    expect(recent).toHaveLength(0);
  });

  it('returns a simple slice when preserveToolPairs is false', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
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

    const recent = getRecentMessages(conv, 1, { preserveToolPairs: false });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.role).toBe('tool-result');
  });
});
