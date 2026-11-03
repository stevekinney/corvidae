/**
 * Internal StaleRegion context, factored out of `stale-region.svelte` so the controls that change
 * something (Button, Toggle, Checkbox, Select, DropdownTrigger) can read it without importing a
 * `.svelte` module path.
 *
 * A `<StaleRegion>` publishes whether the data under it is old. A control that opts in with its
 * `mutating` prop goes inert while the region is stale: `aria-disabled`, still focusable, ignoring
 * the press, and described by the region's reason. A control that does not opt in (a link, a
 * filter, Retry now, a tab) is untouched, and so is a control outside any region.
 */

import { createContext } from 'svelte';

import { optionalContext } from './optional-context.ts';

/**
 * The words that explain an inert control when the page gives none: "Off until it’s back". The
 * apostrophe is the typographic one the banner presets use.
 */
export const STALE_REGION_DEFAULT_REASON = 'Off until it’s back';

/**
 * Context published by `<StaleRegion>` for the controls under it. Both fields are getters so reads
 * stay reactive inside a `$derived`; destructuring would freeze them.
 */
export type StaleRegionContextValue = {
  /** Whether the data under the region is old, so a control that changes something is inert. */
  readonly stale: boolean;
  /**
   * The id of the element whose text is the reason a control is off, which an inert control lists
   * in `aria-describedby`. `undefined` while the region is not stale.
   */
  readonly reasonId: string | undefined;
};

const [getStaleRegionContextStrict, setStaleRegionContextRaw] =
  createContext<StaleRegionContextValue>();

/** Publish the StaleRegion context for descendant controls. */
export function setStaleRegionContext(context: StaleRegionContextValue): void {
  setStaleRegionContextRaw(context);
}

/**
 * Read the nearest enclosing `<StaleRegion>` context. Returns `undefined` when there is no
 * `<StaleRegion>` ancestor, which is a supported state: a standalone control renders normally.
 */
export const getStaleRegionContext: () => StaleRegionContextValue | undefined = optionalContext(
  getStaleRegionContextStrict,
);

/** Whether a control that opted in with `mutating` is inert under this region right now. */
export function isStaleInert(
  context: StaleRegionContextValue | undefined,
  mutating: boolean | undefined,
): boolean {
  return mutating === true && context?.stale === true;
}

/**
 * Join description ids into one `aria-describedby` value, dropping blanks and repeats.
 * Returns `undefined` when nothing is left so the attribute is omitted.
 */
export function mergeDescribedBy(...ids: (string | null | undefined)[]): string | undefined {
  const tokens = ids.flatMap((id) => (id ? id.split(/\s+/) : [])).filter(Boolean);
  const unique = [...new Set(tokens)];
  return unique.length > 0 ? unique.join(' ') : undefined;
}
