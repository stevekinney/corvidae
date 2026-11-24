import { expect, test } from 'bun:test';

import { createConversation, type ConversationHistory, type Message } from '@lostgradient/chat';

import { lastAssistantId, turnStateOf } from './turn-states.ts';

const assistant = {
  id: 'assistant',
  role: 'assistant',
  content: 'Partial answer',
  metadata: {},
} as Message;

test('only the dropped stream’s last assistant turn reconnects', () => {
  const conversation: ConversationHistory = {
    ...createConversation({ id: 'reconnecting-turn' }),
    ids: ['person', 'assistant'],
    messages: {
      person: {
        id: 'person',
        role: 'user',
        content: 'Question',
        metadata: {},
        position: 0,
        createdAt: '2026-11-24T00:00:00.000Z',
        hidden: false,
      },
      assistant,
    },
  };

  expect(lastAssistantId(conversation)).toBe('assistant');
  expect(
    turnStateOf(assistant, {
      lastAssistantId: 'assistant',
      now: 1_000,
      reconnect: { attempt: 2, attempts: 7, wait: 5_000, nextTryAt: 4_100, runDropped: true },
    }),
  ).toEqual({ kind: 'reconnecting', attempt: 2, attempts: 7, nextTryIn: 4, wait: 5 });
  expect(
    turnStateOf(assistant, {
      lastAssistantId: 'assistant',
      now: 1_000,
      reconnect: { attempt: 2, attempts: 7, wait: 5_000, nextTryAt: 4_100, runDropped: false },
    }),
  ).toBeUndefined();
});
