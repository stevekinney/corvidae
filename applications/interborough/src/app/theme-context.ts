/**
 * The shell's theme, handed down to the components under it through Svelte's context, so a page
 * such as Settings reads and changes the one store the shell applies to the document.
 */
import { getContext, setContext } from 'svelte';

import type { ThemeStore } from './theme.svelte.ts';

const THEME_KEY = Symbol('theme-store');

/** Makes the shell's theme available to the components under it, such as the Settings page. */
export function provideTheme(store: ThemeStore): ThemeStore {
  setContext(THEME_KEY, store);
  return store;
}

/** The shell's theme, or `undefined` outside the shell. */
export function getTheme(): ThemeStore | undefined {
  return getContext<ThemeStore | undefined>(THEME_KEY);
}
