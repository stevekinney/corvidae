/**
 * The draft store keeps one unsent draft per chat with when it was written, in a versioned and
 * bounded entry, and gives nothing back for an entry it did not write, of another version, over
 * the bound, or stale (COR-2284 C7).
 */
import { describe, expect, test } from 'bun:test';

import {
  DRAFT_LIFETIME_MILLISECONDS,
  draftTime,
  forgetChatDraft,
  MAX_DRAFT_LENGTH,
  readChatDraft,
  writeChatDraft,
} from './chat-drafts.ts';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  };
}

const NOON = Date.UTC(2026, 10, 17, 12, 0);
const KEY = 'chat-draft:session-1';

describe('the draft store', () => {
  test('gives back what was written for a chat, with when, and nothing for another chat', () => {
    const storage = memoryStorage();
    writeChatDraft(storage, 'session-1', 'Refund order 4471', NOON);

    expect(readChatDraft(storage, 'session-1', NOON)).toEqual({
      text: 'Refund order 4471',
      savedAt: NOON,
    });
    expect(readChatDraft(storage, 'session-2', NOON)).toBeUndefined();
    expect(storage.entries.get(KEY)).toBe(
      JSON.stringify({ version: 1, text: 'Refund order 4471', savedAt: NOON }),
    );
  });

  test('forgets a draft that is emptied or discarded', () => {
    const storage = memoryStorage();
    writeChatDraft(storage, 'session-1', 'Refund order 4471', NOON);
    writeChatDraft(storage, 'session-1', '   ', NOON + 1);
    expect(readChatDraft(storage, 'session-1', NOON)).toBeUndefined();

    writeChatDraft(storage, 'session-1', 'Refund order 4471', NOON);
    forgetChatDraft(storage, 'session-1');
    expect(readChatDraft(storage, 'session-1', NOON)).toBeUndefined();
  });

  test('keeps no draft over the length bound, and never puts an older one back over it', () => {
    const storage = memoryStorage();
    writeChatDraft(storage, 'session-1', 'short', NOON);
    writeChatDraft(storage, 'session-1', 'x'.repeat(MAX_DRAFT_LENGTH + 1), NOON + 1);
    expect(readChatDraft(storage, 'session-1', NOON + 2)).toBeUndefined();

    writeChatDraft(storage, 'session-1', 'x'.repeat(MAX_DRAFT_LENGTH), NOON);
    expect(readChatDraft(storage, 'session-1', NOON)?.text).toHaveLength(MAX_DRAFT_LENGTH);
    storage.entries.set(
      KEY,
      JSON.stringify({ version: 1, text: 'x'.repeat(MAX_DRAFT_LENGTH + 1), savedAt: NOON }),
    );
    expect(readChatDraft(storage, 'session-1', NOON)).toBeUndefined();
  });

  test('reads a stale entry as no draft: past its lifetime, or written later than now', () => {
    const storage = memoryStorage();
    writeChatDraft(storage, 'session-1', 'old', NOON);
    expect(readChatDraft(storage, 'session-1', NOON + DRAFT_LIFETIME_MILLISECONDS)).toBeDefined();
    expect(
      readChatDraft(storage, 'session-1', NOON + DRAFT_LIFETIME_MILLISECONDS + 1),
    ).toBeUndefined();
    expect(readChatDraft(storage, 'session-1', NOON - 10 * 60 * 1000)).toBeUndefined();
  });

  test('reads an entry it did not write, or of another version, as no draft', () => {
    const storage = memoryStorage();
    for (const value of [
      'not json',
      '[]',
      'null',
      '{"version":1,"text":3,"savedAt":1}',
      '{"version":1,"text":"a"}',
      `{"text":"a","savedAt":${NOW_TEXT}}`,
      `{"version":2,"text":"a","savedAt":${NOW_TEXT}}`,
      `{"version":"1","text":"a","savedAt":${NOW_TEXT}}`,
    ]) {
      storage.setItem(KEY, value);
      expect(readChatDraft(storage, 'session-1', NOON)).toBeUndefined();
    }
    const inherited = Object.create({ version: 1, text: 'a', savedAt: NOON }) as object;
    storage.setItem(KEY, JSON.stringify(inherited));
    expect(readChatDraft(storage, 'session-1', NOON)).toBeUndefined();
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
    expect(readChatDraft(refusing, 'session-1', NOON)).toBeUndefined();
  });
});

const NOW_TEXT = String(NOON);

describe('when a draft was written, in words', () => {
  test('is the clock today, yesterday at the clock, and the day before that', () => {
    expect(draftTime(NOON - 60 * 60 * 1000, NOON, 'UTC')).toBe('11:00 AM');
    expect(draftTime(NOON - 24 * 60 * 60 * 1000 + 4 * 60 * 1000, NOON, 'UTC')).toBe(
      'yesterday at 12:04 PM',
    );
    expect(draftTime(NOON - 3 * 24 * 60 * 60 * 1000, NOON, 'UTC')).toMatch(/^Sat, Nov 14/);
  });
});
