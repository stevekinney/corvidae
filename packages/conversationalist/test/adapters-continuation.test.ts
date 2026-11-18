/**
 * COR-2437 — a chat whose stopped turn went on, as each provider adapter sends it. The continuation
 * run is asked over the history ending in the partial reply; a hidden continuation row (the
 * Bureau's, never the person's) sits after it, and the continuation's own reply follows on later
 * requests. Each adapter must send a request its provider accepts: no hidden row, and no two
 * consecutive messages of one role where the provider refuses them.
 */
import { describe, expect, it } from 'bun:test';

import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { toOpenAIMessagesGrouped } from '../src/adapters/openai/outbound';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import type { ConversationHistory } from '../src/types';
import { testEnvironment } from './adapter-test-fixtures';

const PARTIAL = 'I can refund the full amount to the';
const CONTINUED = 'card on file, and the refund is on its way.';

/** The history the continuation run is asked over: it ends in the partial reply. */
function askedOver(): ConversationHistory {
  return appendMessages(
    createConversation(undefined, testEnvironment),
    { role: 'user', content: 'Please refund order 4471.' },
    { role: 'assistant', content: PARTIAL },
    { role: 'user', content: 'Continue the answer from where it stopped.', hidden: true },
    testEnvironment,
  );
}

/** The history a later request sends: the continuation's reply follows the partial one. */
function wentOn(): ConversationHistory {
  return appendMessages(
    askedOver(),
    { role: 'assistant', content: CONTINUED },
    { role: 'user', content: 'Thanks.' },
    testEnvironment,
  );
}

const roles = (messages: ReadonlyArray<{ readonly role: string }>) =>
  messages.map((message) => message.role);

const consecutive = (sequence: readonly string[]) =>
  sequence.some((role, index) => index > 0 && sequence[index - 1] === role);

const textOf = (value: unknown): string => JSON.stringify(value);

describe('a stopped turn that went on, through each adapter', () => {
  it('Anthropic: sends no hidden row, ends the continuation request in the partial reply, and never two messages of one role', () => {
    const asked = toAnthropicMessages(askedOver()).messages;
    expect(roles(asked)).toEqual(['user', 'assistant']);
    expect(textOf(asked)).not.toContain('Continue the answer');
    expect(textOf(asked.at(-1))).toContain(PARTIAL);

    // Anthropic refuses consecutive messages of one role: the adapter merges the two replies.
    const later = toAnthropicMessages(wentOn()).messages;
    expect(consecutive(roles(later))).toBe(false);
    expect(textOf(later)).toContain(PARTIAL);
    expect(textOf(later)).toContain(CONTINUED);
  });

  it('Gemini: sends no hidden row, ends the continuation request in the partial reply, and never two contents of one role', () => {
    const asked = toGeminiMessages(askedOver()).contents;
    expect(roles(asked)).toEqual(['user', 'model']);
    expect(textOf(asked)).not.toContain('Continue the answer');
    expect(textOf(asked.at(-1))).toContain(PARTIAL);

    const later = toGeminiMessages(wentOn()).contents;
    expect(consecutive(roles(later))).toBe(false);
    expect(textOf(later)).toContain(CONTINUED);
  });

  it('OpenAI: sends no hidden row and ends the continuation request in the partial reply; consecutive assistant messages are accepted as sent', () => {
    const asked = toOpenAIMessagesGrouped(askedOver()).messages;
    expect(roles(asked)).toEqual(['user', 'assistant']);
    expect(textOf(asked)).not.toContain('Continue the answer');
    expect(textOf(asked.at(-1))).toContain(PARTIAL);

    // Chat Completions takes consecutive assistant messages, so the adapter sends both replies.
    const later = toOpenAIMessagesGrouped(wentOn()).messages;
    expect(roles(later)).toEqual(['user', 'assistant', 'assistant', 'user']);
  });
});
