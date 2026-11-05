/**
 * The keyboard preference (row 03f): single-key shortcuts are on until a person turns them off, and
 * the choice is read back by the next page load. Storage that refuses is not fatal.
 */
import { describe, expect, test } from 'bun:test';

import { KeyboardPreferences } from './keyboard-preferences.svelte.ts';

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();
  get length(): number {
    return this.#items.size;
  }
  clear(): void {
    this.#items.clear();
  }
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

class RefusingStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error('blocked');
  }
  override setItem(): void {
    throw new Error('blocked');
  }
}

describe('keyboard preferences', () => {
  test('start with single-key shortcuts on', () => {
    expect(new KeyboardPreferences(new MemoryStorage()).singleKeyShortcuts).toBe(true);
  });

  test('are read back by the next page load', () => {
    const storage = new MemoryStorage();
    new KeyboardPreferences(storage).setSingleKeyShortcuts(false);
    const reloaded = new KeyboardPreferences(storage);
    expect(reloaded.singleKeyShortcuts).toBe(false);
    reloaded.setSingleKeyShortcuts(true);
    expect(new KeyboardPreferences(storage).singleKeyShortcuts).toBe(true);
  });

  test('keep the choice for the session when storage refuses to', () => {
    const preferences = new KeyboardPreferences(new RefusingStorage());
    expect(preferences.singleKeyShortcuts).toBe(true);
    preferences.setSingleKeyShortcuts(false);
    expect(preferences.singleKeyShortcuts).toBe(false);
  });
});
