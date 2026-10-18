import { describe, expect, test } from 'bun:test';

import { toMarkdown } from '../../src';
import type { AssistantMessage, ConversationHistory, Message } from '../../src/types';
import { CURRENT_SCHEMA_VERSION } from '../../src/versioning';

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
      schemaVersion: CURRENT_SCHEMA_VERSION,
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

  describe('toMarkdown with metadata', () => {
    test('includes YAML frontmatter with conversation metadata', () => {
      const conversation = createConversation([], {
        id: 'conv-123',
        title: 'Test Conversation',
        status: 'archived',
        metadata: { key: 'value' },
        createdAt: '2024-01-15T10:00:00.000Z',
        updatedAt: '2024-01-15T10:30:00.000Z',
      });

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('---');
      expect(result).toContain('schemaVersion:');
      expect(result).toContain('id: conv-123');
      expect(result).toContain('title: Test Conversation');
      expect(result).toContain('status: archived');
      expect(result).toContain('key: value');
    });

    test('excludes title from frontmatter when undefined', () => {
      const conversation = createConversation([]);
      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).not.toContain('title:');
    });

    test('includes message metadata in YAML frontmatter keyed by message ID', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hello',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: { source: 'web' },
          hidden: true,
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('messages:');
      expect(result).toContain('msg-1:');
      expect(result).toContain('position: 0');
      expect(result).toContain('hidden: true');
      expect(result).toContain('source: web');
      expect(result).toContain('### User (msg-1)');
    });

    test('includes toolCall in message metadata', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'tool-call',
          content: 'Calling search',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
          toolCall: { id: 'call-1', name: 'search', arguments: { query: 'test' } },
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('toolCall:');
      expect(result).toContain('id: call-1');
      expect(result).toContain('name: search');
    });

    test('includes toolResult in message metadata', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'tool-call',
          content: '',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
          toolCall: { id: 'call-1', name: 'search', arguments: {} },
        },
        {
          id: 'msg-2',
          role: 'tool-result',
          content: 'Search results',
          position: 1,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
          toolResult: { callId: 'call-1', outcome: 'success', content: 'Found it' },
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('toolResult:');
      expect(result).toContain('callId: call-1');
      expect(result).toContain('outcome: success');
    });

    test('includes tokenUsage in message metadata', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'assistant',
          content: 'Response',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
          tokenUsage: { prompt: 100, completion: 50, total: 150 },
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('tokenUsage:');
      expect(result).toContain('prompt: 100');
      expect(result).toContain('completion: 50');
      expect(result).toContain('total: 150');
    });

    test('includes goalCompleted in message metadata', () => {
      const assistantMessage: AssistantMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: 'Task complete',
        position: 0,
        createdAt: '2024-01-15T10:00:00.000Z',
        metadata: {},
        hidden: false,
        goalCompleted: true,
      };
      const conversation = createConversation([assistantMessage]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('goalCompleted: true');
    });

    test('includes cacheBoundary in message metadata when set', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'system',
          content: 'Stable prefix.',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
          cacheBoundary: true,
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('cacheBoundary: true');
    });

    test('omits cacheBoundary from message metadata when unset', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'system',
          content: 'Not a boundary.',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).not.toContain('cacheBoundary');
    });

    test('includes content array in metadata for multi-modal messages', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: [
            { type: 'text', text: 'Check this:' },
            {
              type: 'image',
              source: { kind: 'remote-url', url: 'https://example.com/img.png' },
              mimeType: 'image/png',
            },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('content:');
      expect(result).toContain('mimeType: image/png');
    });
  });
});
