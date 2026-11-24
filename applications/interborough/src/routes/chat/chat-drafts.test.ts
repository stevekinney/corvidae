/**
 * The draft store keeps one unsent draft per chat with when it was written, and gives nothing back
 * for an entry it did not write (COR-2284 C7).
 */
import { describe, expect, test } from 'bun:test';

import { draftTime, forgetChatDraft, readChatDraft, writeChatDraft } from './chat-drafts.ts';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  };
}

const NOON = Date.UTC(2026, 10, 17, 12, 0);

describe('the draft store', () => {
  test('gives back what was written for a chat, with when, and nothing for another chat', () => {
    const storage = memoryStorage();
    writeChatDraft(storage, 'session-1', 'Refund order 4471', NOON);

    expect(readChatDraft(storage, 'session-1')).toEqual({
      text: 'Refund order 4471',
      savedAt: NOON,
    });
    expect(readChatDraft(storage, 'session-2')).toBeUndefined();
    expect(storage.entries.get('chat-draft:session-1')).toBe(
      JSON.stringify({ text: 'Refund order 4471', savedAt: NOON }),
    );
  });

  test('forgets a draft that is emptied or discarded', () => {
    const storage = memoryStorage();
    writeChatDraft(storage, 'session-1', 'Refund order 4471', NOON);
    writeChatDraft(storage, 'session-1', '   ', NOON + 1);
    expect(readChatDraft(storage, 'session-1')).toBeUndefined();

    writeChatDraft(storage, 'session-1', 'Refund order 4471', NOON);
    forgetChatDraft(storage, 'session-1');
    expect(readChatDraft(storage, 'session-1')).toBeUndefined();
  });

  test('reads an entry it did not write as no draft', () => {
    const storage = memoryStorage();
    for (const value of ['not json', '[]', '{"text":3,"savedAt":1}', '{"text":"a"}', 'null']) {
      storage.setItem('chat-draft:session-1', value);
      expect(readChatDraft(storage, 'session-1')).toBeUndefined();
    }
    const inherited = Object.create({ text: 'a', savedAt: 1 }) as object;
    storage.setItem('chat-draft:session-1', JSON.stringify(inherited));
    expect(readChatDraft(storage, 'session-1')).toBeUndefined();
  });

  test('keeps nothing, and throws nothing, when the storage refuses', () => {
    const refusing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(() => writeChatDraft(refusing, 'session-1', 'text', NOON)).not.toThrow();
    expect(readChatDraft(refusing, 'session-1')).toBeUndefined();
  });
});

describe('when a draft was written, in words', () => {
  test('is the clock today, yesterday at the clock, and the day before that', () => {
    expect(draftTime(NOON - 60 * 60 * 1000, NOON, 'UTC')).toBe('11:00 AM');
    expect(draftTime(NOON - 24 * 60 * 60 * 1000 + 4 * 60 * 1000, NOON, 'UTC')).toBe(
      'yesterday at 12:04 PM',
    );
    expect(draftTime(NOON - 3 * 24 * 60 * 60 * 1000, NOON, 'UTC')).toMatch(/^Sat, Nov 14/);
  });
});
