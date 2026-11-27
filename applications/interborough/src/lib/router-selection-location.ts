/**
 * Where a ListDetail keeps its open item: the address, through the router. ListDetail's own default
 * writes the address behind the router's back, which would leave the router reading a stale query
 * string, so a page that uses one hands it this instead.
 */
import type { ListDetailSelectionLocation } from '@lostgradient/cinder';

import { untrack } from 'svelte';

import { router } from './router.svelte.ts';

/** A page's selection in the address, and the address that opens the page with an item selected. */
export interface RouterSelectionLocation extends ListDetailSelectionLocation {
  /**
   * The address of the page with `key` selected under `parameter`, as the page's list reads it: a
   * link from another page builds its address here, so it opens the item the list would.
   */
  pathTo: (parameter: string, key: string) => string;
}

function withSelection(
  pathname: string,
  search: URLSearchParams,
  parameter: string,
  key: string | null,
): string {
  const next = new URLSearchParams(search);
  if (key === null) next.delete(parameter);
  else next.set(parameter, key);
  return next.size === 0 ? pathname : `${pathname}?${next.toString()}`;
}

/**
 * A selection that reads and writes one parameter of the current address, replacing the entry,
 * and only while the address is `pathname`.
 */
export function routerSelectionLocationFor(
  pathname: string,
  navigation: Pick<typeof router, 'pathname' | 'search' | 'navigate'> = router,
): RouterSelectionLocation {
  return {
    // Untracked: the list reads the address on every run, and following `router.search` would rerun
    // it on every navigation, writing its selection onto the next page.
    read: (parameter) => untrack(() => navigation.search.get(parameter)),
    write: (parameter, key) => {
      // The list outlives the navigation that unmounts it by a tick; it must not write onto the page left for.
      if (untrack(() => navigation.pathname) !== pathname) return;
      navigation.navigate(withSelection(navigation.pathname, navigation.search, parameter, key), {
        replace: true,
      });
    },
    pathTo: (parameter, key) => withSelection(pathname, new URLSearchParams(), parameter, key),
  };
}
