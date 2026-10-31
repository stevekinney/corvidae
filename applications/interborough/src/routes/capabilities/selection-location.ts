/**
 * Where a ListDetail on the Capabilities page keeps its open item: the address, through the router.
 * ListDetail's own default writes the address behind the router's back, which would leave the
 * router reading a stale query string, so the page hands it this instead.
 */
import type { ListDetailSelectionLocation } from '@lostgradient/cinder';

import { router } from '../../lib/router.svelte.ts';

/** A selection that reads and writes one parameter of the current address, replacing the entry. */
export const routerSelectionLocation: ListDetailSelectionLocation = {
  read: (parameter) => router.search.get(parameter),
  write: (parameter, key) => {
    const search = new URLSearchParams(router.search);
    if (key === null) search.delete(parameter);
    else search.set(parameter, key);
    const query = search.size === 0 ? '' : `?${search.toString()}`;
    router.navigate(`${router.pathname}${query}`, { replace: true });
  },
};
