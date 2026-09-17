import { describe, expect, it } from 'bun:test';

import { Conversation as ConversationHistory } from '../src/history';
import { createConversationHistory as createConversation } from '../src/index';
import type { Message } from '../src/types';

const summarizer = async (messages: Message[]) => `Summary of ${messages.length} messages`;

describe('compaction event emission', () => {
  it('emits compaction.completed exactly once when compaction occurs', async () => {
    const history = new ConversationHistory(createConversation());
    for (let i = 0; i < 10; i++) {
      history.appendUserMessage(`Message ${i}`);
      history.appendAssistantMessage(`Reply ${i}`);
    }

    let completedCount = 0;
    history.addEventListener('compaction.completed', () => {
      completedCount++;
    });

    await history.compact(summarizer, { preserveRecentCount: 2 });

    expect(completedCount).toBe(1);
  });

  it('emits compaction.completed exactly once when no compaction needed', async () => {
    const history = new ConversationHistory(createConversation());
    history.appendUserMessage('only one');

    let completedCount = 0;
    history.addEventListener('compaction.completed', () => {
      completedCount++;
    });

    await history.compact(summarizer, { preserveRecentCount: 2 });

    expect(completedCount).toBe(1);
  });
});
