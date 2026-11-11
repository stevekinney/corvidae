import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { guardThemeTransitions, THEME_CHANGING_ATTRIBUTE } =
  await import('./theme-transition-guard.ts');

/** A frame queue the test advances by hand. */
function frames() {
  const queue: (() => void)[] = [];
  return {
    requestFrame: (callback: () => void) => queue.push(callback),
    advance() {
      const due = queue.splice(0);
      for (const callback of due) callback();
    },
  };
}

/** A `prefers-color-scheme` list whose change event the test fires. */
function scheme() {
  const target = new EventTarget();
  return {
    matchMedia: () => target as unknown as MediaQueryList,
    change: () => target.dispatchEvent(new Event('change')),
  };
}

async function settleMutations(): Promise<void> {
  await Promise.resolve();
}

describe('guardThemeTransitions', () => {
  test('marks the root when data-theme changes and clears it after two frames', async () => {
    const root = document.createElement('div');
    const clock = frames();
    const dispose = guardThemeTransitions({
      root,
      requestFrame: clock.requestFrame,
      matchMedia: null,
    });

    root.dataset['theme'] = 'dark';
    await settleMutations();
    expect(root.hasAttribute(THEME_CHANGING_ATTRIBUTE)).toBe(true);

    clock.advance();
    expect(root.hasAttribute(THEME_CHANGING_ATTRIBUTE)).toBe(true);
    clock.advance();
    expect(root.hasAttribute(THEME_CHANGING_ATTRIBUTE)).toBe(false);
    dispose();
  });

  test('marks the root when the system color scheme changes', () => {
    const root = document.createElement('div');
    const clock = frames();
    const system = scheme();
    const dispose = guardThemeTransitions({
      root,
      requestFrame: clock.requestFrame,
      matchMedia: system.matchMedia,
    });

    system.change();
    expect(root.hasAttribute(THEME_CHANGING_ATTRIBUTE)).toBe(true);
    clock.advance();
    clock.advance();
    expect(root.hasAttribute(THEME_CHANGING_ATTRIBUTE)).toBe(false);
    dispose();
  });

  test('a second change keeps the mark until it has rendered twice', async () => {
    const root = document.createElement('div');
    const clock = frames();
    const dispose = guardThemeTransitions({
      root,
      requestFrame: clock.requestFrame,
      matchMedia: null,
    });

    root.dataset['theme'] = 'dark';
    await settleMutations();
    clock.advance();
    root.dataset['theme'] = 'light';
    await settleMutations();
    clock.advance();
    expect(root.hasAttribute(THEME_CHANGING_ATTRIBUTE)).toBe(true);
    clock.advance();
    expect(root.hasAttribute(THEME_CHANGING_ATTRIBUTE)).toBe(false);
    dispose();
  });

  test('ignores attributes other than data-theme', async () => {
    const root = document.createElement('div');
    const dispose = guardThemeTransitions({ root, requestFrame: () => {}, matchMedia: null });

    root.dataset['density'] = 'compact';
    await settleMutations();
    expect(root.hasAttribute(THEME_CHANGING_ATTRIBUTE)).toBe(false);
    dispose();
  });

  test('disposing stops watching and clears a pending mark', async () => {
    const root = document.createElement('div');
    const system = scheme();
    const dispose = guardThemeTransitions({
      root,
      requestFrame: () => {},
      matchMedia: system.matchMedia,
    });

    root.dataset['theme'] = 'dark';
    await settleMutations();
    dispose();
    expect(root.hasAttribute(THEME_CHANGING_ATTRIBUTE)).toBe(false);

    root.dataset['theme'] = 'light';
    await settleMutations();
    system.change();
    expect(root.hasAttribute(THEME_CHANGING_ATTRIBUTE)).toBe(false);
  });
});
