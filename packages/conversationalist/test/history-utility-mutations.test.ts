import { describe, expect, it } from 'bun:test';

import { Conversation as ConversationHistory } from '../src/history';
import { createConversationHistory as createConversation } from '../src/index';
import type { ConversationHistory as ConversationState, Message } from '../src/types';

const getOrderedMessages = (conversation: ConversationState): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

const countUndoSteps = (subject: ConversationHistory): number => {
  let steps = 0;
  while (subject.canUndo) {
    subject.undo();
    steps += 1;
  }
  return steps;
};

const build = (): ConversationHistory => {
  const subject = new ConversationHistory(createConversation());
  const messageId = subject.appendStreamingMessage('assistant');
  subject.updateStreamingMessage(messageId, 'Frozen');
  subject.finalizeStreamingMessage(messageId);
  return subject;
};

describe('Conversation mutation methods', () => {
  it('should support mutation methods', () => {
    const history = new ConversationHistory(createConversation());

    history.appendMessages({ role: 'user', content: 'First' });
    expect(history.current.ids.length).toBe(1);

    history.appendUserMessage('User msg');
    expect(history.current.ids.length).toBe(2);
    expect(history.canUndo).toBe(true);

    history.appendAssistantMessage('Assistant msg');
    expect(history.current.ids.length).toBe(3);

    history.appendSystemMessage('System msg');
    expect(history.current.ids.length).toBe(4);

    history.prependSystemMessage('First system');
    expect(getOrderedMessages(history.current)[0]!.content).toBe('First system');

    history.replaceSystemMessage('New system');
    expect(history.getFirstSystemMessage()?.content).toBe('New system');

    history.collapseSystemMessages();
    expect(history.getSystemMessages()).toHaveLength(1);

    history.redactMessageAtPosition(1, '[REDACTED]');
    expect(history.getMessageAtPosition(1)?.content).toBe('[REDACTED]');

    history.truncateFromPosition(1);
    expect(history.current.ids.length).toBe(4); // system + messages from pos 1

    history.truncateToTokenLimit(10);
    expect(history.current.ids.length).toBeLessThan(4);
  });

  it('should support streaming mutation methods', () => {
    const history = new ConversationHistory(createConversation());

    const messageId = history.appendStreamingMessage('assistant');
    expect(history.getStreamingMessage()?.id).toBe(messageId);

    history.updateStreamingMessage(messageId, 'Partial...');
    expect(getOrderedMessages(history.current)[0]!.content).toBe('Partial...');

    history.finalizeStreamingMessage(messageId, {
      tokenUsage: { prompt: 1, completion: 1, total: 2 },
    });
    expect(history.getStreamingMessage()).toBeUndefined();
    expect(getOrderedMessages(history.current)[0]!.tokenUsage?.total).toBe(2);

    const nextId = history.appendStreamingMessage('user');
    history.cancelStreamingMessage(nextId);
    expect(history.current.ids.length).toBe(1);
  });

  it('should not emit any event when a late token is rejected', () => {
    const history = new ConversationHistory(createConversation());
    const messageId = history.appendStreamingMessage('assistant');
    history.updateStreamingMessage(messageId, 'Frozen');
    history.finalizeStreamingMessage(messageId);

    const observed: string[] = [];
    for (const type of ['change', 'push', 'messages.updated', 'stream.updated'] as const) {
      history.addEventListener(type, () => observed.push(type));
    }

    history.updateStreamingMessage(messageId, 'Frozen and then some');
    history.updateStreamingMessage('no-such-message', 'Never existed');

    expect(observed).toEqual([]);
    expect(getOrderedMessages(history.current)[0]!.content).toBe('Frozen');
  });

  it('should not add an undo entry when a late token is rejected', () => {
    const baseline = build();
    const flooded = build();
    const finalizedState = flooded.current;
    const messageId = finalizedState.ids[0]!;
    for (let index = 0; index < 5; index += 1) {
      flooded.updateStreamingMessage(messageId, `late token ${index}`);
    }

    // The flood left the state and the undo chain exactly as finalize did.
    expect(flooded.current).toBe(finalizedState);
    expect(countUndoSteps(flooded)).toBe(countUndoSteps(baseline));
  });
});
