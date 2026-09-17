import { describe, expect, test } from 'bun:test';

import { toMarkdown } from '../../src';
import type { AssistantMessage, ConversationHistory, Message } from '../../src/types';

type ConversationMessage = Message | AssistantMessage;

type ConversationOverrides = Partial<Omit<ConversationHistory, 'messages' | 'ids'>> & {
  messages?: ConversationMessage[];
  ids?: string[];
};

const toMessageRecord = (messages: ConversationMessage[]): Record<string, Message> =>
  messages.reduce<Record<string, Message>>((acc, message) => {
    acc[message.id] = message;
    return acc;
  }, {});

describe('toMarkdown', () => {
  const createConversation = (
    messages: ConversationMessage[],
    overrides: ConversationOverrides = {},
  ): ConversationHistory => {
    const { messages: overrideMessages, ids, ...rest } = overrides;
    const baseMessages = overrideMessages ?? messages;
    const baseIds = ids ?? baseMessages.map((message) => message.id);

    return {
      schemaVersion: 1,
      id: 'conv-1',
      status: 'active',
      metadata: {},
      createdAt: '2024-01-15T10:00:00.000Z',
      updatedAt: '2024-01-15T10:00:00.000Z',
      ...rest,
      messages: toMessageRecord(baseMessages),
      ids: baseIds,
    };
  };

  describe('toMarkdown export options', () => {
    test('omits hidden messages when includeHidden is false', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: 'Visible',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-2',
          role: 'system',
          content: 'Secret',
          position: 1,
          createdAt: '2024-01-15T10:01:00.000Z',
          metadata: {},
          hidden: true,
        },
      ]);

      const result = toMarkdown(conversation, { includeHidden: false });
      expect(result).toContain('Visible');
      expect(result).not.toContain('Secret');
      expect(result).not.toContain('### System');
    });

    test('redacts hidden message content when requested', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: 'Visible',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-2',
          role: 'system',
          content: 'Secret',
          position: 1,
          createdAt: '2024-01-15T10:01:00.000Z',
          metadata: {},
          hidden: true,
        },
      ]);

      const result = toMarkdown(conversation, {
        redactHiddenContent: true,
        redactedPlaceholder: '[HIDDEN]',
      });

      expect(result).toContain('### System');
      expect(result).toContain('[HIDDEN]');
      expect(result).not.toContain('Secret');
    });

    test('stripTransient removes transient metadata in frontmatter', () => {
      const conversation = createConversation(
        [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Hello',
            position: 0,
            createdAt: '2024-01-15T10:00:00.000Z',
            metadata: { _temp: 'nope', source: 'web' },
            hidden: false,
          },
        ],
        {
          metadata: { _draft: true, owner: 'test' },
        },
      );

      const result = toMarkdown(conversation, {
        includeMetadata: true,
        stripTransient: true,
      });

      expect(result).toContain('owner: test');
      expect(result).toContain('source: web');
      expect(result).not.toContain('_draft');
      expect(result).not.toContain('_temp');
    });

    test('redacts tool metadata in markdown frontmatter', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'tool-call',
          content: 'Calling tool',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
          toolCall: { id: 'call-1', name: 'search', arguments: 'secret args' },
        },
        {
          id: 'msg-2',
          role: 'tool-result',
          content: 'Result',
          position: 1,
          createdAt: '2024-01-15T10:01:00.000Z',
          metadata: {},
          hidden: false,
          toolResult: {
            callId: 'call-1',
            outcome: 'error',
            content: 'secret result',
          },
        },
      ]);

      const result = toMarkdown(conversation, {
        includeMetadata: true,
        redactToolArguments: true,
        redactToolResults: true,
        redactedPlaceholder: '[MASKED]',
      });

      expect(result).toContain('[MASKED]');
      expect(result).not.toContain('secret args');
      expect(result).not.toContain('secret result');
      expect(result).toContain('call-1');
      expect(result).toContain('search');
    });

    test('redacts structural tool-result block content (web_search/code-execution) in assistant content', () => {
      const conversation = createConversation([
        {
          id: 'm1',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Result below.' },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'stu-1',
              content: [{ snippet: 'leaked-secret-snippet' }],
            },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      // includeMetadata embeds the (redacted) content JSON, so the placeholder
      // is observable and we can prove the secret never reaches the output.
      const result = toMarkdown(conversation, {
        includeMetadata: true,
        redactToolResults: true,
        redactedPlaceholder: '[MASKED]',
      });

      expect(result).not.toContain('leaked-secret-snippet');
      expect(result).toContain('[MASKED]');
    });

    test('masks server_tool_use input under redactToolArguments (even when redactToolResults is false)', () => {
      const conversation = createConversation([
        {
          id: 'm1',
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 'stu-1',
              name: 'web_search',
              input: { query: 'leaked-secret-query' },
            },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation, {
        includeMetadata: true,
        redactToolArguments: true,
        redactToolResults: false,
        redactedPlaceholder: '[MASKED]',
      });

      expect(result).not.toContain('leaked-secret-query');
      expect(result).toContain('[MASKED]');
    });

    test('removes cited-text citation metadata under redactToolResults (drops the field, not a scalar)', () => {
      const conversation = createConversation([
        {
          id: 'm1',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'See source.',
              citations: [{ cited_text: 'leaked-cited-secret', url: 'https://leaked.example.com' }],
            },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation, {
        includeMetadata: true,
        redactToolResults: true,
        redactedPlaceholder: '[MASKED]',
      });

      // The citation evidence is gone, and the citations field is removed entirely
      // (not scalarized to a malformed string) — so no 'citations' key leaks either.
      expect(result).not.toContain('leaked-cited-secret');
      expect(result).not.toContain('leaked.example.com');
      expect(result).not.toContain('citations');
      // The visible text is preserved.
      expect(result).toContain('See source.');
    });

    test('preserves cited text and non-tool multimodal blocks when tool-result redaction is disabled', () => {
      const conversation = createConversation([
        {
          id: 'm1',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'See source.',
              citations: [{ cited_text: 'visible citation', url: 'https://visible.example.com' }],
            },
            { type: 'container_upload', file_id: 'file-1' },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation, {
        includeMetadata: true,
        redactToolArguments: true,
        redactToolResults: false,
      });

      expect(result).toContain('visible citation');
      expect(result).toContain('container_upload');
      expect(result).toContain('file-1');
    });
  });
});
