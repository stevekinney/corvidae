/**
 * The shell's layout preference (COR-1834): the sidebar's icon rail survives a reload because it
 * is read back from storage, and storage that refuses is not fatal.
 */
import { describe, expect, test } from 'bun:test';

import { LayoutPreferences } from './layout-preferences.svelte.ts';

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

describe('layout preferences', () => {
  test('start expanded', () => {
    expect(new LayoutPreferences(new MemoryStorage()).sidebarCollapsed).toBe(false);
  });

  test('are read back by the next page load', () => {
    const storage = new MemoryStorage();
    new LayoutPreferences(storage).setSidebarCollapsed(true);
    const reloaded = new LayoutPreferences(storage);
    expect(reloaded.sidebarCollapsed).toBe(true);
    reloaded.setSidebarCollapsed(false);
    expect(new LayoutPreferences(storage).sidebarCollapsed).toBe(false);
  });

  test('ignore a stored value they do not know', () => {
    const storage = new MemoryStorage();
    storage.setItem('interborough-sidebar-collapsed', 'maybe');
    expect(new LayoutPreferences(storage).sidebarCollapsed).toBe(false);
  });

  test('keep working for the session when storage refuses', () => {
    const preferences = new LayoutPreferences(new RefusingStorage());
    preferences.setSidebarCollapsed(true);
    expect(preferences.sidebarCollapsed).toBe(true);
  });
});
