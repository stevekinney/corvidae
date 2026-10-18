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

  describe('toMarkdown default behavior', () => {
    test('outputs empty string for empty conversation', () => {
      const conversation = createConversation([]);
      const result = toMarkdown(conversation);
      expect(result).toBe('');
    });

    test('outputs simple markdown without frontmatter', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hello, world!',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).not.toContain('---');
      expect(result).not.toContain('<!--');
      expect(result).toContain('### User');
      expect(result).not.toContain('(2024-01-15'); // No timestamp in simple mode
      expect(result).toContain('Hello, world!');
    });

    test('formats multiple messages correctly', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hi there',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Hello! How can I help?',
          position: 1,
          createdAt: '2024-01-15T10:01:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).toContain('### User');
      expect(result).toContain('Hi there');
      expect(result).toContain('### Assistant');
      expect(result).toContain('Hello! How can I help?');
    });

    test('formats all role types correctly', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'system',
          content: 'System',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-2',
          role: 'developer',
          content: 'Dev',
          position: 1,
          createdAt: '2024-01-15T10:01:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-3',
          role: 'tool-call',
          content: 'Tool',
          position: 2,
          createdAt: '2024-01-15T10:02:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-4',
          role: 'tool-result',
          content: 'Result',
          position: 3,
          createdAt: '2024-01-15T10:03:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-5',
          role: 'snapshot',
          content: 'Snap',
          position: 4,
          createdAt: '2024-01-15T10:04:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).toContain('### System');
      expect(result).toContain('### Developer');
      expect(result).toContain('### Tool Call');
      expect(result).toContain('### Tool Result');
      expect(result).toContain('### Snapshot');
    });

    test('renders images with alt text', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: [
            {
              type: 'image',
              source: { kind: 'remote-url', url: 'https://example.com/photo.jpg' },
              alt: 'A cat',
            },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).toContain('![A cat](https://example.com/photo.jpg)');
    });

    test('uses "image" as default alt text', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: [
            { type: 'image', source: { kind: 'remote-url', url: 'https://example.com/photo.jpg' } },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).toContain('![image](https://example.com/photo.jpg)');
    });

    test('renders document reference fallbacks', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: [
            {
              type: 'document',
              name: 'notes.md',
              mimeType: 'text/markdown',
              source: { kind: 'local-file', path: '/workspace/notes.md' },
            },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).toContain('[Document: notes.md (text/markdown) at /workspace/notes.md]');
    });

    test('skips empty text parts', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: [
            { type: 'text', text: 'Valid' },
            { type: 'text', text: '' },
            { type: 'text', text: '' },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).toContain('Valid');
    });
  });
});
