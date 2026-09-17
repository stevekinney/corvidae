import { describe, expect, it } from 'bun:test';
import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import type { AnthropicConversation } from '../src/adapters/anthropic/types';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { getOrderedMessages } from '../src/utilities/message-store';
import {
  createBasicConversation,
  requireRecord,
  requireRecordArray,
  testEnvironment,
} from './adapter-test-fixtures';

describe('Anthropic Adapter cache boundaries', () => {
  describe('cacheBoundary → cache_control', () => {
    it('lowers a cache-boundary system message to a system block with cache_control', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'system', content: 'Shared contract.', cacheBoundary: true },
        { role: 'system', content: 'Task-specific context.' },
        { role: 'user', content: 'Hello' },
        testEnvironment,
      );

      const { system } = toAnthropicMessages(conv);

      expect(Array.isArray(system)).toBe(true);
      const blocks = requireRecordArray(system);
      expect(blocks).toEqual([
        { type: 'text', text: 'Shared contract.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Task-specific context.' },
      ]);
    });

    it('uses a plain joined string for system when no message carries a cache boundary', () => {
      const conv = createBasicConversation();
      const { system } = toAnthropicMessages(conv);
      expect(typeof system).toBe('string');
    });

    it('attaches cache_control to the last content block of a cache-boundary message', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First part' },
            { type: 'text', text: 'Second part' },
          ],
          cacheBoundary: true,
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const blocks = requireRecordArray(messages[0]?.content);

      expect(blocks).toHaveLength(2);
      expect(requireRecord(blocks[0]).cache_control).toBeUndefined();
      expect(requireRecord(blocks[1]).cache_control).toEqual({ type: 'ephemeral' });
    });

    it('does not collapse a lone cache-boundary text block to a bare string', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Stable prefix message', cacheBoundary: true },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);

      expect(Array.isArray(messages[0]?.content)).toBe(true);
      const blocks = requireRecordArray(messages[0]?.content);
      expect(blocks).toEqual([
        { type: 'text', text: 'Stable prefix message', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('round-trips a cache boundary through toAnthropicMessages/fromAnthropicMessages', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'system', content: 'Shared contract.', cacheBoundary: true },
        { role: 'user', content: 'Stable prefix message', cacheBoundary: true },
        testEnvironment,
      );

      const anthropicPayload = toAnthropicMessages(conv);
      const roundTripped = fromAnthropicMessages(anthropicPayload);
      const messages = Object.values(roundTripped.messages).toSorted(
        (a, b) => a.position - b.position,
      );

      expect(messages[0]?.role).toBe('system');
      expect(messages[0]?.cacheBoundary).toBe(true);
      expect(messages[1]?.role).toBe('user');
      expect(messages[1]?.cacheBoundary).toBe(true);
    });

    it('splits the run at a cache_control block instead of extending the boundary to later blocks in the same Anthropic message', () => {
      // toAnthropicMessages merges consecutive same-role messages, so a
      // single Anthropic message can contain a cache_control block followed
      // by MORE blocks that came from a later, unmarked ConversationHistory
      // message. Decoding must not fold that trailing content into the
      // cache-boundary-marked message — cache_control means "up to and
      // including THIS block," not "the rest of this Anthropic message."
      const payload: AnthropicConversation = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Before the boundary' },
              {
                type: 'text',
                text: 'The stable prefix',
                cache_control: { type: 'ephemeral' },
              },
              { type: 'text', text: 'After the boundary' },
            ],
          },
        ],
      };

      const conversation = fromAnthropicMessages(payload);
      const messages = getOrderedMessages(conversation);

      expect(messages).toHaveLength(3);
      expect(messages[0]?.content).toBe('Before the boundary');
      expect(messages[0]?.cacheBoundary).toBeUndefined();
      expect(messages[1]?.content).toBe('The stable prefix');
      expect(messages[1]?.cacheBoundary).toBe(true);
      expect(messages[2]?.content).toBe('After the boundary');
      expect(messages[2]?.cacheBoundary).toBeUndefined();
    });

    it('walks back past a trailing thinking block to find a cacheable block for the boundary', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Visible answer' },
            { type: 'thinking', thinking: 'internal reasoning', signature: 'sig' },
          ],
          cacheBoundary: true,
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const blocks = requireRecordArray(messages[0]?.content);

      const thinkingBlock = blocks.find((b) => b.type === 'thinking');
      const textBlock = blocks.find((b) => b.type === 'text');
      expect(thinkingBlock?.cache_control).toBeUndefined();
      expect(textBlock?.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('does not attach cache_control when every block in the message is non-cacheable', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'internal reasoning', signature: 'sig' }],
          cacheBoundary: true,
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const blocks = requireRecordArray(messages[0]?.content);
      expect(blocks.every((b) => b.cache_control === undefined)).toBe(true);
    });

    it('caps explicit cache breakpoints at 4, stripping the earliest excess ones', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'system', content: 'Segment 1', cacheBoundary: true },
        { role: 'system', content: 'Segment 2', cacheBoundary: true },
        { role: 'user', content: 'Segment 3', cacheBoundary: true },
        { role: 'assistant', content: 'Segment 4', cacheBoundary: true },
        { role: 'user', content: 'Segment 5', cacheBoundary: true },
        testEnvironment,
      );

      const { system, messages } = toAnthropicMessages(conv);

      const systemBlocks = requireRecordArray(system);
      const allBlocks = [
        ...systemBlocks,
        ...messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
      ];
      const withBreakpoints = allBlocks.filter(
        (block) => requireRecord(block).cache_control !== undefined,
      );

      // "Segment 1" (the earliest mark) is stripped; the other 4 survive.
      expect(withBreakpoints).toHaveLength(4);
      expect(systemBlocks[0]?.['cache_control']).toBeUndefined();
      expect(systemBlocks[1]?.['cache_control']).toEqual({ type: 'ephemeral' });
    });
  });
});
