import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Props for the Inspector component. */
export type InspectorProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'children'> & {
  /** A header drawn above the group, outside its surface, in small muted text. It also names the group. */
  header?: string;
  /** The rows: InspectorRow elements. */
  children?: Snippet;
  /** Custom class merged with `.cinder-inspector`. */
  class?: string;
};
