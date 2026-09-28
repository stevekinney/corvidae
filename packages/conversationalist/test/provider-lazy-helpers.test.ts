import { describe, expect, it } from 'bun:test';

import { anthropicConversationAdapter } from '../src/adapters/anthropic';
import { appendAnthropicMessages, fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import type { AnthropicConversation } from '../src/adapters/anthropic/types';
import { geminiConversationAdapter } from '../src/adapters/gemini';
import { appendGeminiMessages, fromGeminiMessages } from '../src/adapters/gemini/inbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import type { GeminiConversation } from '../src/adapters/gemini/types';
import { openAIConversationAdapter } from '../src/adapters/openai';
import { appendOpenAIMessages, fromOpenAIMessages } from '../src/adapters/openai/inbound';
import { toOpenAIMessages, toOpenAIMessagesGrouped } from '../src/adapters/openai/outbound';
import type { OpenAIMessage } from '../src/adapters/openai/types';
import { createConversationHistory } from '../src/conversation';
import { Conversation } from '../src/history';
import type { Message } from '../src/types';

const getOrderedMessages = (messages: {
  ids: ReadonlyArray<string>;
  messages: Readonly<Record<string, Message>>;
}): Message[] =>
  messages.ids
    .map((id) => messages.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('Conversation lazy provider helpers', () => {
  it('supports the generic fromProvider, toProvider, and appendProvider helpers', async () => {
    const payload: OpenAIMessage[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Let me call a tool.',
        tool_calls: [
          {
            id: 'call-generic',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: JSON.stringify({ city: 'Denver' }),
            },
          },
        ],
      },
    ];

    const conversation = await Conversation.fromProvider('openai', payload);
    expect(getOrderedMessages(conversation.current).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool-call',
    ]);

    expect(await conversation.toProvider('openai', { groupToolCalls: true })).toEqual(
      toOpenAIMessagesGrouped(conversation.current),
    );

    const appendedConversation = new Conversation();
    await appendedConversation.appendProvider('openai', payload);
    expect(getOrderedMessages(appendedConversation.current).map((message) => message.role)).toEqual(
      ['user', 'assistant', 'tool-call'],
    );
  });

  it('imports from and exports to OpenAI lazily', async () => {
    const payload: OpenAIMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    const conversation = await Conversation.fromOpenAIMessages(payload);
    const standalone = fromOpenAIMessages(payload);

    expect(conversation.current.ids).toHaveLength(standalone.ids.length);
    expect(getOrderedMessages(conversation.current).map((message) => message.role)).toEqual(
      getOrderedMessages(standalone).map((message) => message.role),
    );
    expect(await conversation.toOpenAIMessages()).toEqual(toOpenAIMessages(conversation.current));
    expect(await conversation.toOpenAIMessagesGrouped()).toEqual(
      toOpenAIMessagesGrouped(conversation.current),
    );
  });

  it('imports from and exports to Anthropic lazily', async () => {
    const payload: AnthropicConversation = {
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const conversation = await Conversation.fromAnthropicMessages(payload);
    const standalone = fromAnthropicMessages(payload);

    expect(conversation.current.ids).toHaveLength(standalone.ids.length);
    expect(getOrderedMessages(conversation.current).map((message) => message.role)).toEqual(
      getOrderedMessages(standalone).map((message) => message.role),
    );
    expect(await conversation.toAnthropicMessages()).toEqual(
      toAnthropicMessages(conversation.current),
    );
  });

  it('imports from and exports to Gemini lazily', async () => {
    const payload: GeminiConversation = {
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    };

    const conversation = await Conversation.fromGeminiMessages(payload);
    const standalone = fromGeminiMessages(payload);

    expect(conversation.current.ids).toHaveLength(standalone.ids.length);
    expect(getOrderedMessages(conversation.current).map((message) => message.role)).toEqual(
      getOrderedMessages(standalone).map((message) => message.role),
    );
    expect(await conversation.toGeminiMessages()).toEqual(toGeminiMessages(conversation.current));
  });

  it('appends provider payloads through the direct adapter helpers', () => {
    const openAIConversation = appendOpenAIMessages(createConversationHistory(), [
      { role: 'user', content: 'Hello from OpenAI' },
    ]);
    expect(getOrderedMessages(openAIConversation)[0]?.content).toBe('Hello from OpenAI');
    expect(appendOpenAIMessages(openAIConversation, [])).toBe(openAIConversation);
    expect(
      getOrderedMessages(
        openAIConversationAdapter.append(createConversationHistory(), [
          { role: 'assistant', content: 'Adapter append' },
        ]),
      ).map((message) => message.content),
    ).toEqual(
      getOrderedMessages(
        fromOpenAIMessages([{ role: 'assistant', content: 'Adapter append' }]),
      ).map((message) => message.content),
    );

    const anthropicPayload: AnthropicConversation = {
      messages: [{ role: 'user', content: 'Hello from Anthropic' }],
    };
    const anthropicConversation = appendAnthropicMessages(
      createConversationHistory(),
      anthropicPayload,
    );
    expect(getOrderedMessages(anthropicConversation)[0]?.content).toBe('Hello from Anthropic');
    const emptyAnthropicConversation = createConversationHistory();
    expect(appendAnthropicMessages(emptyAnthropicConversation, { messages: [] })).toBe(
      emptyAnthropicConversation,
    );
    expect(
      getOrderedMessages(
        anthropicConversationAdapter.append(createConversationHistory(), anthropicPayload),
      ).map((message) => message.content),
    ).toEqual(
      getOrderedMessages(fromAnthropicMessages(anthropicPayload)).map((message) => message.content),
    );

    const geminiPayload: GeminiConversation = {
      contents: [{ role: 'user', parts: [{ text: 'Hello from Gemini' }] }],
    };
    const geminiConversation = appendGeminiMessages(createConversationHistory(), geminiPayload);
    expect(getOrderedMessages(geminiConversation)[0]?.content).toBe('Hello from Gemini');
    const emptyGeminiConversation = createConversationHistory();
    expect(appendGeminiMessages(emptyGeminiConversation, { contents: [] })).toBe(
      emptyGeminiConversation,
    );
    expect(
      getOrderedMessages(
        geminiConversationAdapter.append(createConversationHistory(), geminiPayload),
      ).map((message) => message.content),
    ).toEqual(
      getOrderedMessages(fromGeminiMessages(geminiPayload)).map((message) => message.content),
    );
  });
});
