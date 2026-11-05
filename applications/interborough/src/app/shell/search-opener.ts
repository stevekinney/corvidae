/**
 * How a page opens the search palette. The shell owns whether the palette is open, so it provides
 * a function that opens it, and a page that wants to offer "Search everything" (the not-found
 * page) asks for it here instead of reaching into the shell.
 */
import { getContext, setContext } from 'svelte';

/** Opens the search palette. */
export type SearchOpener = () => void;

const SEARCH_OPENER_KEY = Symbol('search-opener');

/** Makes the function that opens the search palette available to the pages under the shell. */
export function provideSearchOpener(open: SearchOpener): SearchOpener {
  setContext(SEARCH_OPENER_KEY, open);
  return open;
}

/** The function that opens the search palette, or `undefined` under a page mounted without the shell. */
export function getSearchOpener(): SearchOpener | undefined {
  return getContext<SearchOpener | undefined>(SEARCH_OPENER_KEY);
}
