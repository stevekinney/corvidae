import { describe, expect, it } from 'bun:test';

import { toOpenAIMessages } from '../src/adapters/openai/outbound';
import { simpleTokenEstimator } from '../src/context';
import { truncateToTokenLimit } from '../src/context-truncation';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import {
  createBasicConversation,
  createMultiModalConversation,
  createToolCallConversation,
  requireRecordArray,
  requireString,
  testEnvironment,
} from './adapter-test-fixtures';

function approvalAction(message: string, idempotencyKey: string) {
  return {
    type: 'approval' as const,
    message,
    risk: 'high' as const,
    operation: { kind: 'other' as const },
    policyVersion: 'policy:test',
    idempotencyKey,
  };
}
function assertToolCallMessage(
  message: ReturnType<typeof toOpenAIMessages>[number] | undefined,
): void {
  expect(message?.role).toBe('assistant');
  if (!message || message.role !== 'assistant' || !('tool_calls' in message))
    throw new Error('Expected tool call message with tool_calls');
  expect(message.content).toBeNull();
  expect(message.tool_calls).toHaveLength(1);
  expect(message.tool_calls?.[0]?.id).toBe('call-123');
  expect(message.tool_calls?.[0]?.function.name).toBe('get_weather');
}

function assertToolResultMessage(
  message: ReturnType<typeof toOpenAIMessages>[number] | undefined,
): void {
  expect(message?.role).toBe('tool');
  if (!message || message.role !== 'tool' || !('tool_call_id' in message))
    throw new Error('Expected tool result message with tool_call_id');
  expect(message.tool_call_id).toBe('call-123');
}

function assertOpenAIToolMessages(messages: ReturnType<typeof toOpenAIMessages>): void {
  expect(messages).toHaveLength(4);
  assertToolCallMessage(messages[1]);
  assertToolResultMessage(messages[2]);
}

describe('OpenAI Adapter', () => {
  describe('toOpenAIMessages', () => {
    it('converts basic conversation', () => {
      const conv = createBasicConversation();
      const messages = toOpenAIMessages(conv);

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.',
      });
      expect(messages[1]).toEqual({ role: 'user', content: 'Hello' });
      expect(messages[2]).toEqual({
        role: 'assistant',
        content: 'Hi there! How can I help you?',
      });
    });

    it('converts tool calls to OpenAI format', () => {
      const conv = createToolCallConversation();
      const messages = toOpenAIMessages(conv);

      assertOpenAIToolMessages(messages);
    });

    it('converts multi-modal content', () => {
      const conv = createMultiModalConversation();
      const messages = toOpenAIMessages(conv);

      expect(messages).toHaveLength(2);
      const userMsg = messages[0];
      expect(Array.isArray(userMsg?.content)).toBe(true);
      expect(requireRecordArray(userMsg?.content)[0]).toEqual({
        type: 'text',
        text: 'What is in this image?',
      });
      expect(requireRecordArray(userMsg?.content)[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/image.jpg' },
      });
    });

    it('collapses single text parts into a string', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: [{ type: 'text', text: 'Solo' }] },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('Solo');
    });

    it('returns empty string for text-only conversion with no parts', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'assistant',
          content: [{ type: 'image', url: 'https://example.com/only-image.png' }],
        },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('assistant');
      expect(messages[0]?.content).toBe('');
    });

    it('skips hidden messages', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Visible' },
        { role: 'user', content: 'Hidden', hidden: true },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('Visible');
    });

    it('maps developer role to system', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'developer', content: 'Developer instructions' },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages[0]?.role).toBe('system');
    });

    it('skips tool-call messages without toolCall', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'tool-call', content: '' }, // No toolCall
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
    });

    it('skips tool-result messages without toolResult', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'tool-result', content: '' }, // No toolResult
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
    });

    it('skips snapshot messages', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'snapshot', content: 'snapshot data' },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe('user');
    });

    it('handles tool results with string content', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
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
            outcome: 'success',
            content: 'String result', // String content, not object
          },
        },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      const toolMsg = messages.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toBe('String result');
    });

    it('includes error and action payloads for non-success tool results', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: {} },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: {
            callId: 'call-1',
            outcome: 'action_required',
            content: 'Need approval',
            error: {
              code: 'tool.pending',
              category: 'permission',
              retryable: false,
              message: 'Approval required',
            },
            action: approvalAction('Approve this request', 'approval:openai-adapter'),
          },
        },
        testEnvironment,
      );

      const messages = toOpenAIMessages(conv);
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage?.role).toBe('tool');
      if (!toolMessage || toolMessage.role !== 'tool') {
        throw new Error('Expected tool message');
      }

      expect(JSON.parse(requireString(toolMessage.content))).toEqual({
        outcome: 'action_required',
        content: 'Need approval',
        error: {
          code: 'tool.pending',
          category: 'permission',
          retryable: false,
          message: 'Approval required',
        },
        action: approvalAction('Approve this request', 'approval:openai-adapter'),
      });
    });

    it('does not emit tool results without matching tool calls after truncation', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Run tool' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: {} },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
        },
        testEnvironment,
      );

      const truncated = truncateToTokenLimit(
        conv,
        1,
        { estimateTokens: simpleTokenEstimator, preserveLastN: 1 },
        testEnvironment,
      );
      const messages = toOpenAIMessages(truncated);

      const toolCallIds = new Set<string>();
      for (const message of messages) {
        if (message.role === 'assistant' && message.tool_calls) {
          for (const call of message.tool_calls) {
            toolCallIds.add(call.id);
          }
        }
      }

      for (const message of messages) {
        if (message.role === 'tool') {
          expect(toolCallIds.has(message.tool_call_id)).toBe(true);
        }
      }
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
