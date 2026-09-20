import type { HTMLAttributes } from 'svelte/elements';
export type FindBarProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /** Current query text. Bindable. */
  value?: string;
  /** Index of the active match within the host-provided results. Bindable. */
  activeIndex?: number;
  /** Number of matches for the current query, or `null` when the host has not searched yet. */
  matchCount?: number | null;
  /** Minimum query length before the host should search. */
  minQueryLength?: number;
  /** Debounce interval, in milliseconds, before `onQueryChange` fires. */
  debounceMs?: number;
  /** Called with the debounced query text as the user types. */
  onQueryChange?: (query: string) => void;
  /** Called when the user requests the previous match. */
  onPrevious?: () => void;
  /** Called when the user requests the next match. */
  onNext?: () => void;
  /** Called when the user dismisses the find bar. */
  onDismiss?: () => void;
  /** Accessible label for the find controls. */
  label?: string;
  /** Additional class merged with the component's root class. */
  class?: string;
};
