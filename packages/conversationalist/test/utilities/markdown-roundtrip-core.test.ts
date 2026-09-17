import { describe, expect, test } from 'bun:test';

import { fromMarkdown, toMarkdown } from '../../src';
import type { AssistantMessage, ConversationHistory, Message } from '../../src/types';
import { isAssistantMessage } from '../../src/utilities';

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
const getOrderedMessages = (conversation: ConversationHistory): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));
const createMessage = (overrides: Partial<Message>): Message => ({
  id: 'msg-1',
  role: 'user',
  content: 'Hello',
  position: 0,
  createdAt: '2024-01-15T10:00:00.000Z',
  metadata: {},
  hidden: false,
  ...overrides,
});
const createAssistantMessage = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: 'msg-1',
  role: 'assistant',
  content: 'Hello',
  position: 0,
  createdAt: '2024-01-15T10:00:00.000Z',
  metadata: {},
  hidden: false,
  ...overrides,
});
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

describe('markdown-roundtrip-core', () => {
  test('round-trip preserves empty conversation', () => {
    const original = createConversation([]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(parsed.id).toBe(original.id);
    expect(parsed.status).toBe(original.status);
    expect(parsed.metadata).toEqual(original.metadata);
    expect(getOrderedMessages(parsed)).toHaveLength(0);
    expect(parsed.createdAt).toBe(original.createdAt);
    expect(parsed.updatedAt).toBe(original.updatedAt);
  });

  test('round-trip preserves conversation with title', () => {
    const original = createConversation([], { title: 'Test Conversation' });
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(parsed.title).toBe(original.title);
  });

  test('round-trip preserves conversation metadata', () => {
    const original = createConversation([], {
      metadata: { key: 'value', nested: { a: 1, b: 'two' } },
    });
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(parsed.metadata).toEqual(original.metadata);
  });

  test('round-trip preserves conversation status', () => {
    const statuses = ['active', 'archived', 'deleted'] as const;
    for (const status of statuses) {
      const original = createConversation([], { status });
      const markdown = toMarkdown(original, { includeMetadata: true });
      const parsed = fromMarkdown(markdown);
      expect(parsed.status).toBe(status);
    }
  });

  test('round-trip preserves simple text message', () => {
    const original = createConversation([createMessage({ id: 'msg-1', content: 'Hello, world!' })]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)).toHaveLength(1);
    expect(getOrderedMessages(parsed)[0]!.id).toBe('msg-1');
    expect(getOrderedMessages(parsed)[0]!.content).toBe('Hello, world!');
  });

  test('round-trip preserves all message roles', () => {
    const roles = [
      'user',
      'assistant',
      'system',
      'developer',
      'tool-call',
      'tool-result',
      'snapshot',
    ] as const;
    const messages = roles.map((role, i) =>
      createMessage({
        id: `msg-${i}`,
        role,
        content: `${role} message`,
        position: i,
        createdAt: `2024-01-15T10:0${i}:00.000Z`,
      }),
    );
    const original = createConversation(messages);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)).toHaveLength(7);
    for (let i = 0; i < roles.length; i++) {
      expect(getOrderedMessages(parsed)[i]!.role).toBe(roles[i]!);
    }
  });

  test('round-trip preserves message metadata', () => {
    const original = createConversation([
      createMessage({
        metadata: { source: 'web', timestamp: 12345, nested: { x: [1, 2, 3] } },
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0]!.metadata).toEqual(
      getOrderedMessages(original)[0]!.metadata,
    );
  });

  test('round-trip preserves hidden flag', () => {
    const original = createConversation([createMessage({ hidden: true })]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0]!.hidden).toBe(true);
  });

  test('round-trip preserves message positions', () => {
    const original = createConversation([
      createMessage({ id: 'msg-1', position: 0 }),
      createMessage({ id: 'msg-2', position: 1 }),
      createMessage({ id: 'msg-3', position: 2 }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0]!.position).toBe(0);
    expect(getOrderedMessages(parsed)[1]!.position).toBe(1);
    expect(getOrderedMessages(parsed)[2]!.position).toBe(2);
  });

  test('round-trip preserves message timestamps', () => {
    const original = createConversation([createMessage({ createdAt: '2024-06-15T14:30:45.123Z' })]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0]!.createdAt).toBe('2024-06-15T14:30:45.123Z');
  });

  test('round-trip preserves toolCall', () => {
    const original = createConversation([
      createMessage({
        role: 'tool-call',
        toolCall: {
          id: 'call-123',
          name: 'search_documents',
          arguments: { query: 'test', limit: 10, filters: { type: 'pdf' } },
        },
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0]!.toolCall).toEqual(
      getOrderedMessages(original)[0]!.toolCall,
    );
  });

  test('round-trip preserves toolResult', () => {
    const original = createConversation([
      createMessage({
        id: 'msg-1',
        role: 'tool-call',
        toolCall: {
          id: 'call-123',
          name: 'search_documents',
          arguments: { query: 'test' },
        },
      }),
      createMessage({
        id: 'msg-2',
        role: 'tool-result',
        position: 1,
        toolResult: {
          callId: 'call-123',
          outcome: 'error',
          content: { error: 'Not found', code: 404 },
        },
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[1]!.toolResult).toEqual(
      getOrderedMessages(original)[1]!.toolResult,
    );
  });

  test('round-trip preserves tokenUsage', () => {
    const original = createConversation([
      createMessage({
        tokenUsage: { prompt: 100, completion: 200, total: 300 },
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0]!.tokenUsage).toEqual(
      getOrderedMessages(original)[0]!.tokenUsage,
    );
  });

  test('round-trip preserves goalCompleted', () => {
    const original = createConversation([createAssistantMessage({ goalCompleted: true })]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    const message = getOrderedMessages(parsed)[0]!;
    expect(isAssistantMessage(message) && message.goalCompleted).toBe(true);
  });

  test('round-trip preserves cacheBoundary', () => {
    const original = createConversation([
      createMessage({ role: 'system', content: 'Stable prefix.', cacheBoundary: true }),
      {
        ...createMessage({ role: 'user', content: 'Not a boundary.' }),
        id: 'msg-2',
        position: 1,
      },
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    const [system, user] = getOrderedMessages(parsed);
    expect(system?.cacheBoundary).toBe(true);
    expect(user?.cacheBoundary).toBeUndefined();
  });

  test('round-trip preserves multi-modal content with images', () => {
    const original = createConversation([
      createMessage({
        content: [
          { type: 'text', text: 'Check out this image:' },
          {
            type: 'image',
            url: 'https://example.com/photo.png',
            mimeType: 'image/png',
            text: 'A beautiful sunset',
          },
        ],
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    const content = getOrderedMessages(parsed)[0]!.content;
    if (!Array.isArray(content)) throw new Error('Expected multimodal content');
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'Check out this image:' });
    expect(content[1]).toEqual({
      type: 'image',
      url: 'https://example.com/photo.png',
      mimeType: 'image/png',
      text: 'A beautiful sunset',
    });
  });
});
