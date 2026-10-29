/**
 * Regression tests for one defect class: a plain-object lookup answering for a name every object
 * inherits. A conversation's message ids are free-form strings, so an id of `constructor` must
 * find nothing in a `messages` record that lacks it, not `Object`.
 *
 * The check in `scripts/check-inherited-key-reads.ts` keeps new reads of this kind out of `src`.
 */

import { describe, expect, test } from 'bun:test';

import { whenMetadata, whenMetadataPresent } from './composition/conditional-section';
import { appendMessages, prependMessages, withMessageId } from './conversation/append';
import { createConversationHistory } from './conversation/create';
import { validateConversationHistoryIntegrity } from './conversation/integrity';
import { removeMessage } from './conversation/modify';
import { getMessageAtPosition, getMessageById } from './conversation/query';
import { createPublicConversationProjection } from './projection';
import type { ConversationHistory } from './types';
import { toIdRecord } from './utilities/message-store';

/** A history whose ids list a message that its messages record does not hold. */
function historyListing(id: string): ConversationHistory {
  return {
    id: 'conversation-1',
    status: 'active',
    metadata: {},
    tags: [],
    ids: [id],
    messages: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as ConversationHistory;
}

describe('a message id that every object inherits', () => {
  test('finds no message when the record does not hold it', () => {
    const history = historyListing('constructor');
    expect(getMessageById(history, 'constructor')).toBeUndefined();
    expect(getMessageById(history, 'toString')).toBeUndefined();
    expect(getMessageAtPosition(history, 0)).toBeUndefined();
  });

  test('is reported as a missing message by the integrity check', () => {
    const issues = validateConversationHistoryIntegrity(historyListing('constructor'));
    expect(issues.map((issue) => issue.code)).toContain('integrity:missing-message');
  });
});

describe('conditional sections keyed on a metadata name', () => {
  test('do not match a name every object inherits', () => {
    const context = { metadata: { tier: 'pro' }, step: 0 } as unknown as Parameters<
      ReturnType<typeof whenMetadataPresent>
    >[0];
    expect(whenMetadataPresent('tier')(context)).toBe(true);
    expect(whenMetadataPresent('constructor')(context)).toBe(false);
    expect(whenMetadata('constructor', undefined)(context)).toBe(true);
    expect(whenMetadata('toString', 'x')(context)).toBe(false);
  });
});

describe('a message id of __proto__', () => {
  test('is stored as an entry, not as the record prototype', () => {
    const record = toIdRecord([{ id: '__proto__' }, { id: 'a' }]);
    expect(Object.keys(record)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(Object.hasOwn(record, '__proto__')).toBe(true);
  });
});

describe('a message id of __proto__ carried through the conversation operations', () => {
  test('survives projection, removal of another message, and prepending', () => {
    const conversation = appendMessages(
      createConversationHistory(),
      withMessageId({ role: 'user', content: 'hi' }, '__proto__'),
      withMessageId({ role: 'assistant', content: 'yo' }, 'reply'),
    );

    expect(Object.keys(conversation.messages)).toEqual(['__proto__', 'reply']);
    const projected = createPublicConversationProjection(conversation);
    expect(Object.keys(projected.messages)).toEqual(['__proto__', 'reply']);
    expect(Object.keys(removeMessage(conversation, 'reply').messages)).toEqual(['__proto__']);
    const prepended = prependMessages(conversation, { role: 'system', content: 'rules' });
    expect(Object.keys(prepended.messages)).toContain('__proto__');
    expect(Object.getPrototypeOf(prepended.messages)).toBe(Object.prototype);
  });
});
