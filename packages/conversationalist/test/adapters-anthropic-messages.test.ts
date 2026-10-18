import { describe, expect, it } from 'bun:test';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { ConversationalistError, UnsupportedContentError } from '../src/errors';
import {
  createBasicConversation,
  createToolCallConversation,
  requireRecord,
  requireRecordArray,
  testEnvironment,
} from './adapter-test-fixtures';

describe('Anthropic Adapter', () => {
  describe('toAnthropicMessages', () => {
    it('extracts system message separately', () => {
      const conv = createBasicConversation();
      const { system, messages } = toAnthropicMessages(conv);

      expect(system).toBe('You are a helpful assistant.');
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe('user');
      expect(messages[1]?.role).toBe('assistant');
    });

    it('converts tool calls to tool_use blocks', () => {
      const conv = createToolCallConversation();
      const { messages } = toAnthropicMessages(conv);

      // Find the assistant message with tool_use
      const assistantMsg = messages.find((m) => m.role === 'assistant' && Array.isArray(m.content));
      expect(assistantMsg).toBeDefined();

      const toolUseBlock = requireRecordArray(assistantMsg?.content)?.find(
        (b) => b.type === 'tool_use',
      );
      expect(toolUseBlock).toBeDefined();
      expect(toolUseBlock?.name).toBe('get_weather');
      expect(toolUseBlock?.id).toBe('call-123');
    });

    it('converts tool results to tool_result blocks', () => {
      const conv = createToolCallConversation();
      const { messages } = toAnthropicMessages(conv);

      // Tool results go in user messages for Anthropic
      const userMsgWithResult = messages.find(
        (m) =>
          m.role === 'user' &&
          Array.isArray(m.content) &&
          requireRecordArray(m.content).some((b) => b.type === 'tool_result'),
      );
      expect(userMsgWithResult).toBeDefined();
    });

    it('merges consecutive same-role messages', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Part 1' },
        { role: 'user', content: 'Part 2' },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);

      // Should be merged into one user message with content blocks
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
    });

    it('handles multi-modal content with base64 images', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            {
              type: 'image',
              source: { kind: 'data-url', url: 'data:image/png;base64,iVBORw0KGgo=' },
            },
          ],
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const content = requireRecordArray(messages[0]?.content);

      expect(content).toHaveLength(2);
      expect(requireRecord(content[1]).type).toBe('image');
      expect(requireRecord(requireRecord(content[1]).source).type).toBe('base64');
    });

    it('handles multi-modal content with URL images', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/image.jpg' } },
          ],
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const content = requireRecordArray(messages[0]?.content);

      expect(content).toHaveLength(2);
      expect(requireRecord(content[1]).type).toBe('image');
      expect(requireRecord(requireRecord(content[1]).source).type).toBe('url');
      expect(requireRecord(requireRecord(content[1]).source).url).toBe(
        'https://example.com/image.jpg',
      );
    });

    it('handles tool results with error outcome', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: '{}' },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: {
            callId: 'call-1',
            outcome: 'error',
            content: 'Something went wrong',
          },
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const userMsg = messages.find(
        (m) =>
          m.role === 'user' &&
          Array.isArray(m.content) &&
          requireRecordArray(m.content).some((b) => b.type === 'tool_result'),
      );
      const toolResult = requireRecordArray(userMsg?.content).find((b) => b.type === 'tool_result');
      expect(toolResult?.is_error).toBe(true);
    });

    it('handles multi-modal system message content', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: 'Part 2' },
          ],
        },
        { role: 'user', content: 'Hello' },
        testEnvironment,
      );

      const { system, messages } = toAnthropicMessages(conv);
      expect(system).toBe('Part 1\n\nPart 2');
      expect(messages).toHaveLength(1);
    });

    it('handles assistant multi-modal content', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Response part 1' },
            { type: 'text', text: 'Response part 2' },
          ],
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      expect(messages).toHaveLength(2);
      const assistantMsg = messages[1];
      expect(Array.isArray(assistantMsg?.content)).toBe(true);
      expect(requireRecordArray(assistantMsg?.content).length).toBe(2);
    });

    it('handles tool call with object arguments', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: { key: 'value' } },
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const assistantMsg = messages.find((m) => m.role === 'assistant');
      const toolUse = requireRecordArray(assistantMsg?.content).find((b) => b.type === 'tool_use');
      expect(toolUse?.input).toEqual({ key: 'value' });
    });

    it('skips tool-call messages without toolCall', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'tool-call', content: '' },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
    });

    it('falls back to raw arguments for invalid JSON tool calls', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: '{invalid' },
        },
        testEnvironment,
      );

      const { messages } = toAnthropicMessages(conv);
      const assistantMsg = messages.find((m) => m.role === 'assistant');
      const toolUse = requireRecordArray(assistantMsg?.content).find((b) => b.type === 'tool_use');
      expect(toolUse?.input).toBe('{invalid');
    });

    it('rejects a data URL that carries no bytes instead of sending it as a url source', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          // `data:` prefix but not a valid `data:<media>;base64,<data>` URL.
          content: [{ type: 'image', source: { kind: 'data-url', url: 'data:image/png;base64' } }],
        },
        testEnvironment,
      );

      // The part can neither vanish from the payload nor be sent as a bogus
      // `url` source: the adapter rejects it before any provider call.
      expect(() => toAnthropicMessages(conv)).toThrow(UnsupportedContentError);
    });

    it('rejects unknown roles before adapter formatting', () => {
      const conv = createConversation({ id: 'test' }, testEnvironment);
      expect(() =>
        // @ts-expect-error - testing runtime behavior for invalid role
        appendMessages(conv, { role: 'unknown', content: 'blah' }, testEnvironment),
      ).toThrow(ConversationalistError);
    });
  });
});
