import { describe, expect, it } from 'bun:test';

import { Conversation as ConversationHistory } from '../src/history';
import { createConversationHistory as createConversation } from '../src/index';

describe('maxHistoryDepth', () => {
  it('prunes oldest ancestors when depth exceeded', () => {
    const history = new ConversationHistory(createConversation(), {
      maxHistoryDepth: 5,
    });

    for (let i = 0; i < 10; i++) {
      history.appendUserMessage(`Message ${i}`);
    }

    const path = history.getPath();
    expect(path.length).toBeLessThanOrEqual(5);
  });

  it('limits undo to maxHistoryDepth', () => {
    const history = new ConversationHistory(createConversation(), {
      maxHistoryDepth: 5,
    });

    for (let i = 0; i < 10; i++) {
      history.appendUserMessage(`Message ${i}`);
    }

    let undoCount = 0;
    while (history.canUndo) {
      history.undo();
      undoCount++;
    }

    expect(undoCount).toBeLessThanOrEqual(4); // max depth 5 means at most 4 undos
  });

  it('does not limit when maxHistoryDepth is undefined', () => {
    const history = new ConversationHistory(createConversation());

    for (let i = 0; i < 10; i++) {
      history.appendUserMessage(`Message ${i}`);
    }

    const path = history.getPath();
    // 1 initial + 10 mutations = 11
    expect(path.length).toBe(11);
  });
});
