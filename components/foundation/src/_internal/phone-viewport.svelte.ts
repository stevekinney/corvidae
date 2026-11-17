import { MediaQuery } from 'svelte/reactivity';

import { PHONE_VIEWPORT_BREAKPOINT } from './viewport-below.svelte.ts';

let phoneQuery: MediaQuery | undefined;
let phoneQuerySource: typeof window.matchMedia | undefined;

/**
 * Whether the viewport is phone-sized (narrower than 640px), shared by every reader.
 *
 * `useViewportBelow` makes one `MediaQuery` per call, which is right for one Dropdown but wasteful
 * for a list with hundreds of rows that each ask the same question. This reads one lazily created
 * query per `matchMedia`. On the server, and wherever `matchMedia` is missing, it reads `false`, so
 * server markup is always the wide form.
 */
export const phoneViewport: { readonly current: boolean } = {
  get current() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    // Keyed on the `matchMedia` in use, so a page that swaps it (a test double) is read afresh.
    if (phoneQuery === undefined || phoneQuerySource !== window.matchMedia) {
      phoneQuery = new MediaQuery(`(width < ${PHONE_VIEWPORT_BREAKPOINT})`, false);
      phoneQuerySource = window.matchMedia;
    }
    return phoneQuery.current;
  },
};
