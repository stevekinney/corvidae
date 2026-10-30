import { describe, expect, mock, test } from 'bun:test';

import {
  clampListWidth,
  createBrowserSelectionLocation,
  LIST_PANE_MAXIMUM_WIDTH,
  LIST_PANE_MINIMUM_WIDTH,
  moveCursor,
  readStoredListWidth,
  resolveStorage,
  writeStoredListWidth,
} from './list-detail-state.ts';

describe('moveCursor', () => {
  const keys = ['a', 'b', 'c'];

  test('moves one row and stops at either end', () => {
    expect(moveCursor(keys, 'a', 1)).toBe('b');
    expect(moveCursor(keys, 'c', 1)).toBe('c');
    expect(moveCursor(keys, 'c', -1)).toBe('b');
    expect(moveCursor(keys, 'a', -1)).toBe('a');
  });

  test('lands on the first row when there is no cursor or its row is gone', () => {
    expect(moveCursor(keys, null, 1)).toBe('a');
    expect(moveCursor(keys, null, -1)).toBe('a');
    expect(moveCursor(keys, 'removed', 1)).toBe('a');
  });

  test('has nowhere to go without rows', () => {
    expect(moveCursor([], null, 1)).toBeNull();
  });
});

describe('the remembered list width', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      getItem: (storageKey: string) => values.get(storageKey) ?? null,
      setItem: (storageKey: string, value: string) => void values.set(storageKey, value),
    };
  }

  test('clamps to the range the divider can reach', () => {
    expect(clampListWidth(10)).toBe(LIST_PANE_MINIMUM_WIDTH);
    expect(clampListWidth(10_000)).toBe(LIST_PANE_MAXIMUM_WIDTH);
    expect(clampListWidth(300)).toBe(300);
  });

  test('round-trips a width under the caller key', () => {
    const storage = memoryStorage();
    writeStoredListWidth(storage, 'chats', 412.6);
    expect(readStoredListWidth(storage, 'chats')).toBe(413);
    expect(readStoredListWidth(storage, 'runs')).toBeNull();
  });

  test('ignores a value that is not a number and clamps one that is out of range', () => {
    expect(readStoredListWidth(memoryStorage({ chats: 'wide' }), 'chats')).toBeNull();
    expect(readStoredListWidth(memoryStorage({ chats: '' }), 'chats')).toBeNull();
    expect(readStoredListWidth(memoryStorage({ chats: '5000' }), 'chats')).toBe(
      LIST_PANE_MAXIMUM_WIDTH,
    );
  });

  test('does nothing without a key or a storage', () => {
    const storage = memoryStorage();
    writeStoredListWidth(storage, undefined, 300);
    writeStoredListWidth(undefined, 'chats', 300);
    expect(readStoredListWidth(storage, undefined)).toBeNull();
    expect(readStoredListWidth(undefined, 'chats')).toBeNull();
  });

  test('survives a storage that throws', () => {
    const refusing = {
      getItem: mock(() => {
        throw new Error('blocked');
      }),
      setItem: mock(() => {
        throw new Error('blocked');
      }),
    };
    expect(readStoredListWidth(refusing, 'chats')).toBeNull();
    expect(() => writeStoredListWidth(refusing, 'chats', 300)).not.toThrow();
  });

  test('prefers the storage it is given over localStorage', () => {
    const storage = memoryStorage();
    expect(resolveStorage(storage)).toBe(storage);
  });
});

describe('createBrowserSelectionLocation', () => {
  test('reads nothing and writes nothing without a window', () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error -- simulate the server
    delete globalThis.window;
    try {
      const location = createBrowserSelectionLocation();
      expect(location.read('selected')).toBeNull();
      expect(() => location.write('selected', 'a')).not.toThrow();
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
