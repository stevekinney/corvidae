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

  it('shares one correlationId across started and completed for a committed attempt', async () => {
    const history = new ConversationHistory(createConversation());
    for (let i = 0; i < 10; i++) {
      history.appendUserMessage(`Message ${i}`);
      history.appendAssistantMessage(`Reply ${i}`);
    }
    const seen: Record<string, string[]> = {};
    for (const type of ['compaction.started', 'compaction.completed'] as const) {
      history.addEventListener(type, (event) => {
        (seen[type] ??= []).push(event.correlationId);
      });
    }

    await history.compact(summarizer, { preserveRecentCount: 2 });

    expect(seen['compaction.started']).toHaveLength(1);
    expect(seen['compaction.completed']).toEqual(seen['compaction.started']);
  });

  it('shares one correlationId across started and stale-discarded, distinct per attempt', async () => {
    const history = new ConversationHistory(createConversation());
    for (let i = 0; i < 10; i++) history.appendUserMessage(`Message ${i}`);
    const started: string[] = [];
    const discarded: string[] = [];
    history.addEventListener('compaction.started', (event) => started.push(event.correlationId));
    history.addEventListener('compaction.stale-discarded', (event) =>
      discarded.push(event.correlationId),
    );
    const slow = async (messages: Message[]) => {
      await Promise.resolve();
      return `Summary of ${messages.length}`;
    };

    const first = history.compact(slow, { preserveRecentCount: 2 });
    const second = history.compact(slow, { preserveRecentCount: 2 });
    await Promise.all([first, second]);

    expect(started).toHaveLength(2);
    expect(started[0]).not.toBe(started[1]);
    expect(discarded).toHaveLength(1);
    expect(started).toContain(discarded[0]!);
  });
});
