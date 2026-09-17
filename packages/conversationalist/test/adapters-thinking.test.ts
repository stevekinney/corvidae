import { describe, expect, it } from 'bun:test';
import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import type { AnthropicConversation } from '../src/adapters/anthropic/types';
import { requireRecordArray } from './adapter-test-fixtures';

describe('C3 — Extended-thinking content blocks (Anthropic adapter)', () => {
  const THINKING_SIGNATURE = 'EqoBCkgIARABGAIiQL8gy6bfP3E5example_signature==';
  const REDACTED_DATA = 'EqoBCkgIARRedactedData==';

  it('round-trips a thinking block through fromAnthropicMessages → toAnthropicMessages, preserving signature byte-for-byte', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Let me think... 2+2 is 4',
              signature: THINKING_SIGNATURE,
            },
            { type: 'text', text: 'The answer is 4.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    // Should have user and assistant messages
    expect(roundTripped.messages).toHaveLength(2);
    const assistantBlocks = roundTripped.messages[1]?.content;
    expect(Array.isArray(assistantBlocks)).toBe(true);

    const thinkingBlock = requireRecordArray(assistantBlocks).find((b) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock?.thinking).toBe('Let me think... 2+2 is 4');
    // Signature must be byte-for-byte identical
    expect(thinkingBlock?.signature).toBe(THINKING_SIGNATURE);

    const textBlock = requireRecordArray(assistantBlocks).find((b) => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock?.text).toBe('The answer is 4.');
  });

  it('round-trips a redacted_thinking block, preserving data byte-for-byte', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Tell me something' },
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: REDACTED_DATA },
            { type: 'text', text: 'Here is my response.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    expect(roundTripped.messages).toHaveLength(2);
    const assistantBlocks = roundTripped.messages[1]?.content;
    expect(Array.isArray(assistantBlocks)).toBe(true);

    const redactedBlock = requireRecordArray(assistantBlocks).find(
      (b) => b.type === 'redacted_thinking',
    );
    expect(redactedBlock).toBeDefined();
    // Signature must be byte-for-byte identical
    expect(redactedBlock?.data).toBe(REDACTED_DATA);
  });

  it('preserves block order: thinking → text → tool_use in a round-trip', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should check weather', signature: THINKING_SIGNATURE },
            { type: 'text', text: 'Let me look that up.' },
            { type: 'tool_use', id: 'call-weather', name: 'get_weather', input: { city: 'NYC' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-weather', content: '{"temp": 72}' }],
        },
        {
          role: 'assistant',
          content: 'The weather in NYC is 72°F.',
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    // Find the assistant message that has thinking + text blocks
    const assistantMsgWithThinking = roundTripped.messages.find(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        requireRecordArray(m.content).some((b) => b.type === 'thinking'),
    );
    expect(assistantMsgWithThinking).toBeDefined();

    const blocks = requireRecordArray(assistantMsgWithThinking?.content);
    // Block order must be preserved
    expect(blocks[0]?.type).toBe('thinking');
    expect(blocks[0]?.signature).toBe(THINKING_SIGNATURE);
    expect(blocks[1]?.type).toBe('text');
  });

  it('does not drop thinking blocks during compaction / toAnthropicMessages export', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Summarize' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Internal reasoning here',
              signature: THINKING_SIGNATURE,
            },
            { type: 'text', text: 'Here is a summary.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    // Re-export should still have the thinking block
    const exported = toAnthropicMessages(conversation);
    const assistantContent = exported.messages.find((m) => m.role === 'assistant')?.content;
    expect(Array.isArray(assistantContent)).toBe(true);

    const thinkingBlock = requireRecordArray(assistantContent).find((b) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock?.signature).toBe(THINKING_SIGNATURE);
  });

  it('preserves a trailing thinking block that has no following text block', () => {
    // Exercises the flush of accumulated content at the end of a turn: an
    // assistant message whose only content is a thinking block.
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Think only' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Reasoning, no answer yet',
              signature: THINKING_SIGNATURE,
            },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistantContent = roundTripped.messages.find((m) => m.role === 'assistant')?.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    const thinkingBlock = requireRecordArray(assistantContent).find((b) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock?.thinking).toBe('Reasoning, no answer yet');
    expect(thinkingBlock?.signature).toBe(THINKING_SIGNATURE);
  });

  it('preserves a trailing redacted_thinking block that has no following text block', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Redacted only' },
        {
          role: 'assistant',
          content: [{ type: 'redacted_thinking', data: REDACTED_DATA }],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistantContent = roundTripped.messages.find((m) => m.role === 'assistant')?.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    const redactedBlock = requireRecordArray(assistantContent).find(
      (b) => b.type === 'redacted_thinking',
    );
    expect(redactedBlock).toBeDefined();
    expect(redactedBlock?.data).toBe(REDACTED_DATA);
  });

  it('preserves citations on a cited text block through the round-trip', () => {
    const citations = [
      { type: 'web_search_result_location', url: 'https://example.com', cited_text: 'fact' },
    ];
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Cite a source' },
        {
          role: 'assistant',
          // A cited text block carries a citations array Anthropic needs for replay.
          content: [{ type: 'text', text: 'Here is a fact.', citations }],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistantContent = roundTripped.messages.find((m) => m.role === 'assistant')?.content;
    // Single cited text block collapses to a multi-part array (citations make it
    // non-plain); the citations must survive.
    const textBlock = Array.isArray(assistantContent)
      ? requireRecordArray(assistantContent).find((b) => b.type === 'text')
      : undefined;
    expect(textBlock).toBeDefined();
    expect(textBlock?.text).toBe('Here is a fact.');
    expect(textBlock?.['citations']).toEqual(citations);
  });
});
