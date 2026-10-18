import { describe, expect, it } from 'bun:test';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { ConversationalistError, UnsupportedContentError } from '../src/errors';
import {
  createBasicConversation,
  requireRecord,
  requireRecordArray,
  testEnvironment,
} from './adapter-test-fixtures';

describe('Gemini core content', () => {
  describe('toGeminiMessages', () => {
    it('extracts system instruction separately', () => {
      const conv = createBasicConversation();
      const { systemInstruction, contents } = toGeminiMessages(conv);

      expect(systemInstruction).toBeDefined();
      expect(systemInstruction?.parts[0]).toEqual({
        text: 'You are a helpful assistant.',
      });
      expect(contents).toHaveLength(2);
    });

    it('maps assistant to model role', () => {
      const conv = createBasicConversation();
      const { contents } = toGeminiMessages(conv);

      const assistantMsg = contents.find((c) =>
        c.parts.some((p) => 'text' in p && p.text === 'Hi there! How can I help you?'),
      );
      expect(assistantMsg?.role).toBe('model');
    });

    it('merges consecutive same-role messages', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'user', content: 'Part 1' },
        { role: 'user', content: 'Part 2' },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);

      expect(contents).toHaveLength(1);
      expect(contents[0]?.parts).toHaveLength(2);
    });

    it('handles multi-modal content with inline data', () => {
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

      const { contents } = toGeminiMessages(conv);
      const parts = requireRecordArray(contents[0]?.parts);

      expect(parts).toHaveLength(2);
      expect(requireRecord(parts[1]).inlineData).toBeDefined();
      expect(requireRecord(requireRecord(parts[1]).inlineData).mimeType).toBe('image/png');
    });

    it('handles file URIs for images', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { kind: 'remote-url', url: 'https://example.com/image.jpg' },
              mimeType: 'image/jpeg',
            },
          ],
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const parts = requireRecordArray(contents[0]?.parts);

      expect(requireRecord(parts[0]).fileData).toBeDefined();
      expect(requireRecord(requireRecord(parts[0]).fileData).fileUri).toBe(
        'https://example.com/image.jpg',
      );
      expect(requireRecord(requireRecord(parts[0]).fileData).mimeType).toBe('image/jpeg');
    });

    it('handles file URIs without mimeType', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [
            { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/image.jpg' } },
          ],
        },
        testEnvironment,
      );

      const { contents } = toGeminiMessages(conv);
      const parts = requireRecordArray(contents[0]?.parts);

      expect(requireRecord(parts[0]).fileData).toBeDefined();
      expect(requireRecord(requireRecord(parts[0]).fileData).fileUri).toBe(
        'https://example.com/image.jpg',
      );
      expect(requireRecord(requireRecord(parts[0]).fileData).mimeType).toBe('image/jpeg');
    });

    it('handles system message with empty content', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        { role: 'system', content: '' },
        { role: 'user', content: 'Hello' },
        testEnvironment,
      );

      const { systemInstruction, contents } = toGeminiMessages(conv);
      // Empty system message results in no systemInstruction
      expect(systemInstruction).toBeUndefined();
      expect(contents).toHaveLength(1);
    });

    it('rejects unknown roles before adapter formatting', () => {
      const conv = createConversation({ id: 'test' }, testEnvironment);
      expect(() =>
        // @ts-expect-error - testing runtime behavior for invalid role
        appendMessages(conv, { role: 'unknown', content: 'blah' }, testEnvironment),
      ).toThrow(ConversationalistError);
    });

    it('rejects data URLs with missing parts instead of dropping the image', () => {
      let conv = createConversation({ id: 'test' }, testEnvironment);
      conv = appendMessages(
        conv,
        {
          role: 'user',
          content: [{ type: 'image', source: { kind: 'data-url', url: 'data:image/png;base64' } }], // Invalid data URL
        },
        testEnvironment,
      );

      expect(() => toGeminiMessages(conv)).toThrow(UnsupportedContentError);
    });
  });
});
