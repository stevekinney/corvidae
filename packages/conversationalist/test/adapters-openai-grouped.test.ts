import { describe, expect, it } from 'bun:test';

import { toOpenAIMessages, toOpenAIMessagesGrouped } from '../src/adapters/openai/outbound';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { testEnvironment } from './adapter-test-fixtures';

describe('OpenAI Adapter', () => {
  describe('toOpenAIMessagesGrouped', () => {
    it('groups consecutive tool calls into single message', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do two things' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool_one', arguments: '{}' },
        },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-2', name: 'tool_two', arguments: '{}' },
        },
        testEnvironment,
      );

      const messages = toOpenAIMessagesGrouped(conv).messages;

      // Should be: user, assistant (with 2 tool_calls)
      expect(messages).toHaveLength(2);
      const groupedToolCalls = messages[1];
      if (
        !groupedToolCalls ||
        groupedToolCalls.role !== 'assistant' ||
        !('tool_calls' in groupedToolCalls)
      ) {
        throw new Error('Expected grouped tool calls');
      }
      expect(groupedToolCalls.tool_calls).toHaveLength(2);
    });

    it('flushes pending tool calls before different message type', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool_one', arguments: '{}' },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: { callId: 'call-1', outcome: 'success', content: 'done' },
        },
        { role: 'assistant', content: 'Done!' },
        testEnvironment,
      );

      const messages = toOpenAIMessagesGrouped(conv).messages;

      // Should be: user, assistant (with tool_calls), tool, assistant
      expect(messages).toHaveLength(4);
      const groupedToolCall = messages[1];
      expect(groupedToolCall?.role).toBe('assistant');
      if (
        !groupedToolCall ||
        groupedToolCall.role !== 'assistant' ||
        !('tool_calls' in groupedToolCall)
      ) {
        throw new Error('Expected grouped tool call');
      }
      expect(groupedToolCall.tool_calls).toHaveLength(1);
    });

    it('skips hidden messages in grouped mode', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Visible' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: '{}' },
          hidden: true,
        },
        testEnvironment,
      );

      const messages = toOpenAIMessagesGrouped(conv).messages;
      expect(messages).toHaveLength(1);
    });

    it('skips an assistant row that projects to no text and carries no tool call', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Think, then act' },
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Plan the call.', signature: 'sig-1' }],
        },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool_one', arguments: '{}' },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: { callId: 'call-1', outcome: 'success', content: 'ok' },
        },
        testEnvironment,
      );

      for (const messages of [
        toOpenAIMessagesGrouped(conv).messages,
        toOpenAIMessages(conv).messages,
      ]) {
        expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
        const assistant = messages[1];
        expect(assistant?.role === 'assistant' && assistant.tool_calls).toHaveLength(1);
      }
    });

    it('keeps an assistant row that carries text next to its thinking', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Plan.', signature: 'sig-1' },
            { type: 'text', text: 'Hello' },
          ],
        },
        testEnvironment,
      );

      const messages = toOpenAIMessagesGrouped(conv).messages;
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    });
  });
});
