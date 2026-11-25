import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';

/** Props for the shared compact trigger that opens a related region. */
export type DisclosureTriggerProps = Omit<
  HTMLButtonAttributes,
  'class' | 'children' | 'type' | 'aria-expanded' | 'aria-controls'
> & {
  /** Whether the controlled region is open. */
  open: boolean;
  /** The controlled region id. */
  controls?: string | undefined;
  /** Visible trigger contents. */
  children: Snippet;
  /** Additional trigger classes. */
  class?: string | undefined;
};
