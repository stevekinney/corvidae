import { describe, expect, test } from 'bun:test';

import { loadReadIds, READ_ID_LIMIT, saveReadIds } from './notification-read-state.ts';
import { memoryStorage } from './notification-store.test-support.ts';

describe('read ids', () => {
  test('are what was saved, oldest first', () => {
    const storage = memoryStorage();

    saveReadIds(['a', 'b'], storage);

    expect(loadReadIds(storage)).toEqual(['a', 'b']);
  });

  test('are empty when nothing is stored', () => {
    expect(loadReadIds(memoryStorage())).toEqual([]);
    expect(loadReadIds(undefined)).toEqual([]);
  });

  test('are empty when what is stored is not a list of ids', () => {
    for (const stored of ['not json', '{"a":1}', '"a"']) {
      expect(loadReadIds(memoryStorage({ 'interborough:notifications:read': stored }))).toEqual([]);
    }
  });

  test('skip a stored entry that is not an id', () => {
    const storage = memoryStorage({ 'interborough:notifications:read': '["a", 3, null, "b"]' });

    expect(loadReadIds(storage)).toEqual(['a', 'b']);
  });

  test('keep the newest ones past the limit', () => {
    const storage = memoryStorage();
    const ids = Array.from({ length: READ_ID_LIMIT + 5 }, (_, index) => `id-${index}`);

    saveReadIds(ids, storage);

    const loaded = loadReadIds(storage);
    expect(loaded).toHaveLength(READ_ID_LIMIT);
    expect(loaded[0]).toBe('id-5');
    expect(loaded.at(-1)).toBe(`id-${READ_ID_LIMIT + 4}`);
  });

  test('survive a storage that throws on read', () => {
    const storage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    };

    expect(loadReadIds(storage)).toEqual([]);
  });

  test('survive local storage that cannot be reached at all', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(loadReadIds()).toEqual([]);
      expect(() => saveReadIds(['a'])).not.toThrow();
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
