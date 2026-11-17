import type { HTMLAttributes } from 'svelte/elements';

/** Colour of the filled segments: `neutral` (the default) or `accent`. */
export type AttemptsIndicatorTone = 'neutral' | 'accent';

/** Width of the bar: `inline` is a compact 56px bar for a line of text, `block` fills its container. */
export type AttemptsIndicatorLayout = 'inline' | 'block';

/** Props for the AttemptsIndicator component. */
export type AttemptsIndicatorProps = Omit<HTMLAttributes<HTMLSpanElement>, 'class' | 'role'> & {
  /** Attempts made so far. Filled segments are counted from the start; the value is clamped to `allowed`. */
  made: number;
  /**
   * Attempts allowed, which is the number of segments: one per allowed attempt. Above 100 the bar
   * still draws 100 segments and fills them in proportion.
   */
  allowed: number;
  /**
   * Colour of the filled segments. `neutral` is the default, because the word beside the bar
   * carries the outcome; `accent` suits a bar that is a progress cue in its own right, such as
   * reconnection attempts.
   */
  tone?: AttemptsIndicatorTone;
  /** Width of the bar. Default `inline`. */
  layout?: AttemptsIndicatorLayout;
  /** Accessible name. Defaults to `${made} of ${allowed} attempts`. */
  label?: string;
  /** Custom class merged with `.cinder-attempts-indicator`. */
  class?: string;
};
