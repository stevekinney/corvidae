import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Props for the StaleRegion component. */
export type StaleRegionProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'children'> & {
  /**
   * Whether the data under the region is old. While it is, every control inside that opted in with
   * `mutating` goes inert; when it turns false they return by themselves. Defaults to `true`, so a
   * page mounts the region only while it is stale or binds this to its connection state.
   * @default true
   */
  stale?: boolean;
  /**
   * The reason an inert control is off, read as its description. Pages word it for what they
   * show: "Off until storage answers", "Approving is off until Interborough is reachable".
   * @default "Off until it’s back"
   */
  reason?: string;
  /**
   * The id of an element that already says why, such as the page's banner. Inert controls list it
   * in `aria-describedby` instead of the region's own reason, which is then not rendered.
   */
  describedBy?: string | undefined;
  /** Custom class merged with `.cinder-stale-region`. */
  class?: string;
  /** The page or section whose data may be old. */
  children: Snippet;
};
