import type { HTMLAttributes } from 'svelte/elements';
export type FindBarProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /**
   * Current query text. Bindable. Defaults to `''`.
   * @default ''
   */
  value?: string;
  /**
   * Index of the active match within the host-provided results. Bindable.
   * Defaults to `0`.
   * @default 0
   */
  activeIndex?: number;
  /**
   * Number of matches for the current query, or `null` when the host has
   * not searched yet. Defaults to `null`.
   * @default null
   */
  matchCount?: number | null;
  /**
   * Minimum query length before the host should search. Defaults to `3`.
   * @default 3
   */
  minQueryLength?: number;
  /**
   * Debounce interval, in milliseconds, before `onQueryChange` fires.
   * Defaults to `250`.
   * @default 250
   */
  debounceMs?: number;
  /** Called with the debounced query text as the user types. */
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
