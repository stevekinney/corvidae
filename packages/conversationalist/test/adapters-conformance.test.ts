import { describe, expect, it } from 'bun:test';
import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { fromGeminiMessages } from '../src/adapters/gemini/inbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { fromOpenAIMessages } from '../src/adapters/openai/inbound';
import { toOpenAIMessagesGrouped } from '../src/adapters/openai/outbound';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import type { ConversationHistory as Conversation } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';
import { testEnvironment } from './adapter-test-fixtures';

function buildConversation(): Conversation {
  let conv = createConversation({ id: 'conformance' }, testEnvironment);
  conv = appendMessages(
    conv,
    { role: 'system', content: 'You are a careful assistant.' },
    { role: 'user', content: 'What is the weather in NYC?' },
    {
      role: 'tool-call',
      content: '',
      toolCall: { id: 'call-1', name: 'get_weather', arguments: { location: 'NYC' } },
    },
    {
      role: 'tool-result',
      content: '',
      toolResult: { callId: 'call-1', outcome: 'success', content: { tempF: 72 } },
    },
    { role: 'assistant', content: 'It is 72°F in NYC.' },
    testEnvironment,
  );
  return conv;
}

const systemOf = (conv: Conversation) => getOrderedMessages(conv).find((m) => m.role === 'system');

describe('Cross-adapter conformance', () => {
  type NormalizedMessage =
    | { role: 'system'; text: string }
    | { role: 'user' | 'assistant'; text: string }
    | { role: 'tool-call'; name: string; callIndex: number }
    | { role: 'tool-result'; callIndex: number };

  /**
   * Normalizes call ids to their sequential appearance order rather than
   * comparing literal ids — Gemini's wire format has no id field, so
   * `fromGeminiMessages` synthesizes fresh ids on import. What must survive
   * is the PAIRING (a tool-result resolves to the right tool-call), not the
   * literal id string.
   */
  function normalize(conversation: Conversation): NormalizedMessage[] {
    const callIndexById = new Map<string, number>();
    return getOrderedMessages(conversation)
      .filter((m) => !m.hidden)
      .map((m): NormalizedMessage | undefined => {
        if (m.role === 'tool-call' && m.toolCall) {
          const callIndex = callIndexById.size;
          callIndexById.set(m.toolCall.id, callIndex);
          return { role: 'tool-call', name: m.toolCall.name, callIndex };
        }
        if (m.role === 'tool-result' && m.toolResult) {
          return { role: 'tool-result', callIndex: callIndexById.get(m.toolResult.callId) ?? -1 };
        }
        if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return { role: m.role, text };
        }
        return undefined;
      })
      .filter((m): m is NormalizedMessage => m !== undefined);
  }

  it('preserves shape through Anthropic export/import', () => {
    const original = buildConversation();
    const roundTripped = fromAnthropicMessages(toAnthropicMessages(original));
    expect(normalize(roundTripped)).toEqual(normalize(original));
  });

  it('preserves shape through OpenAI export/import', () => {
    const original = buildConversation();
    const roundTripped = fromOpenAIMessages(toOpenAIMessagesGrouped(original).messages);
    expect(normalize(roundTripped)).toEqual(normalize(original));
  });

  it('preserves shape through Gemini export/import', () => {
    const original = buildConversation();
    const roundTripped = fromGeminiMessages(toGeminiMessages(original));
    expect(normalize(roundTripped)).toEqual(normalize(original));
  });

  it('preserves a cache boundary through Anthropic but drops it (by design) through OpenAI and Gemini', () => {
    let original = createConversation({ id: 'conformance-cache' }, testEnvironment);
    original = appendMessages(
      original,
      { role: 'system', content: 'Stable prefix.', cacheBoundary: true },
      { role: 'user', content: 'Hello' },
      testEnvironment,
    );

    const throughAnthropic = fromAnthropicMessages(toAnthropicMessages(original));
    const throughOpenAI = fromOpenAIMessages(toOpenAIMessagesGrouped(original).messages);
    const throughGemini = fromGeminiMessages(toGeminiMessages(original));

    expect(systemOf(throughAnthropic)?.cacheBoundary).toBe(true);
    expect(systemOf(throughOpenAI)?.cacheBoundary).toBeUndefined();
    expect(systemOf(throughGemini)?.cacheBoundary).toBeUndefined();
  });
});
