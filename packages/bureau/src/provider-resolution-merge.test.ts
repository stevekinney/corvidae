/**
 * COR-2437 review: the merge a scheduled fire's step saves through keeps a discard. A fire that
 * read the chat before a discard committed holds the discarded rows in its copy; its save writes
 * its own rows and never the discarded ones, and with no discard named it merges as before.
 */
import { appendMessages, createConversationHistory } from 'conversationalist';
import { describe, expect, it } from 'bun:test';

import { appendConversationMessages } from './provider-resolution';

const rows = (...ids: string[]) =>
  appendMessages(
    createConversationHistory({ id: 'chat' }),
    ...ids.map(
      (id) => ({ id, role: id.startsWith('u') ? 'user' : 'assistant', content: id }) as never,
    ),
  );

describe('a scheduled fire’s save after a discard', () => {
  it('writes the fire’s own rows and never the rows the discard removed', () => {
    const base = rows('u1', 'run:step:0');
    const current = rows('u1');
    const candidate = rows('u1', 'run:step:0', 'u-fire', 'fire:step:0');

    const merged = appendConversationMessages(current, candidate, base, new Set(['run:step:0']));

    expect(merged.ids).toEqual(['u1', 'u-fire', 'fire:step:0']);
  });

  it('merges as before when no discard is named: a row only the candidate holds is new', () => {
    const merged = appendConversationMessages(rows('u1'), rows('u1', 'a1'), rows('u1', 'a1'));

    expect(merged.ids).toEqual(['u1', 'a1']);
  });
});
