import type { HTMLAttributes } from 'svelte/elements';
export type FindBarProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /**
   * Current query text. Bindable. Defaults to `''`.
   * @default ''
   */
  value?: string;
  /**
   * Index of the active match within the host-provided results. Bindable,
   * but not input-only: the component resets it to `0` itself whenever the
   * user edits the query. Whenever `matchCount` is non-`null`, an effect
   * also clamps this value into `[0, matchCount - 1]` (normalizing to `0`
   * at `matchCount === 0`, where that range is otherwise empty)—and
   * because that effect reads `activeIndex` too, it clamps just as
   * immediately if a host assigns an out-of-range `activeIndex` on its
   * own, not only when `matchCount` itself changes—except a non-finite
   * assignment (`NaN`), which the clamp (`Math.min(Math.max(…))`) passes
   * through unchanged rather than normalizing. A parent binding this prop
   * should expect it to be overwritten in any of the finite-value cases,
   * not treat it as a preserved selection, and should not assign a
   * non-finite value itself. Defaults to `0`.
   * @default 0
   */
  activeIndex?: number;
  /**
   * Number of matches for the current query, or `null` when the host has
   * not searched yet. Bindable—the component resets it to `null` itself
   * whenever the user starts a new search, so bind it rather than mirror
   * `onQueryChange` manually to stay in sync with that reset. Defaults to
   * `null`.
   * @default null
   */
  matchCount?: number | null;
  /**
   * Minimum trimmed query length before the host should search—eligibility
   * is checked against `value.trim().length`, not `value.length`, so
   * whitespace-only or whitespace-padded input doesn't count toward it
   * (e.g. `' a '` stays ineligible at `minQueryLength={3}`). Defaults to
   * `3`.
   * @default 3
   */
  minQueryLength?: number;
  /**
   * Debounce interval, in milliseconds, before `onQueryChange` fires for
   * an eligible query. Does not apply to the synchronous `''` notification
   * `onQueryChange` sends when a previously eligible query shrinks below
   * `minQueryLength`—see that prop. Defaults to `250`.
   * @default 250
   */
  debounceMs?: number;
  /**
   * Called with the debounced query text once user typing (the `input`
   * event) reaches `minQueryLength`. Also called immediately with `''`,
   * bypassing the debounce, the moment a previously eligible query shrinks
   * below `minQueryLength`—handle the empty-string case as a synchronous
   * reset, not just the debounced value. Only that ineligible-transition
   * case is notified when triggered externally: assigning an eligible
   * `value` via `bind:value`, or lowering `minQueryLength` so the current
   * `value` becomes eligible, does not itself call this callback—a host
   * that restores or sets `value` programmatically must trigger its own
   * search rather than rely on this firing. Exception: if the user typed
   * an ineligible query and a debounce timer is already pending when
   * `minQueryLength` is lowered enough to make that in-flight query
   * eligible, the pending timer is not canceled or re-evaluated against
   * the new threshold at the moment it changes—it still fires against the
   * live `minQueryLength` when its debounce elapses, which can call this
   * with the query the user typed before the threshold changed.
   */
  onQueryChange?: (query: string) => void;
  /** Called when the user requests the previous match. */
  onPrevious?: () => void;
  /** Called when the user requests the next match. */
  onNext?: () => void;
  /** Called when the user dismisses the find bar. */
  onDismiss?: () => void;
  /**
   * Accessible label for the find controls. Defaults to `'Find'`.
   * @default 'Find'
   */
  label?: string;
  /** Additional class merged with the component's root class. */
  class?: string;
};
