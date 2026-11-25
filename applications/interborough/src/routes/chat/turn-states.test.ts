import { expect, test } from 'bun:test';

import { createConversation, type ConversationHistory, type Message } from '@lostgradient/chat';

import { lastAssistantId, lastTurnStop, turnStateOf, withoutStopLine } from './turn-states.ts';

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

test.each([
  ['failed', true],
  ['stopped', false],
] as const)(
  'keeps an empty %s turn note on its user message instead of replacing the earlier reply',
  (_status, failed) => {
    const stoppedNote = {
      kind: 'stopped',
      id: 'stopped:new-run',
      reason: failed ? 'The provider stopped.' : 'Stopped by the person.',
      ...(failed ? { failed: true } : {}),
    };
    const conversation: ConversationHistory = {
      ...createConversation({ id: 'empty-terminal-turn' }),
      ids: ['first-user', 'first-assistant', 'latest-user'],
      messages: {
        'first-user': {
          id: 'first-user',
          role: 'user',
          content: 'First question',
          metadata: {},
          position: 0,
          createdAt: '2026-11-24T00:00:00.000Z',
          hidden: false,
        },
        'first-assistant': { ...assistant, id: 'first-assistant', position: 1 },
        'latest-user': {
          id: 'latest-user',
          role: 'user',
          content: 'Second question',
          metadata: { 'cinder:notes': [stoppedNote] },
          position: 2,
          createdAt: '2026-11-24T00:01:00.000Z',
          hidden: false,
        },
      },
    };

    expect(lastTurnStop(conversation)).toBeUndefined();
    expect(withoutStopLine(conversation, lastTurnStop(conversation))).toBe(conversation);
    expect(
      turnStateOf(conversation.messages['first-assistant']!, {
        lastAssistantId: lastAssistantId(conversation),
        now: 0,
        reconnect: undefined,
        stop: lastTurnStop(conversation)?.state,
      }),
    ).toBeUndefined();
  },
);
