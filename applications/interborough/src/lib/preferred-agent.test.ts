/** The agent a person chose for new chats: kept in the browser, never required. */
import { describe, expect, test } from 'bun:test';

import { readPreferredAgent, writePreferredAgent } from './preferred-agent.ts';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

function refusingStorage(): Storage {
  const refuse = (): never => {
    throw new Error('blocked');
  };
  return {
    get length() {
      return 0;
    },
    clear: refuse,
    getItem: refuse,
    key: refuse,
    removeItem: refuse,
    setItem: refuse,
  };
}

describe('the preferred agent', () => {
  test('is none until one is chosen', () => {
    expect(readPreferredAgent(memoryStorage())).toBeUndefined();
  });

  test('is remembered, and forgotten for an undefined or empty name', () => {
    const storage = memoryStorage();
    writePreferredAgent('demo:assistant', storage);
    expect(readPreferredAgent(storage)).toBe('demo:assistant');
    writePreferredAgent(undefined, storage);
    expect(readPreferredAgent(storage)).toBeUndefined();
    writePreferredAgent('demo:echo', storage);
    writePreferredAgent('', storage);
    expect(readPreferredAgent(storage)).toBeUndefined();
  });

  test('reads as none, and writes nothing, when the storage refuses', () => {
    const storage = refusingStorage();
    expect(readPreferredAgent(storage)).toBeUndefined();
    expect(() => writePreferredAgent('demo:assistant', storage)).not.toThrow();
  });
});
