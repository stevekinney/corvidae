import { describe, expect, it } from 'bun:test';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { toOpenAIMessages, toOpenAIMessagesGrouped } from '../src/adapters/openai/outbound';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { appendStreamingMessage } from '../src/streaming';
import { testEnvironment } from './adapter-test-fixtures';

function createConversationWithStreamingMessage(): import('../src/types').ConversationHistory {
  let conv = createConversation({ id: 'streaming-test' }, testEnvironment);
  conv = appendMessages(
    conv,
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
    testEnvironment,
  );
  const { conversation } = appendStreamingMessage(conv, 'assistant', undefined, testEnvironment);
  return conversation;
}

describe('Streaming message protection in adapters', () => {
  it('OpenAI adapter skips streaming messages in ungrouped export', () => {
    const conv = createConversationWithStreamingMessage();
    const messages = toOpenAIMessages(conv);

    // Should only have user and assistant, not the streaming message
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
  });

  it('OpenAI adapter skips streaming messages in grouped export', () => {
    const conv = createConversationWithStreamingMessage();
    const messages = toOpenAIMessagesGrouped(conv);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
  });

  it('Anthropic adapter skips streaming messages', () => {
    const conv = createConversationWithStreamingMessage();
    const { messages } = toAnthropicMessages(conv);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
  });

  it('Gemini adapter skips streaming messages', () => {
    const conv = createConversationWithStreamingMessage();
    const { contents } = toGeminiMessages(conv);

    expect(contents).toHaveLength(2);
    expect(contents[0]?.role).toBe('user');
    expect(contents[1]?.role).toBe('model');
  });
});
