/**
 * Regression tests for one defect class: a plain-object lookup answering for a name every object
 * inherits. A message id is a free-form string, so marking the id `constructor` on a history that
 * lacks it must leave the history alone rather than build a message out of `Object`.
 *
 * The check in `scripts/check-inherited-key-reads.ts` keeps new reads of this kind out of `src`.
 */

import { describe, expect, test } from 'bun:test';
import type { ConversationHistory } from 'conversationalist';

import { markMessageDeliveryFailed } from './builders.ts';

describe('a message id named after a name every object inherits', () => {
  test('is not a message to mark as failed', () => {
    const history = {
      id: 'conversation-1',
      ids: [],
      messages: {},
    } as unknown as ConversationHistory;
    expect(markMessageDeliveryFailed(history, 'constructor')).toBe(history);
  });
});
