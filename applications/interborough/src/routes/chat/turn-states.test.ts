/**
 * Which turn Chat draws as reconnecting, and what it says (COR-2283 R3).
 */
import { createConversationHistory, type Message } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import type { ChatReconnect } from './chat-session.svelte.ts';
import { lastAssistantId, reconnectingTurnState, turnStateOf } from './turn-states.ts';

const NOW = 1_000_000;
const schedule = (overrides: Partial<ChatReconnect> = {}): ChatReconnect => ({
  attempt: 2,
  attempts: 7,
  wait: 1000,
  nextTryAt: NOW + 400,
  runDropped: true,
  ...overrides,
});
const message = (id: string, role: Message['role']) => ({ id, role }) as Message;

describe('the reconnecting turn', () => {
  test('is the last assistant turn of a run whose stream dropped, with its try, of how many, and the seconds left', () => {
    expect(
      turnStateOf(message('a2', 'assistant'), {
        reconnect: schedule(),
        lastAssistantId: 'a2',
        now: NOW,
      }),
    ).toEqual({ kind: 'reconnecting', attempt: 2, attempts: 7, nextTryIn: 1, wait: 1 });
  });

  test('is no turn while the stream is up, for an earlier turn, a person’s message, or a first read that failed', () => {
    const facts = { reconnect: schedule(), lastAssistantId: 'a2', now: NOW };
    expect(turnStateOf(message('a2', 'assistant'), { ...facts, reconnect: undefined })).toBe(
      undefined,
    );
    expect(turnStateOf(message('a1', 'assistant'), facts)).toBeUndefined();
    expect(turnStateOf(message('u1', 'user'), facts)).toBeUndefined();
    expect(
      turnStateOf(message('a2', 'assistant'), {
        ...facts,
        reconnect: schedule({ runDropped: false }),
      }),
    ).toBeUndefined();
  });

  test('counts down to zero and never below it', () => {
    expect(reconnectingTurnState(schedule({ nextTryAt: NOW + 7_100, wait: 8000 }), NOW)).toEqual({
      kind: 'reconnecting',
      attempt: 2,
      attempts: 7,
      nextTryIn: 8,
      wait: 8,
    });
    expect(reconnectingTurnState(schedule({ nextTryAt: NOW - 50 }), NOW).nextTryIn).toBe(0);
  });
});

describe('the last assistant turn', () => {
  test('is the last assistant row of the transcript, or none', () => {
    const conversation = createConversationHistory({ id: 'c' });
    expect(lastAssistantId(conversation)).toBeUndefined();
    const filled = {
      ...conversation,
      ids: ['u1', 'a1', 'u2'],
      messages: {
        u1: message('u1', 'user'),
        a1: message('a1', 'assistant'),
        u2: message('u2', 'user'),
      },
    } as unknown as typeof conversation;
    expect(lastAssistantId(filled)).toBe('a1');
  });
});
