/**
 * Where a ListDetail keeps its open item: the address, through the router. ListDetail's own default
 * writes the address behind the router's back, which would leave the router reading a stale query
 * string, so a page hands it the location this makes for its path instead.
 */
import type { ListDetailSelectionLocation } from '@lostgradient/cinder';

import { untrack } from 'svelte';

import { router } from './router.svelte.ts';

/**
 * A selection that reads and writes one parameter of the current address, replacing the entry. It
 * writes only while the router is on `path`, so a list that outlives the navigation that unmounts
 * it never writes onto the page left for.
 */
export function routerSelectionLocationFor(path: string): ListDetailSelectionLocation {
  return {
    // Untracked: the list reads the address on every run, and following `router.search` would rerun
    // it on every navigation, writing its selection onto the next page.
    read: (parameter) => untrack(() => router.search.get(parameter)),
    write: (parameter, key) => {
      if (untrack(() => router.pathname) !== path) return;
      const search = new URLSearchParams(router.search);
      if (key === null) search.delete(parameter);
      else search.set(parameter, key);
      const query = search.size === 0 ? '' : `?${search.toString()}`;
      router.navigate(`${router.pathname}${query}`, { replace: true });
    },
  };
}
