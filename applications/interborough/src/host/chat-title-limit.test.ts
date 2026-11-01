/**
 * COR-1968 — the rename dialog refuses a title over the limit before it asks the Bureau, so its
 * limit is held equal to the one the Bureau applies.
 */
import { SESSION_TITLE_OVERRIDE_LIMIT } from '@lostgradient/operative';
import { expect, test } from 'bun:test';

import { CHAT_TITLE_LIMIT } from '../routes/chat/chat-title.ts';

test('the longest title the page accepts is the longest the Bureau stores', () => {
  expect(CHAT_TITLE_LIMIT).toBe(SESSION_TITLE_OVERRIDE_LIMIT);
});
