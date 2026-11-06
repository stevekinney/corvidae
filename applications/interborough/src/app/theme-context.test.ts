/**
 * The theme context (`theme-context.ts`): what the shell provides is what a page under it reads,
 * and a page outside the shell reads nothing.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import Harness from './theme-context.test-harness.svelte';
import ThemeReader from './theme-reader.test-harness.svelte';
import { ThemeStore } from './theme.svelte.ts';

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

describe('the theme context', () => {
  test('a component under the shell reads the store the shell provided', () => {
    const store = new ThemeStore(document.createElement('html'), memoryStorage());
    store.set('dark');

    const { getByTestId } = render(Harness, { props: { store } });

    expect(getByTestId('theme-mode').textContent).toBe('dark');
  });

  test('a component outside the shell reads no theme', () => {
    const { getByTestId } = render(ThemeReader);

    expect(getByTestId('theme-mode').textContent).toBe('none');
  });
});
