import { describe, expect, it } from 'bun:test';

import { Conversation as ConversationHistory } from '../src/history';
import { createConversationHistory as createConversation } from '../src/index';
import type { ConversationHistory as ConversationState, Message } from '../src/types';

const getOrderedMessages = (conversation: ConversationState): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

const seedFourMessages = (): ConversationHistory => {
  const history = new ConversationHistory(createConversation());
  history.appendUserMessage('Message 0');
  history.appendAssistantMessage('Message 1');
  history.appendUserMessage('Message 2');
  history.appendAssistantMessage('Message 3');
  return history;
};

describe('Conversation rewind methods', () => {
  it('rewindBeforePosition drops the boundary message and everything after it', () => {
    const history = seedFourMessages();

    history.rewindBeforePosition(2);

    expect(getOrderedMessages(history.current).map((message) => message.content)).toEqual([
      'Message 0',
      'Message 1',
    ]);
  });

  it('rewindBeforeMessage drops the named message and everything after it', () => {
    const history = seedFourMessages();
    const target = getOrderedMessages(history.current)[1]!;
    if (target === undefined) throw new Error('expected rewind target');

    history.rewindBeforeMessage(target.id);

    expect(getOrderedMessages(history.current).map((message) => message.content)).toEqual([
      'Message 0',
    ]);
  });

  it('records a rewind as an undoable step', () => {
    const history = seedFourMessages();

    history.rewindBeforePosition(1);
    expect(history.current.ids).toHaveLength(1);

    history.undo();
    expect(history.current.ids).toHaveLength(4);
  });

  it('adds no history entry when the rewind changes nothing', () => {
    const history = seedFourMessages();
    const before = history.current;

    history.rewindBeforePosition(4);
    history.rewindBeforeMessage('not-a-real-id');

    expect(history.current).toBe(before);
  });
});
