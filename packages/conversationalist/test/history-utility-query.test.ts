import { describe, expect, it } from 'bun:test';

import {
  conversationFromMarkdown as conversationHistoryFromMarkdown,
  conversationToMarkdown as conversationHistoryToMarkdown,
} from '../src';
import { Conversation as ConversationHistory } from '../src/history';
import { appendUserMessage, createConversationHistory as createConversation } from '../src/index';
import type { ConversationHistory as ConversationState, Message } from '../src/types';

const getOrderedMessages = (conversation: ConversationState): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('Conversation query methods', () => {
  it('should support query methods', () => {
    let conv = createConversation({ title: 'Query' });
    conv = appendUserMessage(conv, 'Hello');
    const history = new ConversationHistory(conv);

    expect(history.getMessages()).toHaveLength(1);
    expect(history.getMessageAtPosition(0)?.content).toBe('Hello');
    expect(history.getStatistics().total).toBe(1);
    expect(history.current.title).toBe('Query');
    expect(history.toChatMessages()).toHaveLength(1);
    expect(conversationHistoryToMarkdown(history)).toContain('### User');
    expect(conversationHistoryToMarkdown(history, { includeMetadata: true })).toContain('---');

    const restored = conversationHistoryFromMarkdown(
      conversationHistoryToMarkdown(history, { includeMetadata: true }),
    );
    const restoredMessages = getOrderedMessages(restored.current);
    expect(restoredMessages).toHaveLength(1);
    expect(restoredMessages[0]!.content).toBe('Hello');
    expect(history.estimateTokens()).toBeGreaterThan(0);
    expect(history.getRecentMessages(1)).toHaveLength(1);
    expect(history.hasSystemMessage()).toBe(false);
    expect(history.getFirstSystemMessage()).toBeUndefined();
    expect(history.getSystemMessages()).toHaveLength(0);
    expect(history.searchMessages((m) => m.role === 'user')).toHaveLength(1);
    const convMessages = getOrderedMessages(conv);
    expect(history.getMessageById(convMessages[0]!.id)).toBeDefined();
    expect(history.get(convMessages[0]!.id)).toBeDefined();
    expect([...history.getMessageIds()]).toEqual([...conv.ids]);
    expect([...history.ids]).toEqual([...conv.ids]);
  });
});
