/**
 * COR-2437 — a chat whose stopped turn went on, as each provider adapter sends it. The
 * continuation run is asked over the history ending in the partial reply, then the Bureau's two
 * rows: a hidden continuation row (never sent) and a model-only instruction turn (sent to the
 * model, never shown to people). So every adapter ends the continuation request in a user turn,
 * and no provider is asked to continue a trailing assistant message (a prefill, which Anthropic
 * refuses with extended thinking on, or when the prefill ends in whitespace). The continuation's
 * own reply follows on later requests. No provider is called: the tests assert the request shape.
 */
import { describe, expect, it } from 'bun:test';

import { toAGUIMessages } from '../src/adapters/ag-ui/outbound';
import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { toOpenAIMessagesGrouped } from '../src/adapters/openai/outbound';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { MODEL_ONLY_METADATA_KEY } from '../src/model-only';
import type { ConversationHistory } from '../src/types';
import { testEnvironment } from './adapter-test-fixtures';

const PARTIAL = 'I can refund the full amount to the';
const INSTRUCTION = 'Continue from where you stopped. Do not repeat what you already wrote.';
const CONTINUED = 'card on file, and the refund is on its way.';

/** The two rows a continuation adds after the partial reply: the hidden row, the instruction. */
function continuationRows(history: ConversationHistory): ConversationHistory {
  return appendMessages(
    history,
    { role: 'user', content: 'continuation of run-1', hidden: true },
    { role: 'user', content: INSTRUCTION, metadata: { [MODEL_ONLY_METADATA_KEY]: true } },
    testEnvironment,
  );
}

/** The history the continuation run is asked over, its partial reply being `partial`. */
function askedOver(partial: string = PARTIAL): ConversationHistory {
  return continuationRows(
    appendMessages(
      createConversation(undefined, testEnvironment),
      { role: 'user', content: 'Please refund order 4471.' },
      { role: 'assistant', content: partial },
      testEnvironment,
    ),
  );
}

/** The history a later request sends: the continuation's reply follows the instruction. */
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
  it('Anthropic: ends the continuation request in the instruction turn, sends no hidden row, and never two messages of one role', () => {
    const asked = toAnthropicMessages(askedOver()).messages;
    expect(roles(asked)).toEqual(['user', 'assistant', 'user']);
    expect(textOf(asked.at(-1))).toContain(INSTRUCTION);
    expect(textOf(asked)).not.toContain('continuation of run-1');
    expect(textOf(asked.at(-2))).toContain(PARTIAL);

    const later = toAnthropicMessages(wentOn()).messages;
    expect(consecutive(roles(later))).toBe(false);
    expect(textOf(later)).toContain(CONTINUED);
  });

  it('Gemini: ends the continuation request in the instruction turn, sends no hidden row, and never two contents of one role', () => {
    const asked = toGeminiMessages(askedOver()).contents;
    expect(roles(asked)).toEqual(['user', 'model', 'user']);
    expect(textOf(asked.at(-1))).toContain(INSTRUCTION);
    expect(textOf(asked)).not.toContain('continuation of run-1');

    const later = toGeminiMessages(wentOn()).contents;
    expect(consecutive(roles(later))).toBe(false);
    expect(textOf(later)).toContain(CONTINUED);
  });

  it('OpenAI: ends the continuation request in the instruction turn and sends no hidden row', () => {
    const asked = toOpenAIMessagesGrouped(askedOver()).messages;
    expect(roles(asked)).toEqual(['user', 'assistant', 'user']);
    expect(textOf(asked.at(-1))).toContain(INSTRUCTION);
    expect(textOf(asked)).not.toContain('continuation of run-1');

    const later = toOpenAIMessagesGrouped(wentOn()).messages;
    expect(roles(later)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('a partial reply that ends in whitespace still ends each request in the instruction turn', () => {
    const history = askedOver('I can refund the full amount to the  \n');
    expect(toAnthropicMessages(history).messages.at(-1)?.role).toBe('user');
    expect(toGeminiMessages(history).contents.at(-1)?.role).toBe('user');
    expect(toOpenAIMessagesGrouped(history).messages.at(-1)?.role).toBe('user');
  });

  it('a partial reply a thinking model wrote keeps its thinking block and ends the Anthropic request in the instruction turn, so nothing is prefilled', () => {
    const thought = fromAnthropicMessages({
      messages: [
        { role: 'user', content: 'Please refund order 4471.' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Look the order up first.', signature: 'signature==' },
            { type: 'text', text: PARTIAL },
          ],
        },
      ],
    });

    const asked = toAnthropicMessages(continuationRows(thought)).messages;

    expect(roles(asked)).toEqual(['user', 'assistant', 'user']);
    expect(textOf(asked[1])).toContain('"type":"thinking"');
    expect(textOf(asked.at(-1))).toContain(INSTRUCTION);
  });

  it('the page is never shown the instruction turn or the hidden row', () => {
    const shown = toAGUIMessages(wentOn());
    expect(textOf(shown)).not.toContain(INSTRUCTION);
    expect(textOf(shown)).not.toContain('continuation of run-1');
    expect(roles(shown)).toEqual(['user', 'assistant', 'assistant', 'user']);
  });
});
