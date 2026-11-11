/**
 * The Fields or JSON choice every payload card of a run's page shares: one value, announced for the
 * cards that may be off screen, kept for the session, and not fatal when storage refuses.
 */
import { describe, expect, test } from 'bun:test';

import { PayloadViewPreference } from './run-payload-view.svelte.ts';

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

describe('the payload view every card of a run shares', () => {
  test('starts on Fields and announces nothing', () => {
    const preference = new PayloadViewPreference(new MemoryStorage());

    expect(preference.view).toBe('fields');
    expect(preference.announcement).toBe('');
  });

  test('says that all the payloads changed, in either direction', () => {
    const preference = new PayloadViewPreference(new MemoryStorage());

    preference.choose('json');
    expect(preference.view).toBe('json');
    expect(preference.announcement).toBe('All payloads now show JSON.');

    preference.choose('fields');
    expect(preference.view).toBe('fields');
    expect(preference.announcement).toBe('All payloads now show Fields.');
  });

  test('announces nothing when the choice is the one already made', () => {
    const preference = new PayloadViewPreference(new MemoryStorage());

    preference.choose('fields');

    expect(preference.announcement).toBe('');
  });

  test('is read back by the next page of the session', () => {
    const storage = new MemoryStorage();
    new PayloadViewPreference(storage).choose('json');

    expect(new PayloadViewPreference(storage).view).toBe('json');
  });

  test('keeps working for the page when storage refuses', () => {
    const preference = new PayloadViewPreference(new RefusingStorage());

    expect(preference.view).toBe('fields');
    preference.choose('json');
    expect(preference.view).toBe('json');
  });
});
