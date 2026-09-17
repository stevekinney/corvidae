import { describe, expect, it } from 'bun:test';

import {
  appendAssistantMessage,
  appendMessages,
  appendUserMessage,
  createConversationHistory,
  removeMessage,
  setMessageHidden,
  validateConversationHistoryIntegrity,
} from '../src/conversation';
import { ConversationalistError } from '../src/errors';
import type { ConversationHistory } from '../src/types';

const environment = {
  now: () => '2026-08-18T12:00:00.000Z',
  randomId: (() => {
    let nextId = 0;
    return () => `message-${++nextId}`;
  })(),
};

const expectValid = (history: ConversationHistory): void => {
  expect(validateConversationHistoryIntegrity(history)).toEqual([]);
};

describe('message removal and visibility', () => {
  it('removes a message and restores contiguous positions without mutating survivors', () => {
    let history = createConversationHistory({}, environment);
    history = appendUserMessage(history, 'First', undefined, environment);
    history = appendAssistantMessage(history, 'Remove me', undefined, environment);
    history = appendUserMessage(history, 'Third', undefined, environment);
    const [firstId, removedId, thirdId] = history.ids;
    if (!firstId || !removedId || !thirdId) throw new Error('Expected three message ids');
    const firstMessage = history.messages[firstId];
    const thirdMessage = history.messages[thirdId];
    const originalSnapshot = structuredClone(history);

    const updated = removeMessage(history, removedId, environment);

    expect(updated.ids).toEqual([firstId, thirdId]);
    expect(updated.messages[removedId]).toBeUndefined();
    expect(updated.messages[firstId]).toBe(firstMessage);
    expect(updated.messages[thirdId]).not.toBe(thirdMessage);
    expect(updated.messages[firstId]?.position).toBe(0);
    expect(updated.messages[thirdId]?.position).toBe(1);
    expect(history).toEqual(originalSnapshot);
    expectValid(updated);
  });

  it('returns the original history when removing an unknown message', () => {
    const history = createConversationHistory({}, environment);

    expect(removeMessage(history, 'missing', environment)).toBe(history);
  });

  it('rejects removal that would leave an orphaned tool result', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: null },
      },
      environment,
    );

    expect(() => removeMessage(history, history.ids[0]!, environment)).toThrow(
      ConversationalistError,
    );
    expectValid(history);
  });

  it('sets and clears message visibility without mutating the input message', () => {
    let history = createConversationHistory({}, environment);
    history = appendUserMessage(history, 'Toggle me', undefined, environment);
    const messageId = history.ids[0]!;
    const originalMessage = history.messages[messageId]!;

    const hidden = setMessageHidden(history, messageId, true, environment);
    const visible = setMessageHidden(hidden, messageId, false, environment);

    expect(hidden.messages[messageId]?.hidden).toBeTrue();
    expect(visible.messages[messageId]?.hidden).toBeFalse();
    expect(history.messages[messageId]!).toBe(originalMessage);
    expect(originalMessage.hidden).toBeFalse();
    expectValid(hidden);
    expectValid(visible);
  });

  it('returns the original history when hiding an unknown message', () => {
    const history = createConversationHistory({}, environment);

    expect(setMessageHidden(history, 'missing', true, environment)).toBe(history);
  });
});
