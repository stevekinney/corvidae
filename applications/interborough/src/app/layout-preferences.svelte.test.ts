/**
 * The shell's layout preferences (COR-1834): the density and the sidebar's icon rail survive a
 * reload because they are read back from storage, and storage that refuses is not fatal.
 */
import { describe, expect, test } from 'bun:test';

import { effectiveDensity, LayoutPreferences } from './layout-preferences.svelte.ts';

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
  test('start comfortable and expanded', () => {
    const preferences = new LayoutPreferences(new MemoryStorage());
    expect(preferences.density).toBe('comfortable');
    expect(preferences.sidebarCollapsed).toBe(false);
  });

  test('are read back by the next page load', () => {
    const storage = new MemoryStorage();
    const first = new LayoutPreferences(storage);
    first.setDensity('compact');
    first.setSidebarCollapsed(true);
    const reloaded = new LayoutPreferences(storage);
    expect(reloaded.density).toBe('compact');
    expect(reloaded.sidebarCollapsed).toBe(true);
    reloaded.setSidebarCollapsed(false);
    expect(new LayoutPreferences(storage).sidebarCollapsed).toBe(false);
  });

  test('ignore a stored value they do not know', () => {
    const storage = new MemoryStorage();
    storage.setItem('interborough-density', 'cosy');
    expect(new LayoutPreferences(storage).density).toBe('comfortable');
  });

  test('keep working for the session when storage refuses', () => {
    const preferences = new LayoutPreferences(new RefusingStorage());
    preferences.setDensity('compact');
    expect(preferences.density).toBe('compact');
  });

  test('comfortable keeps each view’s density, and compact forces compact', () => {
    expect(effectiveDensity('comfortable', 'comfortable')).toBe('comfortable');
    expect(effectiveDensity('compact', 'comfortable')).toBe('compact');
    expect(effectiveDensity('comfortable', 'compact')).toBe('compact');
  });
});
