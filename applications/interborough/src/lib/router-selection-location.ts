/**
 * Where a ListDetail keeps its open item: the address, through the router. ListDetail's own default
 * writes the address behind the router's back, which would leave the router reading a stale query
 * string, so a page that uses one hands it this instead.
 */
import type { ListDetailSelectionLocation } from '@lostgradient/cinder';

import { untrack } from 'svelte';

import { router } from './router.svelte.ts';

/**
 * A selection that reads and writes one parameter of the current address, replacing the entry,
 * and only while the address is `pathname`.
 */
export function routerSelectionLocationFor(pathname: string): ListDetailSelectionLocation {
  return {
    // Untracked: the list reads the address on every run, and following `router.search` would rerun
    // it on every navigation, writing its selection onto the next page.
    read: (parameter) => untrack(() => router.search.get(parameter)),
    write: (parameter, key) => {
      // The list outlives the navigation that unmounts it by a tick; it must not write onto the page left for.
      if (untrack(() => router.pathname) !== pathname) return;
      const search = new URLSearchParams(router.search);
      if (key === null) search.delete(parameter);
      else search.set(parameter, key);
      const query = search.size === 0 ? '' : `?${search.toString()}`;
      router.navigate(`${router.pathname}${query}`, { replace: true });
    },
  };
}
