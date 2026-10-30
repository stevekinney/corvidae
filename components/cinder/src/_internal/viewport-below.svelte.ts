import { MediaQuery } from 'svelte/reactivity';

/**
 * Viewport width below which a responsive building block takes its phone form:
 * Table stacks its rows, and Popover, Dropdown, Combobox and MultiSelect open
 * as bottom sheets. Phones are narrower than 640px, tablets run from 640px to
 * 1023px, and desktops start at 1024px.
 */
export const PHONE_VIEWPORT_BREAKPOINT = '640px';

const SIMPLE_CSS_LENGTH =
  /^(?:0|(?:\d+|\d*\.\d+)(?:px|rem|em|ch|vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|cqw|cqh|cqi|cqb|cqmin|cqmax))$/;

/** Whether `value` is a single unitless zero or a positive number with a CSS length unit. */
export function isSimpleCssLength(value: string): boolean {
  return SIMPLE_CSS_LENGTH.test(value.trim());
}

/**
 * Validates a `…Below` breakpoint prop. `false` turns the phone form off and
 * yields `undefined`; anything else must be a simple CSS length, because it is
 * interpolated into a media query and an attribute selector.
 */
export function readViewportBreakpoint(
  value: string | false,
  component: string,
  property: string,
): string | undefined {
  if (value === false) return undefined;
  if (typeof value !== 'string' || !isSimpleCssLength(value)) {
    throw new Error(`${component} ${property} must be a CSS length such as "640px", or false.`);
  }
  return value.trim();
}

/** Reactive answer to whether the viewport is narrower than a breakpoint. */
export type ViewportBelow = {
  /** `true` while the viewport is narrower than the breakpoint; always `false` without one. */
  readonly current: boolean;
};

/**
 * Watches `(width < breakpoint)` through Svelte's `MediaQuery`, re-creating the
 * query when the breakpoint changes. With no breakpoint, or on the server, it
 * reads `false`, so server markup is always the wide form.
 */
export function useViewportBelow(getBreakpoint: () => string | undefined): ViewportBelow {
  const query = $derived.by(() => {
    const breakpoint = getBreakpoint();
    if (breakpoint === undefined) return undefined;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    return new MediaQuery(`(width < ${breakpoint})`, false);
  });

  return {
    get current() {
      return query?.current ?? false;
    },
  };
}
