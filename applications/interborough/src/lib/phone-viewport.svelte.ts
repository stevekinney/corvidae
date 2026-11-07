/**
 * Whether the viewport is phone-sized (narrower than 640px), the width below which Cinder's lists
 * move a row's status to line two and collapse its trailing actions. A page whose rows say
 * something different on a phone (a schedule's third line, its next run's wording) reads it here,
 * so the page and the component agree on the width.
 */
import { MediaQuery } from 'svelte/reactivity';

/** The width, in pixels, below which the viewport is a phone. */
export const PHONE_BREAKPOINT = 640;

let query: MediaQuery | undefined;
let querySource: typeof window.matchMedia | undefined;

/**
 * A reactive reading of whether the viewport is a phone. The query is made on first read and again
 * if the page swaps `matchMedia` (a test double); where `matchMedia` is missing it reads `false`.
 */
export const phoneViewport: { readonly current: boolean } = {
  get current() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    if (query === undefined || querySource !== window.matchMedia) {
      query = new MediaQuery(`(width < ${String(PHONE_BREAKPOINT)}px)`, false);
      querySource = window.matchMedia;
    }
    return query.current;
  },
};
