import type { Snippet } from 'svelte';
import type { HTMLTimeAttributes } from 'svelte/elements';

/** Props for the RelativeTime component. */
export type RelativeTimeProps = Omit<HTMLTimeAttributes, 'class' | 'datetime'> & {
  /** Custom class merged with `.cinder-relative-time`. */
  class?: string;
  /** The moment to show: a `Date`, an ISO string or epoch milliseconds. Defaults to now. */
  date?: Date | string | number;
  /** Locale for the label. Defaults to the surrounding locale context, then the browser's language. */
  locale?: string | string[];
  /** IANA time zone the label is read in. Defaults to the viewer's zone. */
  timeZone?: string;
  /**
   * `relative` reads "4 min ago", "1 h ago", then "Yesterday, 4:12 PM". `absolute` always reads
   * the clock ("Today, 10:44 AM", "Sun Nov 1, 4:12 PM"). The tooltip carries the other reading.
   */
  format?: 'relative' | 'absolute';
  /**
   * Which days the label may name with a word. `true` says "Today", "Yesterday" and "Tomorrow";
   * `'today'` says only "Today" and names every other day ("Sun Nov 1, 4:12 PM"); `false` always
   * names the calendar day. Defaults to `'today'` for `format="absolute"` and `true` for `relative`.
   */
  dayWords?: boolean | 'today';
  /** Recalculate the label on an interval. Set false to disable ticking. */
  tick?: boolean;
  children?: Snippet;
};
