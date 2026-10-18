import { describe, expect, it } from 'bun:test';

import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import {
  createBrokenToolConversation,
  createToolCallConversation,
  requireRecord,
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
describe('Gemini tool content', () => {
  describe('toGeminiMessages', () => {
    it('converts tool calls to functionCall parts', () => {
      const conv = createToolCallConversation();
      const { contents } = toGeminiMessages(conv);

      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p) => 'functionCall' in p),
      );
      expect(modelContent).toBeDefined();

      const functionCallPart = requireRecord(modelContent?.parts.find((p) => 'functionCall' in p));
      expect(requireRecord(functionCallPart.functionCall).name).toBe('get_weather');
    });

    it('converts tool results to functionResponse parts', () => {
      const conv = createToolCallConversation();
      const { contents } = toGeminiMessages(conv);

      const userContent = contents.find(
        (c) => c.role === 'user' && c.parts.some((p) => 'functionResponse' in p),
      );
      expect(userContent).toBeDefined();

      const responsePart = requireRecord(userContent?.parts.find((p) => 'functionResponse' in p));
      expect(requireRecord(responsePart.functionResponse).name).toBe('get_weather');
    });

    it('rejects a hosted image whose media type is unknown instead of inventing one', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [
            { type: 'image', source: { kind: 'remote-url', url: 'http://localhost/image' } },
          ],
        },
        testEnvironment,
      );

      expect(() => toGeminiMessages(conv)).toThrow(/mime-type-required/);
    });

    it('handles tool call with invalid JSON arguments', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: 'invalid json {' },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p) => 'functionCall' in p),
      );
      const functionCallPart = requireRecord(modelContent?.parts.find((p) => 'functionCall' in p));
      expect(requireRecord(functionCallPart.functionCall).args).toEqual({ _raw: 'invalid json {' });
    });

    it('skips tool-call messages without toolCall', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Hello' },
        { role: 'tool-call', content: '' },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      expect(contents).toHaveLength(1);
      expect(contents[0]?.role).toBe('user');
    });

    it('wraps non-object parsed arguments in _value', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: 'true' },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p) => 'functionCall' in p),
      );
      const functionCallPart = requireRecord(modelContent?.parts.find((p) => 'functionCall' in p));
      expect(requireRecord(functionCallPart.functionCall).args).toEqual({ _value: true });
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

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p) => 'functionCall' in p),
      );
      const functionCallPart = requireRecord(modelContent?.parts.find((p) => 'functionCall' in p));
      expect(requireRecord(functionCallPart.functionCall).args).toEqual({ key: 'value' });
    });

    it('wraps non-object arguments in _value', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'call-1', name: 'tool', arguments: 42 },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const modelContent = contents.find(
        (c) => c.role === 'model' && c.parts.some((p) => 'functionCall' in p),
      );
      const functionCallPart = requireRecord(modelContent?.parts.find((p) => 'functionCall' in p));
      expect(requireRecord(functionCallPart.functionCall).args).toEqual({ _value: 42 });
    });

    it('wraps non-object tool results', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Do something' },
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

      const { contents } = toGeminiMessages(conv);
      const userContent = contents.find(
        (c) => c.role === 'user' && c.parts.some((p) => 'functionResponse' in p),
      );
      const responsePart = requireRecord(userContent?.parts.find((p) => 'functionResponse' in p));
      expect(requireRecord(responsePart.functionResponse).response).toEqual({ result: 'ok' });
    });

    it('preserves error and action payloads for non-success tool results', () => {
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
            action: approvalAction('Approve this request', 'approval:gemini-adapter'),
          },
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const userContent = contents.find(
        (content) =>
          content.role === 'user' && content.parts.some((part) => 'functionResponse' in part),
      );
      const responsePart = requireRecord(
        userContent?.parts.find((part) => 'functionResponse' in part),
      );

      expect(requireRecord(responsePart.functionResponse).response).toEqual({
        outcome: 'action_required',
        content: 'Need approval',
        error: {
          code: 'tool.pending',
          category: 'permission',
          retryable: false,
          message: 'Approval required',
        },
        action: approvalAction('Approve this request', 'approval:gemini-adapter'),
      });
    });

    it('rejects tool results without matching tool calls', () => {
      const conv = createBrokenToolConversation();
      expect(() => toGeminiMessages(conv)).toThrow(ConversationalistError);
    });
  });
});
