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

describe('markdown-roundtrip-complex', () => {
  test('round-trip preserves complex multi-modal content order', () => {
    const original = createConversation([
      createMessage({
        content: [
          { type: 'text', text: 'First text' },
          { type: 'image', url: 'https://example.com/1.png' },
          { type: 'text', text: 'Second text' },
          { type: 'image', url: 'https://example.com/2.png', mimeType: 'image/png' },
          { type: 'text', text: 'Third text' },
        ],
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0]!.content).toEqual(
      getOrderedMessages(original)[0]!.content,
    );
  });

  test('round-trip preserves complete complex conversation', () => {
    const originalMessages: ConversationMessage[] = [
      {
        id: 'msg-sys',
        role: 'system',
        content: 'You are a helpful assistant.',
        position: 0,
        createdAt: '2024-01-15T10:00:00.000Z',
        metadata: {},
        hidden: true,
      },
      {
        id: 'msg-user-1',
        role: 'user',
        content: [
          { type: 'text', text: 'Can you analyze this receipt?' },
          {
            type: 'image',
            url: 'https://example.com/receipt.jpg',
            mimeType: 'image/jpeg',
            text: 'Receipt image',
          },
        ],
        position: 1,
        createdAt: '2024-01-15T10:01:00.000Z',
        metadata: { source: 'mobile-app' },
        hidden: false,
      },
      {
        id: 'msg-tool-call',
        role: 'tool-call',
        content: 'Analyzing image...',
        position: 2,
        createdAt: '2024-01-15T10:01:05.000Z',
        metadata: {},
        hidden: false,
        toolCall: { id: 'call-ocr', name: 'analyze_image', arguments: { mode: 'ocr' } },
      },
      {
        id: 'msg-tool-result',
        role: 'tool-result',
        content: 'OCR completed',
        position: 3,
        createdAt: '2024-01-15T10:01:10.000Z',
        metadata: {},
        hidden: false,
        toolResult: {
          callId: 'call-ocr',
          outcome: 'success',
          content: { text: 'Total: $42.50', confidence: 0.98 },
        },
      },
      {
        id: 'msg-assistant',
        role: 'assistant',
        content: 'The receipt shows a total of $42.50.',
        position: 4,
        createdAt: '2024-01-15T10:01:15.000Z',
        metadata: { model: 'gpt-4' },
        hidden: false,
        tokenUsage: { prompt: 150, completion: 30, total: 180 },
        goalCompleted: true,
      },
    ];

    const original: ConversationHistory = {
      schemaVersion: 1,
      id: 'conv-complex-123',
      title: 'Complex Test Conversation',
      status: 'archived',
      metadata: { department: 'support', priority: 'high' },
      ids: originalMessages.map((message) => message.id),
      createdAt: '2024-01-15T10:00:00.000Z',
      updatedAt: '2024-01-15T12:30:00.000Z',
      messages: toMessageRecord(originalMessages),
    };

    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    // Verify conversation-level properties
    expect(parsed.id).toBe(original.id);
    expect(parsed.title).toBe(original.title);
    expect(parsed.status).toBe(original.status);
    expect(parsed.metadata).toEqual(original.metadata);
    expect(parsed.createdAt).toBe(original.createdAt);
    expect(parsed.updatedAt).toBe(original.updatedAt);

    // Verify message count
    expect(getOrderedMessages(parsed)).toHaveLength(5);

    // Verify each message
    for (let i = 0; i < getOrderedMessages(original).length; i++) {
      const originalMsg = getOrderedMessages(original)[i];
      const parsedMsg = getOrderedMessages(parsed)[i];
      if (originalMsg === undefined || parsedMsg === undefined) {
        throw new Error('expected matching serialized messages');
      }

      expect(parsedMsg.id).toBe(originalMsg.id);
      expect(parsedMsg.role).toBe(originalMsg.role);
      expect(parsedMsg.position).toBe(originalMsg.position);
      expect(parsedMsg.createdAt).toBe(originalMsg.createdAt);
      expect(parsedMsg.metadata).toEqual(originalMsg.metadata);
      expect(parsedMsg.hidden).toBe(originalMsg.hidden);
      expect(parsedMsg.toolCall).toEqual(originalMsg.toolCall);
      expect(parsedMsg.toolResult).toEqual(originalMsg.toolResult);
      expect(parsedMsg.tokenUsage).toEqual(originalMsg.tokenUsage);
      if (isAssistantMessage(originalMsg)) {
        expect(isAssistantMessage(parsedMsg)).toBe(true);
        if (isAssistantMessage(parsedMsg)) {
          expect(parsedMsg.goalCompleted).toBe(originalMsg.goalCompleted);
        }
      }

      // Content comparison
      if (Array.isArray(originalMsg.content)) {
        expect(parsedMsg.content).toEqual(originalMsg.content);
      } else {
        expect(parsedMsg.content).toBe(originalMsg.content);
      }
    }
  });
});
