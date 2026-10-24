/** The `g` then a letter shortcuts: one list, each letter used once, and a key read against it. */
import { describe, expect, test } from 'bun:test';

import {
  CHORD_WINDOW_MS,
  NAVIGATION_SHORTCUTS,
  shortcutKeys,
  stepChord,
  type ChordKey,
} from './navigation-shortcuts.ts';

function key(value: string, overrides: Partial<ChordKey> = {}): ChordKey {
  return {
    key: value,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    editable: false,
    ...overrides,
  };
}

describe('the list of shortcuts', () => {
  test('uses each letter once, and never g itself', () => {
    const letters = Object.values(NAVIGATION_SHORTCUTS);
    expect(new Set(letters).size).toBe(letters.length);
    expect(letters).not.toContain('g');
  });

  test('names the keys of a path, and none for a path without one', () => {
    expect(shortcutKeys('/chat')).toEqual(['g', 'c']);
    expect(shortcutKeys('/agents')).toEqual(['g', 'a']);
    expect(shortcutKeys('/engine')).toEqual(['g', 'e']);
    expect(shortcutKeys('/goals')).toBeUndefined();
  });
});

describe('stepChord', () => {
  test('waits after g, and opens the view the next letter names', () => {
    const armed = stepChord(null, key('g'), 1_000);
    expect(armed).toEqual({ armedAtMs: 1_000, path: null });
    expect(stepChord(armed.armedAtMs, key('c'), 1_200)).toEqual({ armedAtMs: null, path: '/chat' });
  });

  test('ignores a letter pressed with no g before it', () => {
    expect(stepChord(null, key('c'), 1_000)).toEqual({ armedAtMs: null, path: null });
  });

  test('drops the wait once the window has passed', () => {
    const late = stepChord(1_000, key('c'), 1_000 + CHORD_WINDOW_MS + 1);
    expect(late).toEqual({ armedAtMs: null, path: null });
  });

  test('drops the wait on a letter that names no view, and on a second g it starts over', () => {
    expect(stepChord(1_000, key('z'), 1_100)).toEqual({ armedAtMs: null, path: null });
    expect(stepChord(1_000, key('g'), 1_100)).toEqual({ armedAtMs: 1_100, path: null });
  });

  test('does nothing while a modifier is held or a field has the keys', () => {
    expect(stepChord(null, key('g', { metaKey: true }), 1_000).armedAtMs).toBeNull();
    expect(stepChord(1_000, key('c', { ctrlKey: true }), 1_100).path).toBeNull();
    expect(stepChord(1_000, key('c', { altKey: true }), 1_100).path).toBeNull();
    expect(stepChord(null, key('g', { editable: true }), 1_000).armedAtMs).toBeNull();
    expect(stepChord(1_000, key('c', { editable: true }), 1_100).path).toBeNull();
  });

  test('treats a capital G as a different key', () => {
    expect(stepChord(null, key('G'), 1_000).armedAtMs).toBeNull();
  });
});
