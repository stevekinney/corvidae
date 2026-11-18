import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
import type { StatusDotStatus } from '../status-dot/status-dot.types.ts';

/** Props for the Spotlight component. */
export type SpotlightProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /** The one focal value of the screen, such as "Ends in 45 min" or "2 need you". It is set at display size in the default text colour, never the accent. */
  value: string;
  /** Liveness of the value, drawn as a status dot with its word above the value. Set `statusLabel` to word it. Omit both for a value with no liveness. */
  status?: StatusDotStatus;
  /** The word beside the status dot, such as "Live" or "Paused". Left unset, a `status` draws the word its tone implies. */
  statusLabel?: string;
  /** Staleness or a caution, such as "Updated 12 min ago", drawn in warning text directly under the value. */
  caveat?: Snippet;
  /**
   * The value's action, such as a `Link` in its `more` form to the page that holds the rest
   * ("Open Reviews"), when the value is the title of what follows it. It sits at the end of the
   * value's first line, centred on it, as a section's action sits beside its heading, and drops to
   * the next line only when the two do not fit side by side.
   */
  action?: Snippet;
  /** Custom class merged with `.cinder-spotlight`. */
  class?: string;
};
